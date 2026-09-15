import { Inject, Injectable } from '@nestjs/common';

import { ConversionErrorCode } from './conversion.constants';
import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { CONVERSION_LIMITS, FORMAT_HANDLERS } from './formats/format-handler';
import type { ConversionLimits, FormatHandler } from './formats/format-handler';

export interface ConversionDirection {
  source: ConversionFormat;
  target: ConversionFormat;
}

export interface FormatDescriptor {
  source: ConversionFormat;
  mediaType: string;
  extension: string;
  maxInputBytes: number;
  targets: ConversionFormat[];
}

/**
 * What the service can actually do, derived from what is registered.
 *
 * Nothing here enumerates directions. They are every ordered pair of distinct
 * registered formats, computed on demand — so four handlers give the twelve
 * directions the spec requires, and a fifth handler gives twenty with no edit
 * to this file, the controller, or the discovery DTO (FR-029, FR-030). That is
 * also what keeps `GET /api/convert/formats` honest: the list it returns and
 * the set `POST /api/convert` accepts are the same computation (FR-012).
 */
@Injectable()
export class FormatRegistryService {
  private readonly byFormat: Map<ConversionFormat, FormatHandler>;

  constructor(
    @Inject(FORMAT_HANDLERS) private readonly handlers: FormatHandler[],
    @Inject(CONVERSION_LIMITS) private readonly limits: ConversionLimits,
  ) {
    this.byFormat = new Map(
      handlers.map((handler) => [handler.format, handler]),
    );
  }

  /** Registered formats, alphabetically — the contract's stable order. */
  formats(): ConversionFormat[] {
    return [...this.byFormat.keys()].sort();
  }

  handlerFor(format: ConversionFormat): FormatHandler | undefined {
    return this.byFormat.get(format);
  }

  /** The handler for `format`, or the 415 the contract documents. */
  requireHandler(
    format: ConversionFormat,
    code:
      | typeof ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT
      | typeof ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
  ): FormatHandler {
    const handler = this.byFormat.get(format);

    if (!handler) {
      throw new ConversionException(code);
    }

    return handler;
  }

  /** Handlers in the order the detector should try them. */
  detectionOrder(): FormatHandler[] {
    return [...this.handlers].sort(
      (a, b) => a.detectionPriority - b.detectionPriority,
    );
  }

  /** Every ordered pair of distinct registered formats. */
  directions(): ConversionDirection[] {
    const formats = this.formats();

    return formats.flatMap((source) =>
      formats
        .filter((target) => target !== source)
        .map((target) => ({ source, target })),
    );
  }

  supports(source: ConversionFormat, target: ConversionFormat): boolean {
    return (
      source !== target &&
      this.byFormat.has(source) &&
      this.byFormat.has(target)
    );
  }

  /** The discovery response, built from the same source of truth. */
  describe(): FormatDescriptor[] {
    return this.formats().map((source) => {
      const handler = this.byFormat.get(source)!;

      return {
        source,
        mediaType: handler.mediaType,
        extension: handler.extension,
        maxInputBytes: this.maxInputBytesFor(source),
        targets: this.formats().filter((target) => target !== source),
      };
    });
  }

  /**
   * The configured input limit for one source format.
   *
   * A registered format with no configured limit falls back to the smallest
   * one that *is* configured. A newly registered format is then conservative
   * until an administrator says otherwise, rather than unbounded — which is the
   * safe direction for the "add a fifth format without touching anything else"
   * story to fail in.
   */
  maxInputBytesFor(format: ConversionFormat): number {
    return this.limits.maxInputBytes[format] ?? this.smallestConfiguredLimit();
  }

  /**
   * The multipart ceiling for a conversion request: the largest limit any
   * registered format could claim. The detected format's own budget is applied
   * afterwards and is never looser than this.
   */
  maxConfiguredInputBytes(): number {
    return Math.max(
      ...this.formats().map((format) => this.maxInputBytesFor(format)),
    );
  }

  private smallestConfiguredLimit(): number {
    const configured = Object.values(this.limits.maxInputBytes).filter(
      (value): value is number => typeof value === 'number',
    );

    return configured.length > 0 ? Math.min(...configured) : 0;
  }
}
