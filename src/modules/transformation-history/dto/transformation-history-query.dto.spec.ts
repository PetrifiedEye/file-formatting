import { getJoiSchema } from '@/core/validation/joi-schema.decorator';
import { validateWithSchema } from '@/core/validation/joi-validation';
import {
  ConversionFormat,
  ImageFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';

import { TransformationHistoryStatus } from '../transformation-history.enums';
import { TransformationHistoryQueryDto } from './transformation-history-query.dto';

/**
 * The global `JoiValidationPipe` applies this schema to the query string, so
 * these are the checks that turn a bad query into a 400 before the handler is
 * reached (FR-011).
 */
function validate(query: Record<string, unknown>) {
  return validateWithSchema(
    getJoiSchema(TransformationHistoryQueryDto)!,
    query,
  );
}

function failingProperties(query: Record<string, unknown>): string[] {
  const result = validate(query);
  return result.ok ? [] : result.failedKeys;
}

describe('TransformationHistoryQueryDto', () => {
  it('accepts an empty query — every option is optional', () => {
    expect(failingProperties({})).toEqual([]);
  });

  it('accepts every documented option together', () => {
    expect(
      failingProperties({
        limit: '50',
        cursor: 'some-opaque-token',
        type: TransformationType.IMAGE,
        sourceFormat: ImageFormat.PNG,
        targetFormat: ConversionFormat.JSON,
        status: TransformationHistoryStatus.ERROR,
        createdAtFrom: '2026-09-01T00:00:00.000Z',
        createdAtTo: '2026-09-30T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('drops options it does not know', () => {
    const result = validate({ limit: '5', extra: 'x' });

    expect(result).toEqual({ ok: true, value: { limit: 5 } });
  });

  describe('limit', () => {
    it('converts the query-string value to a number', () => {
      // The service computes `limit + 1`; a string would concatenate.
      expect(validate({ limit: '50' })).toEqual({
        ok: true,
        value: { limit: 50 },
      });
    });

    it.each([['0'], ['101'], ['500'], ['-1'], ['abc'], ['1.5']])(
      'rejects %s',
      (limit) => {
        expect(failingProperties({ limit })).toContain('limit');
      },
    );

    it.each([['1'], ['20'], ['100']])('accepts %s', (limit) => {
      expect(failingProperties({ limit })).toEqual([]);
    });
  });

  describe('enum options', () => {
    it.each([
      ['type', 'archive'],
      ['sourceFormat', 'tiff'],
      ['targetFormat', 'tiff'],
      ['status', 'failure'],
    ])('rejects an unrecognized %s', (property, value) => {
      expect(failingProperties({ [property]: value })).toContain(property);
    });

    it('accepts either format family on either format option', () => {
      expect(
        failingProperties({
          sourceFormat: ConversionFormat.CSV,
          targetFormat: ImageFormat.SVG,
        }),
      ).toEqual([]);
    });

    it("rejects the persisted word 'failure' for status, which is 'error' here", () => {
      // The contract's vocabulary, not the column's — the two are translated,
      // never accepted interchangeably.
      expect(failingProperties({ status: 'failure' })).toContain('status');
      expect(failingProperties({ status: 'error' })).toEqual([]);
    });
  });

  describe('date bounds', () => {
    it.each([
      ['createdAtFrom', 'yesterday'],
      ['createdAtTo', '18-09-2026'],
    ])('rejects a malformed %s', (property, value) => {
      expect(failingProperties({ [property]: value })).toContain(property);
    });

    it('accepts ISO 8601 bounds', () => {
      expect(
        failingProperties({
          createdAtFrom: '2026-09-18T00:00:00.000Z',
          createdAtTo: '2026-09-19T00:00:00Z',
        }),
      ).toEqual([]);
    });
  });
});
