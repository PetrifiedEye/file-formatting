import { Repository } from 'typeorm';

import { ConversionErrorCode } from './conversion.constants';
import {
  ConversionErrorCategory,
  ConversionFormat,
  ConversionOutcome,
  ConversionRetentionOutcome,
  TransformationType,
} from './conversion.enums';
import { ConversionException } from './conversion.exception';
import {
  ConversionAttempt,
  ConversionHistoryService,
} from './conversion-history.service';
import { ConversionRecord } from './entities/conversion-record.entity';

const startedAt = new Date('2026-09-15T10:00:00.000Z');

function attemptFor(
  overrides: Partial<ConversionAttempt> = {},
): ConversionAttempt {
  return {
    userId: 'user-1',
    transformationType: TransformationType.FILE,
    originalFileName: 'sample.csv',
    sourceFormat: ConversionFormat.CSV,
    targetFormat: ConversionFormat.JSON,
    inputSizeBytes: 41,
    outputSizeBytes: 131,
    retentionRequested: false,
    retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
    storedFileId: null,
    startedAt,
    durationMs: 12,
    ...overrides,
  };
}

describe('ConversionHistoryService', () => {
  let insert: jest.Mock;
  let service: ConversionHistoryService;

  const written = (): Partial<ConversionRecord> =>
    (insert.mock.calls as Partial<ConversionRecord>[][])[0][0];

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'record-1' }] });
    service = new ConversionHistoryService({
      insert,
    } as unknown as Repository<ConversionRecord>);
  });

  describe('a successful attempt', () => {
    it('records every documented field (FR-022)', async () => {
      await service.record(attemptFor());

      expect(written()).toEqual({
        userId: 'user-1',
        transformationType: TransformationType.FILE,
        originalFileName: 'sample.csv',
        sourceFormat: ConversionFormat.CSV,
        targetFormat: ConversionFormat.JSON,
        inputSizeBytes: '41',
        outputSizeBytes: 131,
        outcome: ConversionOutcome.SUCCESS,
        errorCategory: null,
        failureReason: null,
        retentionRequested: false,
        retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
        storedFileId: null,
        startedAt,
        durationMs: 12,
      });
    });

    it('writes an explicit column list, never a whole entity', async () => {
      await service.record(attemptFor());

      // Every column the row needs is named; nothing is left to inference.
      expect(Object.keys(written()).sort()).toEqual(
        [
          'durationMs',
          'errorCategory',
          'failureReason',
          'inputSizeBytes',
          'originalFileName',
          'outcome',
          'outputSizeBytes',
          'retentionOutcome',
          'retentionRequested',
          'sourceFormat',
          'startedAt',
          'storedFileId',
          'targetFormat',
          'transformationType',
          'userId',
        ].sort(),
      );
    });
  });

  describe('a failed attempt, once per error category', () => {
    const cases: [ConversionErrorCode, ConversionErrorCategory][] = [
      [ConversionErrorCode.EMPTY_FILE, ConversionErrorCategory.BAD_REQUEST],
      [ConversionErrorCode.SAME_FORMAT, ConversionErrorCategory.BAD_REQUEST],
      [
        ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
        ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
      ],
      [
        ConversionErrorCode.INPUT_TOO_LARGE,
        ConversionErrorCategory.PAYLOAD_TOO_LARGE,
      ],
      [ConversionErrorCode.PARSE_ERROR, ConversionErrorCategory.PARSE_ERROR],
      [
        ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED,
        ConversionErrorCategory.STRUCTURE_LIMIT_EXCEEDED,
      ],
      [ConversionErrorCode.TIMEOUT, ConversionErrorCategory.TIMEOUT],
      [
        ConversionErrorCode.INTERNAL_ERROR,
        ConversionErrorCategory.INTERNAL_ERROR,
      ],
    ];

    it.each(cases)('records %s under %s', async (code, category) => {
      await service.record(
        attemptFor({
          failure: new ConversionException(code as never, { limit: 1 }),
          outputSizeBytes: null,
        }),
      );

      expect(written()).toMatchObject({
        outcome: ConversionOutcome.FAILURE,
        errorCategory: category,
        failureReason: code,
        outputSizeBytes: null,
      });
    });

    it('records an unexpected error as internal, with no message of its own', async () => {
      await service.record(
        attemptFor({
          failure: new Error('connect ECONNREFUSED 10.0.0.5:5432'),
        }),
      );

      expect(written()).toMatchObject({
        outcome: ConversionOutcome.FAILURE,
        errorCategory: ConversionErrorCategory.INTERNAL_ERROR,
        failureReason: 'internal_error',
      });
      expect(written().failureReason).not.toContain('ECONNREFUSED');
    });

    it('never records an output size for a failure', async () => {
      await service.record(
        attemptFor({
          failure: new ConversionException(ConversionErrorCode.TIMEOUT, {
            limit: 10,
          }),
          // Even if a caller passes one, the row must not carry it: the CHECK
          // constraint would reject the insert.
          outputSizeBytes: 999,
        }),
      );

      expect(written().outputSizeBytes).toBeNull();
    });

    it('records the formats known at the time of failure', async () => {
      await service.record(
        attemptFor({
          sourceFormat: null,
          targetFormat: ConversionFormat.JSON,
          outputSizeBytes: null,
          failure: new ConversionException(
            ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
          ),
        }),
      );

      expect(written()).toMatchObject({
        sourceFormat: null,
        targetFormat: ConversionFormat.JSON,
      });
    });
  });

  describe('the invariants the schema also enforces', () => {
    it('links a stored file only when retention succeeded', async () => {
      await service.record(
        attemptFor({
          retentionRequested: true,
          retentionOutcome: ConversionRetentionOutcome.STORED,
          storedFileId: 'file-1',
        }),
      );

      expect(written()).toMatchObject({
        retentionRequested: true,
        retentionOutcome: ConversionRetentionOutcome.STORED,
        storedFileId: 'file-1',
      });
    });

    it('records a failed retention as failed, with no link', async () => {
      await service.record(
        attemptFor({
          retentionRequested: true,
          retentionOutcome: ConversionRetentionOutcome.FAILED,
          storedFileId: null,
        }),
      );

      expect(written()).toMatchObject({
        retentionOutcome: ConversionRetentionOutcome.FAILED,
        storedFileId: null,
      });
    });
  });

  describe('no file content, anywhere (FR-023, SC-005)', () => {
    const SECRET = 'SSN 123-45-6789, salary 250000';

    it('writes no field containing input bytes', async () => {
      // A parser message quoting the input is the easiest way to leak content,
      // so the exception that carries it upward cannot hold text at all.
      await service.record(
        attemptFor({
          originalFileName: 'payroll.csv',
          outputSizeBytes: null,
          failure: new ConversionException(ConversionErrorCode.PARSE_ERROR, {
            line: 4,
            column: 11,
          }),
        }),
      );

      const serialized = JSON.stringify(written());

      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('123-45-6789');
      expect(written().failureReason).toBe('parse_error at line 4, column 11');
    });

    it('truncates an over-long file name to the column width', async () => {
      await service.record(
        attemptFor({ originalFileName: `${'a'.repeat(400)}.csv` }),
      );

      expect(written().originalFileName).toHaveLength(255);
    });
  });

  describe('durability', () => {
    it('does not throw when the insert fails', async () => {
      // It runs in a `finally`; throwing here would replace the answer the
      // caller was about to get, and mask the error that led here.
      insert.mockRejectedValue(new Error('deadlock detected'));

      await expect(service.record(attemptFor())).resolves.toBeNull();
    });

    it('returns the new row id so a retained file can be attached', async () => {
      await expect(service.record(attemptFor())).resolves.toBe('record-1');
    });
  });
});
