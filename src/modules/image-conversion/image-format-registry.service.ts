import { Inject, Injectable } from '@nestjs/common';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import {
  IMAGE_CONVERSION_LIMITS,
  IMAGE_FORMAT_HANDLERS,
} from './formats/image-format-handler';
import type {
  ImageConversionLimits,
  ImageFormatHandler,
} from './formats/image-format-handler';

export interface ImageConversionDirection {
  source: ImageFormat;
  target: ImageFormat;
}

export interface ImageFormatDescriptor {
  source: ImageFormat;
  mediaType: string;
  extension: string;
  maxInputBytes: number;
  targets: ImageFormat[];
}

/** A handler that can be a conversion source. */
type Decoder = ImageFormatHandler & {
  decode: NonNullable<ImageFormatHandler['decode']>;
};

/** A handler that can be a conversion target. */
type Encoder = ImageFormatHandler & {
  encode: NonNullable<ImageFormatHandler['encode']>;
};

/**
 * What the service can actually do, derived from what each handler can do.
 *
 * Nothing here enumerates directions. They are *{handlers with `decode`} ×
 * {handlers with `encode`}*, minus self-pairs, computed on demand — which
 * yields exactly the four directions FR-002 requires from three handlers, and
 * would yield the wider set from a fourth with no edit to this file, the
 * controller, or the discovery DTO (FR-033, FR-034, SC-014).
 *
 * It is also what keeps `GET /api/images/convert/formats` honest: the list it
 * returns and the set `POST /api/images/convert` accepts are the same
 * computation, so they cannot drift (FR-013, SC-010).
 */
@Injectable()
export class ImageFormatRegistryService {
  private readonly byFormat: Map<ImageFormat, ImageFormatHandler>;

  constructor(
    @Inject(IMAGE_FORMAT_HANDLERS)
    private readonly handlers: ImageFormatHandler[],
    @Inject(IMAGE_CONVERSION_LIMITS)
    private readonly limits: ImageConversionLimits,
  ) {
    this.byFormat = new Map(
      handlers.map((handler) => [handler.format, handler]),
    );
  }

  /** Registered formats, alphabetically — the contract's stable order. */
  formats(): ImageFormat[] {
    return [...this.byFormat.keys()].sort();
  }

  /** Formats that can be a conversion source, alphabetically. */
  sources(): ImageFormat[] {
    return this.decoders()
      .map((handler) => handler.format)
      .sort();
  }

  /**
   * Formats that can be a conversion target, alphabetically.
   *
   * `svg` never appears, and is not filtered out: the SVG handler implements
   * no `encode`, so the pair cannot be computed in the first place.
   */
  targets(): ImageFormat[] {
    return this.encoders()
      .map((handler) => handler.format)
      .sort();
  }

  handlerFor(format: ImageFormat): ImageFormatHandler | undefined {
    return this.byFormat.get(format);
  }

  /** The handler that can decode `format`, or the refusal the contract names. */
  requireDecoder(format: ImageFormat): Decoder {
    const handler = this.byFormat.get(format);

    if (!handler?.decode) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
      );
    }

    return handler as Decoder;
  }

  /**
   * The handler that can encode `format`.
   *
   * A registered format with no `encode` is not "missing" — it is a format
   * this service will never produce, which for a raster source naming `svg` is
   * the distinct `image_vectorisation_unsupported` refusal (FR-003, US5.4).
   */
  requireEncoder(format: ImageFormat): Encoder {
    const handler = this.byFormat.get(format);

    if (!handler) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    if (!handler.encode) {
      throw new ConversionException(
        ConversionErrorCode.IMAGE_VECTORISATION_UNSUPPORTED,
      );
    }

    return handler as Encoder;
  }

  /** Handlers in the order the detector should try them. */
  detectionOrder(): ImageFormatHandler[] {
    return [...this.handlers].sort(
      (a, b) => a.detectionPriority - b.detectionPriority,
    );
  }

  /** Every decodable → encodable pair of distinct formats. */
  directions(): ImageConversionDirection[] {
    return this.sources().flatMap((source) =>
      this.targets()
        .filter((target) => target !== source)
        .map((target) => ({ source, target })),
    );
  }

  supports(source: ImageFormat, target: ImageFormat): boolean {
    return (
      source !== target &&
      typeof this.byFormat.get(source)?.decode === 'function' &&
      typeof this.byFormat.get(target)?.encode === 'function'
    );
  }

  /** The discovery response, built from the same source of truth. */
  describe(): ImageFormatDescriptor[] {
    return this.sources().map((source) => {
      const handler = this.byFormat.get(source)!;

      return {
        source,
        mediaType: handler.mediaType,
        extension: handler.extension,
        maxInputBytes: this.maxInputBytesFor(source),
        targets: this.targets().filter((target) => target !== source),
      };
    });
  }

  /**
   * The configured input limit for one source format.
   *
   * A registered format with no configured limit falls back to the smallest
   * one that *is* configured, so a newly registered format is conservative
   * until an administrator says otherwise rather than unbounded — the safe
   * direction for "add a format without touching anything else" to fail in.
   */
  maxInputBytesFor(format: ImageFormat): number {
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

  // A `typeof` check rather than a truthiness one: it asks whether the
  // capability exists without detaching the method from its handler.
  private decoders(): Decoder[] {
    return this.handlers.filter(
      (handler): handler is Decoder => typeof handler.decode === 'function',
    );
  }

  private encoders(): Encoder[] {
    return this.handlers.filter(
      (handler): handler is Encoder => typeof handler.encode === 'function',
    );
  }

  private smallestConfiguredLimit(): number {
    const configured = Object.values(this.limits.maxInputBytes).filter(
      (value): value is number => typeof value === 'number',
    );

    return configured.length > 0 ? Math.min(...configured) : 0;
  }
}
