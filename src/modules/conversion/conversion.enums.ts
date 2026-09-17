/**
 * The persisted vocabulary of the conversion feature.
 *
 * `ConversionFormat` is the **only** place the format set is enumerated for
 * persistence. The set of supported *directions* is never written down — it is
 * derived from the registered handlers at request time (FR-030), so adding a
 * format means adding a handler and a value here, and nothing else.
 */
export enum ConversionFormat {
  CSV = 'csv',
  JSON = 'json',
  XML = 'xml',
  YAML = 'yaml',
}

/**
 * The image formats, added by feature 011.
 *
 * A separate enum rather than more members of {@link ConversionFormat}: the
 * text handlers key exhaustive `Record<ConversionFormat, …>` maps off that
 * one, and widening it would both break their totality and let a *text*
 * direction be computed for `png`. The two sets meet only where they must —
 * in the two persisted columns, as {@link RecordedFormat}.
 */
export enum ImageFormat {
  PNG = 'png',
  JPEG = 'jpeg',
  SVG = 'svg',
}

/**
 * What the persisted format columns accept: either family.
 *
 * Both features write it; neither owns it. The value itself says which family
 * an attempt belongs to, which is why neither table carries a discriminator
 * column — that would be derived data able to disagree with the data it is
 * derived from.
 */
export type RecordedFormat = ConversionFormat | ImageFormat;

/** The runtime companion to the union, for `enum:` column metadata. */
export const RecordedFormat = { ...ConversionFormat, ...ImageFormat };

export enum ConversionOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

/**
 * Why an attempt failed, at the granularity history reports on. The HTTP status
 * each category maps to is fixed by the contract and lives in
 * `conversion.exception.ts`.
 */
export enum ConversionErrorCategory {
  /** 400: missing or empty file, bad `targetFormat`, same source and target. */
  BAD_REQUEST = 'bad_request',
  /** 415: the source matched no format, or the target is not one we support. */
  UNSUPPORTED_MEDIA_TYPE = 'unsupported_media_type',
  /** 413: over the detected source format's configured limit. */
  PAYLOAD_TOO_LARGE = 'payload_too_large',
  /** 400: malformed input, invalid UTF-8, or a DOCTYPE declaration. */
  PARSE_ERROR = 'parse_error',
  /** 400: depth, node count, or CSV column count over the limit. */
  STRUCTURE_LIMIT_EXCEEDED = 'structure_limit_exceeded',
  /** 400: the conversion exceeded its time budget. */
  TIMEOUT = 'timeout',
  /** 500: an unexpected failure. */
  INTERNAL_ERROR = 'internal_error',
}

/**
 * What actually happened to the caller's retention request — reported both in
 * history and in the `X-Conversion-Retention` response header (FR-028).
 *
 * `FAILED` says the conversion succeeded and only keeping a copy did not; the
 * caller still receives a valid file.
 */
export enum ConversionRetentionOutcome {
  NOT_REQUESTED = 'not_requested',
  STORED = 'stored',
  FAILED = 'failed',
}
