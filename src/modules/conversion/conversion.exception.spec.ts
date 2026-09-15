import { HttpStatus } from '@nestjs/common';

import { ConversionErrorCode } from './conversion.constants';
import {
  CONVERSION_ERROR_DEFINITIONS,
  ConversionErrorBody,
  ConversionException,
} from './conversion.exception';
import { ConversionErrorCategory } from './conversion.enums';

/** The table from contracts/conversion-api.md, restated independently here. */
const DOCUMENTED: [string, HttpStatus, ConversionErrorCategory][] = [
  ['missing_file', 400, ConversionErrorCategory.BAD_REQUEST],
  ['empty_file', 400, ConversionErrorCategory.BAD_REQUEST],
  ['unexpected_part', 400, ConversionErrorCategory.BAD_REQUEST],
  ['missing_target_format', 400, ConversionErrorCategory.BAD_REQUEST],
  ['same_format', 400, ConversionErrorCategory.BAD_REQUEST],
  ['invalid_store_flag', 400, ConversionErrorCategory.BAD_REQUEST],
  ['invalid_encoding', 400, ConversionErrorCategory.PARSE_ERROR],
  ['parse_error', 400, ConversionErrorCategory.PARSE_ERROR],
  ['csv_duplicate_header', 400, ConversionErrorCategory.PARSE_ERROR],
  ['xml_doctype_forbidden', 400, ConversionErrorCategory.PARSE_ERROR],
  ['xml_name_collision', 400, ConversionErrorCategory.BAD_REQUEST],
  [
    'structure_limit_exceeded',
    400,
    ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
  ],
  [
    'csv_too_many_columns',
    400,
    ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
  ],
  ['output_too_large', 400, ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED],
  ['timeout', 400, ConversionErrorCategory.TIMEOUT],
  ['input_too_large', 413, ConversionErrorCategory.PAYLOAD_TOO_LARGE],
  [
    'unsupported_source_format',
    415,
    ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
  ],
  [
    'unsupported_target_format',
    415,
    ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
  ],
  ['internal_error', 500, ConversionErrorCategory.INTERNAL_ERROR],
];

describe('ConversionException', () => {
  it.each(DOCUMENTED)(
    '%s maps to status %i and its documented category',
    (code, status, category) => {
      const exception = new ConversionException(code as never, { limit: 1 });

      expect(exception.getStatus()).toBe(status);
      expect(exception.category).toBe(category);
    },
  );

  it('covers every code in the table and nothing else', () => {
    expect(Object.keys(CONVERSION_ERROR_DEFINITIONS).sort()).toEqual(
      DOCUMENTED.map(([code]) => code).sort(),
    );
  });

  it('leaves "unauthenticated" out of the table', () => {
    // JwtAuthGuard rejects before any conversion code runs, so no
    // ConversionException can carry it and no history row exists for it.
    expect(ConversionErrorCode.UNAUTHENTICATED).toBe('unauthenticated');
    expect(CONVERSION_ERROR_DEFINITIONS).not.toHaveProperty('unauthenticated');
  });

  it('produces the documented error envelope', () => {
    const body = new ConversionException(
      ConversionErrorCode.PARSE_ERROR,
    ).getResponse() as ConversionErrorBody;

    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Input is malformed for its detected format',
      code: 'parse_error',
    });
  });

  it('names the applicable limit on a 413', () => {
    const body = new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
      limit: 1048576,
    }).getResponse() as ConversionErrorBody;

    expect(body.statusCode).toBe(413);
    expect(body.error).toBe('Payload Too Large');
    expect(body.message).toContain('1048576');
  });

  it('reports a location as a position, never as the text at it', () => {
    const body = new ConversionException(ConversionErrorCode.PARSE_ERROR, {
      line: 12,
      column: 3,
    }).getResponse() as ConversionErrorBody;

    expect(body.message).toBe(
      'Input is malformed for its detected format at line 12, column 3',
    );
  });

  describe('message construction', () => {
    // The parameter type admits numbers and two fixed literals and nothing
    // else, so there is no constructor path through which a library parser
    // message — which quotes the uploaded file — could reach a response body,
    // a log line, or failure_reason.
    it('accepts no caller-supplied text', () => {
      const secret = 'SSN 123-45-6789 from the uploaded file';

      for (const [code] of DOCUMENTED) {
        const exception = new ConversionException(code as never, {
          limit: 7,
          line: 1,
          column: 1,
          aspect: 'depth',
          // A stray property must not reach the message even if one is passed.
          ...({ message: secret, detail: secret } as object),
        });

        const body = exception.getResponse() as ConversionErrorBody;
        expect(body.message).not.toContain(secret);
        expect(body.message).not.toContain('123-45-6789');
        expect(exception.toFailureReason()).not.toContain(secret);
      }
    });

    it('builds failure_reason from the code and position alone', () => {
      expect(
        new ConversionException(ConversionErrorCode.PARSE_ERROR, {
          line: 4,
          column: 9,
        }).toFailureReason(),
      ).toBe('parse_error at line 4, column 9');

      expect(
        new ConversionException(
          ConversionErrorCode.EMPTY_FILE,
        ).toFailureReason(),
      ).toBe('empty_file');
    });

    it('keeps failure_reason inside the column width', () => {
      const reason = new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: Number.MAX_SAFE_INTEGER,
        column: Number.MAX_SAFE_INTEGER,
      }).toFailureReason();

      expect(reason.length).toBeLessThanOrEqual(255);
    });
  });

  it('reports the structural aspect that failed', () => {
    const depth = new ConversionException(
      ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED,
      { aspect: 'depth', limit: 64 },
    ).getResponse() as ConversionErrorBody;
    const nodes = new ConversionException(
      ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED,
      { aspect: 'nodes', limit: 200000 },
    ).getResponse() as ConversionErrorBody;

    expect(depth.message).toBe('Input nesting exceeds the maximum depth of 64');
    expect(nodes.message).toBe('Input exceeds the maximum of 200000 nodes');
  });

  it('is an HttpException, so Nest renders it without a custom filter', () => {
    const exception = new ConversionException(ConversionErrorCode.TIMEOUT, {
      limit: 10000,
    });

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception).toBeInstanceOf(Error);
  });
});
