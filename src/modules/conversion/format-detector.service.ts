import { Injectable } from '@nestjs/common';

import { ConversionErrorCode, EXTENSION_HINTS } from './conversion.constants';
import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { FormatRegistryService } from './format-registry.service';
import type { ConversionLimits, FormatHandler } from './formats/format-handler';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface DecodedUpload {
  /** The upload as text, BOM consumed. */
  text: string;
  /** The bounded prefix detection works from. */
  prefix: string;
}

/**
 * Decides what was uploaded.
 *
 * Content decides; the file-name extension is only a tie-breaker (FR-003). The
 * order is fixed and documented because that is what makes "unsupported" and
 * "malformed" distinguishable: a format whose `sniff` is conclusive owns the
 * document outright, and every other format has to prove itself by parsing.
 */
@Injectable()
export class FormatDetectorService {
  constructor(private readonly registry: FormatRegistryService) {}

  /**
   * Decode the detection prefix for sniffing only.
   *
   * Deliberately **not** validated: a 64 KiB prefix can stop in the middle of a
   * multi-byte character, and refusing that as invalid UTF-8 would reject
   * perfectly good files for being large. Validation belongs to {@link decode},
   * which sees the whole upload.
   */
  decodePrefix(prefix: Buffer): string {
    const body = prefix.subarray(0, 3).equals(UTF8_BOM)
      ? prefix.subarray(3)
      : prefix;

    return body.toString('utf8');
  }

  /**
   * Which formats are worth considering, from the prefix alone.
   *
   * This runs before the upload has been fully read, and its answer sets the
   * byte budget: the limit applied is the detected format's (FR-016), and until
   * the format is known the most any candidate allows is the most that may be
   * read. An empty result is a refusal on the spot — nothing further is read
   * from a document no format recognises.
   */
  candidates(prefix: string, fileName?: string): FormatHandler[] {
    const named = this.hintedFormat(fileName);

    return this.registry
      .detectionOrder()
      .filter((handler) => handler.sniff(prefix, handler.format === named));
  }

  /**
   * Validate the encoding and strip a BOM, once, at the boundary.
   *
   * Handlers receive text rather than bytes, so the UTF-8 and BOM rules are
   * applied in one place instead of four (FR-010, FR-020).
   */
  decode(input: Buffer): DecodedUpload {
    if (input.length === 0) {
      throw new ConversionException(ConversionErrorCode.EMPTY_FILE);
    }

    const body = input.subarray(0, 3).equals(UTF8_BOM)
      ? input.subarray(3)
      : input;

    const text = body.toString('utf8');

    // `toString('utf8')` replaces every invalid sequence with U+FFFD rather
    // than failing, so the round trip is what actually detects the problem.
    if (!Buffer.from(text, 'utf8').equals(body)) {
      throw new ConversionException(ConversionErrorCode.INVALID_ENCODING);
    }

    return { text, prefix: text };
  }

  /**
   * The detected source format, or the documented 415.
   *
   * `fileName` supplies the extension tie-breaker. It never reorders the scan;
   * it only tells a handler that the name pointed at it, which a handler may use
   * to widen what it will consider. Content therefore still decides — a `.csv`
   * file holding JSON is detected as JSON — and the extension settles only the
   * cases where content genuinely cannot (FR-003).
   */
  async detect(
    decoded: DecodedUpload,
    limits: ConversionLimits,
    fileName?: string,
  ): Promise<ConversionFormat> {
    const named = this.hintedFormat(fileName);
    let namedFailure: ConversionException | undefined;

    for (const handler of this.registry.detectionOrder()) {
      const isNamed = handler.format === named;

      if (!handler.sniff(decoded.prefix, isNamed)) {
        continue;
      }

      if (handler.sniffIsConclusive) {
        return handler.format;
      }

      // The confirming parse runs against the whole (already size-capped)
      // input, so no format is accepted on a prefix the full document
      // contradicts.
      try {
        await handler.read(decoded.text, { limits });
        return handler.format;
      } catch (error) {
        // Keep why the format the file name claimed rejected it.
        if (isNamed && error instanceof ConversionException) {
          namedFailure = error;
        }
        continue;
      }
    }

    // Nothing parsed, but the file name claimed a format and that format's own
    // parser is the one that rejected it — so the document is malformed, not
    // unidentifiable, and saying "could not determine the format" about a
    // `.yaml` file would be both unhelpful and untrue. A file whose name
    // claims nothing still gets the honest 415.
    if (namedFailure) {
      throw namedFailure;
    }

    throw new ConversionException(
      ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
    );
  }

  private hintedFormat(fileName?: string): ConversionFormat | undefined {
    if (!fileName) {
      return undefined;
    }

    const dot = fileName.lastIndexOf('.');

    if (dot < 0) {
      return undefined;
    }

    return EXTENSION_HINTS[fileName.slice(dot + 1).toLowerCase()];
  }
}
