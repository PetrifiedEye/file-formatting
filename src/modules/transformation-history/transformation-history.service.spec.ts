import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHmac } from 'crypto';

import { ConfigService } from '@/core/config/config.service';
import {
  ConversionErrorCategory,
  ConversionFormat,
  ConversionOutcome,
  ConversionRetentionOutcome,
  ImageFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';

import { TransformationHistoryQueryDto } from './dto/transformation-history-query.dto';
import { TransformationHistoryStatus } from './transformation-history.enums';
import { TransformationHistoryService } from './transformation-history.service';

const HMAC_SECRET = 'test-hmac-secret';

// --- A fake QueryBuilder that interprets the service's own SQL fragments ---
// The service emits raw WHERE strings with named parameters. Rather than
// restate its filtering logic here, this harness evaluates the exact fragments
// it produces against in-memory rows, so the tests exercise the real SQL the
// service builds.

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && input.slice(i, i + delimiter.length) === delimiter) {
      parts.push(current);
      current = '';
      i += delimiter.length;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function stripOuterParens(input: string): string {
  let s = input.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') depth--;
      if (depth === 0 && i < s.length - 1) {
        wrapsWhole = false;
        break;
      }
    }
    if (!wrapsWhole) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function comparable(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    // An ISO string on the parameter side of a timestamp comparison.
    return Date.parse(value);
  }
  return String(value);
}

function compare(
  fieldValue: unknown,
  op: string,
  paramValue: unknown,
): boolean {
  const isTemporal =
    fieldValue instanceof Date ||
    (typeof paramValue === 'string' && fieldValue instanceof Date);

  const a = isTemporal ? comparable(fieldValue) : String(fieldValue);
  const b = isTemporal ? comparable(paramValue) : String(paramValue);

  switch (op) {
    case '=':
      return a === b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

function evalExpr(
  expr: string,
  params: Record<string, unknown>,
  row: Record<string, unknown>,
): boolean {
  const unwrapped = stripOuterParens(expr);

  const orParts = splitTopLevel(unwrapped, ' OR ');
  if (orParts.length > 1) {
    return orParts.some((part) => evalExpr(part, params, row));
  }

  const andParts = splitTopLevel(unwrapped, ' AND ');
  if (andParts.length > 1) {
    return andParts.every((part) => evalExpr(part, params, row));
  }

  const match = unwrapped.match(/^([\w.]+) (<=|>=|<|>|=) (:\w+)$/);
  if (!match) {
    throw new Error(`Cannot evaluate atom: ${unwrapped}`);
  }

  const field = match[1].split('.')[1];
  return compare(row[field], match[2], params[match[3].slice(1)]);
}

class FakeQueryBuilder {
  selected: string[] = [];
  private conditions: { sql: string; params: Record<string, unknown> }[] = [];
  private order: { column: string; direction: 'ASC' | 'DESC' }[] = [];
  private limit = Infinity;

  constructor(private readonly rows: Record<string, unknown>[]) {}

  select(columns: string[]): this {
    this.selected = columns;
    return this;
  }

  where(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push({ sql, params });
    return this;
  }

  andWhere(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push({ sql, params });
    return this;
  }

  orderBy(column: string, direction: 'ASC' | 'DESC'): this {
    this.order = [{ column, direction }];
    return this;
  }

  addOrderBy(column: string, direction: 'ASC' | 'DESC'): this {
    this.order.push({ column, direction });
    return this;
  }

  take(n: number): this {
    this.limit = n;
    return this;
  }

  getMany(): Promise<Record<string, unknown>[]> {
    const selectedProps = new Set(
      this.selected.map((column) => column.split('.')[1]),
    );

    const filtered = this.rows.filter((row) =>
      this.conditions.every(({ sql, params }) => evalExpr(sql, params, row)),
    );

    const sorted = [...filtered].sort((a, b) => {
      for (const { column, direction } of this.order) {
        const field = column.split('.')[1];
        const av = comparable(a[field]);
        const bv = comparable(b[field]);
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return direction === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });

    // Hand back only the selected columns, exactly as the database would —
    // so a field the service forgot to select cannot be read off the entity.
    return Promise.resolve(
      sorted
        .slice(0, this.limit)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => selectedProps.has(key)),
          ),
        ),
    );
  }
}

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

function recordId(n: number): string {
  return `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
}

function buildRecord(
  overrides: Partial<ConversionRecord> = {},
): ConversionRecord {
  return {
    id: recordId(1),
    userId: USER_A,
    transformationType: TransformationType.FILE,
    originalFileName: 'payroll.csv',
    sourceFormat: ConversionFormat.CSV,
    targetFormat: ConversionFormat.JSON,
    inputSizeBytes: '20480',
    outputSizeBytes: 131,
    outcome: ConversionOutcome.SUCCESS,
    errorCategory: null,
    failureReason: null,
    retentionRequested: false,
    retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
    storedFileId: null,
    startedAt: new Date('2026-09-18T10:15:30.000Z'),
    durationMs: 42,
    createdAt: new Date('2026-09-18T10:15:30.123Z'),
    ...overrides,
  } as ConversionRecord;
}

describe('TransformationHistoryService', () => {
  let service: TransformationHistoryService;
  let rows: ConversionRecord[];
  let builders: FakeQueryBuilder[];

  beforeEach(async () => {
    rows = [];
    builders = [];

    const repository = {
      createQueryBuilder: jest.fn(() => {
        const builder = new FakeQueryBuilder(
          rows as unknown as Record<string, unknown>[],
        );
        builders.push(builder);
        return builder;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransformationHistoryService,
        {
          provide: getRepositoryToken(ConversionRecord),
          useValue: repository,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(HMAC_SECRET) },
        },
      ],
    }).compile();

    service = module.get(TransformationHistoryService);
  });

  function query(
    overrides: Partial<TransformationHistoryQueryDto> = {},
  ): TransformationHistoryQueryDto {
    return { ...overrides };
  }

  describe('paging', () => {
    it('returns the subject user s rows, newest first, and nothing of anyone else s', async () => {
      rows = [
        buildRecord({
          id: recordId(1),
          createdAt: new Date('2026-09-18T10:00:00.000Z'),
        }),
        buildRecord({
          id: recordId(2),
          createdAt: new Date('2026-09-18T12:00:00.000Z'),
        }),
        buildRecord({
          id: recordId(3),
          userId: USER_B,
          createdAt: new Date('2026-09-18T13:00:00.000Z'),
        }),
      ];

      const page = await service.getHistory(USER_A, query());

      expect(page.items.map((item) => item.id)).toEqual([
        recordId(2),
        recordId(1),
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('returns a cursor only while more rows remain', async () => {
      rows = [1, 2, 3].map((n) =>
        buildRecord({
          id: recordId(n),
          createdAt: new Date(`2026-09-18T1${n}:00:00.000Z`),
        }),
      );

      const first = await service.getHistory(USER_A, query({ limit: 2 }));
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.getHistory(
        USER_A,
        query({ limit: 2, cursor: first.nextCursor as string }),
      );
      expect(second.items.map((item) => item.id)).toEqual([recordId(1)]);
      expect(second.nextCursor).toBeNull();
    });

    it('never serves or skips a row when two share a timestamp', async () => {
      const sameInstant = new Date('2026-09-18T10:00:00.000Z');
      rows = [1, 2, 3].map((n) =>
        buildRecord({ id: recordId(n), createdAt: sameInstant }),
      );

      const first = await service.getHistory(USER_A, query({ limit: 2 }));
      const second = await service.getHistory(
        USER_A,
        query({ limit: 2, cursor: first.nextCursor as string }),
      );

      const seen = [...first.items, ...second.items].map((item) => item.id);
      expect(seen).toEqual([recordId(3), recordId(2), recordId(1)]);
      expect(new Set(seen).size).toBe(3);
    });
  });

  describe('the cursor', () => {
    async function mintCursor(subjectUserId = USER_A): Promise<string> {
      rows = [1, 2].map((n) =>
        buildRecord({
          id: recordId(n),
          userId: subjectUserId,
          createdAt: new Date(`2026-09-18T1${n}:00:00.000Z`),
        }),
      );

      const page = await service.getHistory(subjectUserId, query({ limit: 1 }));
      return page.nextCursor as string;
    }

    it('round-trips through encode and decode', async () => {
      const cursor = await mintCursor();

      await expect(
        service.getHistory(USER_A, query({ limit: 1, cursor })),
      ).resolves.toEqual(
        expect.objectContaining({ items: expect.any(Array) as unknown }),
      );
    });

    it('rejects a tampered signature', async () => {
      const cursor = await mintCursor();
      const [payload] = cursor.split('.');
      const forged = `${payload}.${Buffer.from('nope').toString('base64url')}`;

      await expect(
        service.getHistory(USER_A, query({ limit: 1, cursor: forged })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a correctly signed cursor of the wrong version', async () => {
      const json = JSON.stringify({
        v: 2,
        fp: 'whatever',
        id: recordId(1),
        createdAt: '2026-09-18T10:00:00.000Z',
      });
      const signature = createHmac('sha256', HMAC_SECRET)
        .update(json)
        .digest('base64url');
      const cursor = `${Buffer.from(json, 'utf8').toString('base64url')}.${signature}`;

      await expect(
        service.getHistory(USER_A, query({ limit: 1, cursor })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cursor minted for one user when read against another', async () => {
      // The admin route makes this a request someone can actually send: page
      // one user's history, then present that cursor against another's.
      const cursor = await mintCursor(USER_A);

      rows = [1, 2].map((n) =>
        buildRecord({
          id: recordId(n),
          userId: USER_B,
          createdAt: new Date(`2026-09-18T1${n}:00:00.000Z`),
        }),
      );

      await expect(
        service.getHistory(USER_B, query({ limit: 1, cursor })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cursor minted under a different page size', async () => {
      const cursor = await mintCursor();

      await expect(
        service.getHistory(USER_A, query({ limit: 5, cursor })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a malformed cursor with 400, not 500', async () => {
      await expect(
        service.getHistory(USER_A, query({ cursor: 'not-a-real-cursor' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the response shape', () => {
    it('selects an explicit column list that excludes every withheld field', async () => {
      rows = [buildRecord()];

      await service.getHistory(USER_A, query());

      const selected = builders[0].selected;
      expect(selected).toEqual([
        'record.id',
        'record.transformationType',
        'record.sourceFormat',
        'record.targetFormat',
        'record.outcome',
        'record.errorCategory',
        'record.inputSizeBytes',
        'record.durationMs',
        'record.createdAt',
      ]);

      for (const withheld of [
        'record.originalFileName',
        'record.failureReason',
        'record.storedFileId',
        'record.retentionRequested',
        'record.retentionOutcome',
        'record.startedAt',
        'record.userId',
        'record.outputSizeBytes',
      ]) {
        expect(selected).not.toContain(withheld);
      }
    });

    it('exposes exactly the allow-listed fields on a success', async () => {
      rows = [buildRecord()];

      const page = await service.getHistory(USER_A, query());

      expect(Object.keys(page.items[0]).sort()).toEqual([
        'createdAt',
        'durationMs',
        'fileSize',
        'id',
        'sourceFormat',
        'status',
        'targetFormat',
        'type',
      ]);
      expect(page.items[0]).toEqual({
        id: recordId(1),
        type: TransformationType.FILE,
        sourceFormat: ConversionFormat.CSV,
        targetFormat: ConversionFormat.JSON,
        status: 'success',
        fileSize: 20480,
        durationMs: 42,
        createdAt: '2026-09-18T10:15:30.123Z',
      });
    });

    it('translates a failure to status error and carries its category', async () => {
      rows = [
        buildRecord({
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
          outcome: ConversionOutcome.FAILURE,
          errorCategory: ConversionErrorCategory.TIMEOUT,
          outputSizeBytes: null,
        }),
      ];

      const page = await service.getHistory(USER_A, query());

      expect(page.items[0]).toEqual(
        expect.objectContaining({
          type: TransformationType.IMAGE,
          status: 'error',
          errorCode: ConversionErrorCategory.TIMEOUT,
        }),
      );
    });

    it('reports both formats as null when detection never completed', async () => {
      rows = [
        buildRecord({
          sourceFormat: null,
          targetFormat: null,
          outcome: ConversionOutcome.FAILURE,
          errorCategory: ConversionErrorCategory.UNSUPPORTED_MEDIA_TYPE,
          outputSizeBytes: null,
        }),
      ];

      const page = await service.getHistory(USER_A, query());

      // The row is still classifiable: `type` comes from the column, not from
      // the formats — the whole reason the column exists.
      expect(page.items[0].sourceFormat).toBeNull();
      expect(page.items[0].targetFormat).toBeNull();
      expect(page.items[0].type).toBe(TransformationType.FILE);
    });

    it('omits errorCode entirely on a success', async () => {
      rows = [buildRecord()];

      const page = await service.getHistory(USER_A, query());

      expect('errorCode' in page.items[0]).toBe(false);
    });

    it('returns an empty page, not an error, for a user with no history', async () => {
      rows = [buildRecord({ userId: USER_B })];

      await expect(service.getHistory(USER_A, query())).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('filters (US4)', () => {
    beforeEach(() => {
      rows = [
        buildRecord({
          id: recordId(1),
          createdAt: new Date('2026-09-10T10:00:00.000Z'),
        }),
        buildRecord({
          id: recordId(2),
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
          createdAt: new Date('2026-09-11T10:00:00.000Z'),
        }),
        buildRecord({
          id: recordId(3),
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.SVG,
          outcome: ConversionOutcome.FAILURE,
          errorCategory: ConversionErrorCategory.TIMEOUT,
          outputSizeBytes: null,
          createdAt: new Date('2026-09-12T10:00:00.000Z'),
        }),
      ];
    });

    async function idsFor(
      overrides: Partial<TransformationHistoryQueryDto>,
    ): Promise<string[]> {
      const page = await service.getHistory(USER_A, query(overrides));
      return page.items.map((item) => item.id);
    }

    it('narrows by type', async () => {
      await expect(idsFor({ type: TransformationType.IMAGE })).resolves.toEqual(
        [recordId(3), recordId(2)],
      );
      await expect(idsFor({ type: TransformationType.FILE })).resolves.toEqual([
        recordId(1),
      ]);
    });

    it('narrows by source and target format', async () => {
      await expect(idsFor({ sourceFormat: ImageFormat.PNG })).resolves.toEqual([
        recordId(3),
        recordId(2),
      ]);
      await expect(idsFor({ targetFormat: ImageFormat.JPEG })).resolves.toEqual(
        [recordId(2)],
      );
    });

    it('narrows by status, translating error to the persisted failure', async () => {
      await expect(
        idsFor({ status: TransformationHistoryStatus.ERROR }),
      ).resolves.toEqual([recordId(3)]);
      await expect(
        idsFor({ status: TransformationHistoryStatus.SUCCESS }),
      ).resolves.toEqual([recordId(2), recordId(1)]);
    });

    it('treats both date bounds as inclusive', async () => {
      await expect(
        idsFor({
          createdAtFrom: '2026-09-11T10:00:00.000Z',
          createdAtTo: '2026-09-12T10:00:00.000Z',
        }),
      ).resolves.toEqual([recordId(3), recordId(2)]);
    });

    it('combines filters with AND', async () => {
      await expect(
        idsFor({
          type: TransformationType.IMAGE,
          status: TransformationHistoryStatus.SUCCESS,
          sourceFormat: ImageFormat.PNG,
        }),
      ).resolves.toEqual([recordId(2)]);
    });

    it('returns an empty page when a combination matches nothing', async () => {
      await expect(
        service.getHistory(
          USER_A,
          query({
            type: TransformationType.FILE,
            sourceFormat: ImageFormat.PNG,
          }),
        ),
      ).resolves.toEqual({ items: [], nextCursor: null });
    });

    it('rejects a cursor when any filter changed between the two calls', async () => {
      const first = await service.getHistory(
        USER_A,
        query({ limit: 1, type: TransformationType.IMAGE }),
      );
      const cursor = first.nextCursor as string;
      expect(cursor).not.toBeNull();

      // Same page size, same user, different filter: the cursor is bound to
      // the whole effective option set, so it no longer applies.
      await expect(
        service.getHistory(
          USER_A,
          query({ limit: 1, type: TransformationType.FILE, cursor }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.getHistory(
          USER_A,
          query({
            limit: 1,
            type: TransformationType.IMAGE,
            status: TransformationHistoryStatus.SUCCESS,
            cursor,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // ...and still applies when nothing changed.
      await expect(
        service.getHistory(
          USER_A,
          query({ limit: 1, type: TransformationType.IMAGE, cursor }),
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ id: recordId(2) })] as unknown,
        }),
      );
    });
  });

  describe('invalid input (US5)', () => {
    it('rejects an inverted date range rather than answering it empty', async () => {
      rows = [buildRecord()];

      await expect(
        service.getHistory(
          USER_A,
          query({
            createdAtFrom: '2026-09-12T00:00:00.000Z',
            createdAtTo: '2026-09-10T00:00:00.000Z',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a range whose bounds are equal', async () => {
      rows = [buildRecord({ createdAt: new Date('2026-09-11T10:00:00.000Z') })];

      await expect(
        service.getHistory(
          USER_A,
          query({
            createdAtFrom: '2026-09-11T10:00:00.000Z',
            createdAtTo: '2026-09-11T10:00:00.000Z',
          }),
        ),
      ).resolves.toEqual(
        expect.objectContaining({ items: [expect.anything()] as unknown }),
      );
    });

    it('still rejects a malformed cursor with 400 when filters are present', async () => {
      rows = [buildRecord()];

      await expect(
        service.getHistory(
          USER_A,
          query({ cursor: 'not-a-real-cursor', type: TransformationType.FILE }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
