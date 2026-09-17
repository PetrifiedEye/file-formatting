import { ConversionFormat } from './conversion.enums';

/**
 * Every error this feature can report, as a fixed code.
 *
 * These exist so that a library parser message never has to. `csv-parse`,
 * `yaml`, and `JSON.parse` all quote the offending input in their messages, and
 * that input is the user's file — so each handler maps its library's failure
 * onto one of these codes plus, where useful, a line and column (FR-023,
 * SC-005).
 */
export const ConversionErrorCode = {
  MISSING_FILE: 'missing_file',
  EMPTY_FILE: 'empty_file',
  UNEXPECTED_PART: 'unexpected_part',
  MISSING_TARGET_FORMAT: 'missing_target_format',
  SAME_FORMAT: 'same_format',
  INVALID_STORE_FLAG: 'invalid_store_flag',
  INVALID_ENCODING: 'invalid_encoding',
  PARSE_ERROR: 'parse_error',
  CSV_DUPLICATE_HEADER: 'csv_duplicate_header',
  XML_DOCTYPE_FORBIDDEN: 'xml_doctype_forbidden',
  XML_NAME_COLLISION: 'xml_name_collision',
  STRUCTURE_LIMIT_EXCEEDED: 'structure_limit_exceeded',
  CSV_TOO_MANY_COLUMNS: 'csv_too_many_columns',
  OUTPUT_TOO_LARGE: 'output_too_large',
  TIMEOUT: 'timeout',
  INPUT_TOO_LARGE: 'input_too_large',
  UNSUPPORTED_SOURCE_FORMAT: 'unsupported_source_format',
  UNSUPPORTED_TARGET_FORMAT: 'unsupported_target_format',
  UNAUTHENTICATED: 'unauthenticated',
  INTERNAL_ERROR: 'internal_error',

  // Image conversion (feature 011). Added here rather than to a second table
  // because `conversion_records.error_category` is one column: both features
  // have to speak one vocabulary.
  IMAGE_INVALID: 'image_invalid',
  IMAGE_PIXEL_BUDGET_EXCEEDED: 'image_pixel_budget_exceeded',
  IMAGE_DIMENSIONS_EXCEEDED: 'image_dimensions_exceeded',
  SVG_NO_INTRINSIC_SIZE: 'svg_no_intrinsic_size',
  SVG_ACTIVE_CONTENT: 'svg_active_content',
  SVG_EXTERNAL_REFERENCE: 'svg_external_reference',
  SVG_RENDER_FAILED: 'svg_render_failed',
  IMAGE_VECTORISATION_UNSUPPORTED: 'image_vectorisation_unsupported',
} as const;

export type ConversionErrorCode =
  (typeof ConversionErrorCode)[keyof typeof ConversionErrorCode];

/**
 * How much of the upload is buffered before the source format is decided.
 *
 * Detection needs enough to see structure but must not need the whole file: the
 * per-format byte budget is only knowable once the format is, and that budget
 * is what stops an oversized upload from being read to the end (SC-006).
 */
export const DETECTION_PREFIX_BYTES = 65536;

/** The media type each format is served as, always UTF-8. */
export const FORMAT_MEDIA_TYPES: Record<ConversionFormat, string> = {
  [ConversionFormat.CSV]: 'text/csv',
  [ConversionFormat.JSON]: 'application/json',
  [ConversionFormat.XML]: 'application/xml',
  [ConversionFormat.YAML]: 'application/yaml',
};

/** The extension each format's attachment carries. */
export const FORMAT_EXTENSIONS: Record<ConversionFormat, string> = {
  [ConversionFormat.CSV]: 'csv',
  [ConversionFormat.JSON]: 'json',
  [ConversionFormat.XML]: 'xml',
  [ConversionFormat.YAML]: 'yaml',
};

/**
 * File-name extensions that hint at a format. Content decides; this is only the
 * tie-breaker for input that is legal as both CSV and YAML (FR-003).
 */
export const EXTENSION_HINTS: Record<string, ConversionFormat> = {
  csv: ConversionFormat.CSV,
  json: ConversionFormat.JSON,
  xml: ConversionFormat.XML,
  yaml: ConversionFormat.YAML,
  yml: ConversionFormat.YAML,
};

/** The attachment name is fixed, never derived from the uploaded name (FR-007). */
export const CONVERTED_FILE_BASE_NAME = 'converted';
