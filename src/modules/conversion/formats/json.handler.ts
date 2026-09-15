import { Injectable } from '@nestjs/common';

import {
  ConversionErrorCode,
  FORMAT_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
} from '../conversion.constants';
import { ConversionFormat } from '../conversion.enums';
import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import type { FormatHandler } from './format-handler';

/**
 * `JSON.parse` reports a character offset in recent V8 ("position 41"). The
 * offset is useful and safe — it is a position, not the text at it — so it is
 * translated into a line and column and everything else about the message is
 * discarded, because V8 also quotes the offending token (FR-023, SC-005).
 */
function locate(
  input: string,
  error: unknown,
): { line: number; column: number } {
  const message = error instanceof Error ? error.message : '';
  const match = /position (\d+)/.exec(message);

  if (!match) {
    return { line: 1, column: 1 };
  }

  const offset = Math.min(Number(match[1]), input.length);
  const consumed = input.slice(0, offset);
  const lines = consumed.split('\n');

  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * JSON is the hub format's own wire form, so both directions are the identity.
 *
 * The native parser is used deliberately: it *is* RFC 8259, and no third-party
 * parser could be more correct — only more surface.
 */
@Injectable()
export class JsonHandler implements FormatHandler {
  readonly format = ConversionFormat.JSON;
  readonly mediaType = FORMAT_MEDIA_TYPES[ConversionFormat.JSON];
  readonly extension = FORMAT_EXTENSIONS[ConversionFormat.JSON];
  readonly detectionPriority = 20;
  readonly sniffIsConclusive = false;

  sniff(prefix: string): boolean {
    const first = prefix.trimStart()[0];
    return first === '{' || first === '[';
  }

  // `async` so a parse failure always arrives as a rejection: the contract
  // promises a Promise, and a synchronous throw from it would slip past every
  // caller that handles errors with `.catch`.
  async read(input: string): Promise<DocumentNode> {
    try {
      // Duplicate keys resolve last-wins, as JSON.parse does — the documented
      // behaviour, inherited rather than re-implemented.
      return await Promise.resolve(JSON.parse(input) as DocumentNode);
    } catch (error) {
      throw new ConversionException(
        ConversionErrorCode.PARSE_ERROR,
        locate(input, error),
      );
    }
  }

  async write(node: DocumentNode): Promise<Buffer> {
    try {
      return Buffer.from(`${JSON.stringify(node, null, 2)}\n`, 'utf8');
    } catch {
      // A serializer failure is unexpected, but its message would quote the
      // value it choked on — which is the user's data. It is reported as a
      // fixed code like every other failure (FR-023, SC-005).
      throw new ConversionException(ConversionErrorCode.INTERNAL_ERROR);
    }
  }
}
