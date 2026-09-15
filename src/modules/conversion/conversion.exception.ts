import { HttpException, HttpStatus } from '@nestjs/common';

import { ConversionErrorCode } from './conversion.constants';
import { ConversionErrorCategory } from './conversion.enums';

/**
 * The only values a caller may contribute to an error message.
 *
 * They are all **numbers or fixed literals** — never a string taken from the
 * uploaded file, and never a library parser message. That is the whole point:
 * `csv-parse`, `yaml`, and `JSON.parse` all quote the offending input, so a
 * message built from one of them would put file content into an HTTP body, a
 * log line, and `conversion_records.failure_reason` (FR-023, SC-005). Keeping
 * the parameter type this narrow makes that leak unrepresentable rather than
 * merely discouraged.
 */
export interface ConversionErrorParams {
  /** A configured limit, for the messages that must name one (FR-016). */
  limit?: number;
  /** Which structural limit was hit. A fixed literal, not free text. */
  aspect?: 'depth' | 'nodes';
  /** Location within the input — a position, never the text at it. */
  line?: number;
  column?: number;
}

interface ConversionErrorDefinition {
  status: HttpStatus;
  category: ConversionErrorCategory;
  message: (params: ConversionErrorParams) => string;
}

function at(params: ConversionErrorParams): string {
  if (params.line === undefined) {
    return '';
  }
  return params.column === undefined
    ? ` at line ${params.line}`
    : ` at line ${params.line}, column ${params.column}`;
}

/**
 * The code → status → category table from the API contract, in one place.
 *
 * `unauthenticated` is deliberately absent: `JwtAuthGuard` rejects before any
 * conversion code runs, so no `ConversionException` can carry it and no history
 * row exists for it (FR-013).
 */
export const CONVERSION_ERROR_DEFINITIONS: Record<
  Exclude<ConversionErrorCode, 'unauthenticated'>,
  ConversionErrorDefinition
> = {
  [ConversionErrorCode.MISSING_FILE]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () => 'Request must contain exactly one "file" part',
  },
  [ConversionErrorCode.EMPTY_FILE]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () => 'The uploaded file is empty',
  },
  [ConversionErrorCode.UNEXPECTED_PART]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () =>
      'Request contains an unexpected, duplicate, or misnamed part',
  },
  [ConversionErrorCode.MISSING_TARGET_FORMAT]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () => '"targetFormat" is required',
  },
  // 400 rather than 415: both formats are supported, the *request* is wrong.
  [ConversionErrorCode.SAME_FORMAT]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () => 'Target format must differ from the detected source format',
  },
  [ConversionErrorCode.INVALID_STORE_FLAG]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () => '"store" must be "true" or "false"',
  },
  [ConversionErrorCode.INVALID_ENCODING]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.PARSE_ERROR,
    message: () => 'Input is not valid UTF-8',
  },
  [ConversionErrorCode.PARSE_ERROR]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.PARSE_ERROR,
    message: (params) =>
      `Input is malformed for its detected format${at(params)}`,
  },
  [ConversionErrorCode.CSV_DUPLICATE_HEADER]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.PARSE_ERROR,
    message: () => 'CSV header fields must be non-empty and distinct',
  },
  [ConversionErrorCode.XML_DOCTYPE_FORBIDDEN]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.PARSE_ERROR,
    message: () => 'XML input must not contain a DOCTYPE declaration',
  },
  // Not a parse failure and not a limit: the input is well-formed, but two of
  // its keys cannot both be represented as XML names. Refusing beats silently
  // writing one over the other (FR-009).
  [ConversionErrorCode.XML_NAME_COLLISION]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.BAD_REQUEST,
    message: () =>
      'Two sibling keys become the same element name once sanitized for XML',
  },
  [ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
    message: (params) =>
      params.aspect === 'depth'
        ? `Input nesting exceeds the maximum depth of ${params.limit}`
        : `Input exceeds the maximum of ${params.limit} nodes`,
  },
  [ConversionErrorCode.CSV_TOO_MANY_COLUMNS]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
    message: (params) =>
      `CSV output would exceed the maximum of ${params.limit} columns`,
  },
  [ConversionErrorCode.OUTPUT_TOO_LARGE]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
    message: (params) =>
      `Converted document exceeds the maximum output size of ${params.limit} bytes`,
  },
  [ConversionErrorCode.TIMEOUT]: {
    status: HttpStatus.BAD_REQUEST,
    category: ConversionErrorCategory.TIMEOUT,
    message: (params) =>
      `Conversion exceeded the time budget of ${params.limit} ms`,
  },
  [ConversionErrorCode.INPUT_TOO_LARGE]: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    category: ConversionErrorCategory.PAYLOAD_TOO_LARGE,
    message: (params) =>
      `File exceeds the maximum input size of ${params.limit} bytes for its detected format`,
  },
  [ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT]: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    category: ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
    message: () => 'The file format could not be determined',
  },
  [ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT]: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    category: ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
    message: () => 'Target format is not supported',
  },
  [ConversionErrorCode.INTERNAL_ERROR]: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    category: ConversionErrorCategory.INTERNAL_ERROR,
    message: () => 'Conversion failed',
  },
};

const STATUS_REASONS: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

export interface ConversionErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code: ConversionErrorCode;
}

/**
 * Every failure this feature reports, carrying a fixed code and the category
 * history records it under. There is no constructor parameter through which a
 * caller could supply message text — see {@link ConversionErrorParams}.
 */
export class ConversionException extends HttpException {
  readonly code: Exclude<ConversionErrorCode, 'unauthenticated'>;
  readonly category: ConversionErrorCategory;
  readonly params: ConversionErrorParams;

  constructor(
    code: Exclude<ConversionErrorCode, 'unauthenticated'>,
    params: ConversionErrorParams = {},
  ) {
    const definition = CONVERSION_ERROR_DEFINITIONS[code];
    const body: ConversionErrorBody = {
      statusCode: definition.status,
      error: STATUS_REASONS[definition.status] ?? 'Error',
      message: definition.message(params),
      code,
    };

    super(body, definition.status);

    this.code = code;
    this.category = definition.category;
    this.params = params;
  }

  /**
   * The code plus its location, for `conversion_records.failure_reason`. Bounded
   * to the column width and, by construction, free of file content.
   */
  toFailureReason(): string {
    const location = at(this.params).trim();
    return location ? `${this.code} ${location}`.slice(0, 255) : this.code;
  }
}
