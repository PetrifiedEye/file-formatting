import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConfigService } from '@/core/config/config.service';

import {
  ListUsersQueryDto,
  UserDirectorySortDirection,
  UserDirectorySortField,
} from './dto/list-users-query.dto';
import { UserStatus } from './entities/user.entity';
import { User } from './entities/user.entity';
import { UserDirectoryService } from './user-directory.service';

// --- Minimal SQL-condition evaluator driving a fake TypeORM QueryBuilder ---
// UserDirectoryService builds raw WHERE fragments (with named params) and
// ORDER BY clauses via QueryBuilder. Rather than re-implement the service's
// filtering/sorting logic in the test, this harness *interprets* the exact
// fragments the service emits against an in-memory row set, so the tests
// exercise the real SQL condition strings the service produces.

interface OrderClause {
  column: string;
  direction: 'ASC' | 'DESC';
  nulls?: 'NULLS FIRST' | 'NULLS LAST';
}

function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && str.slice(i, i + delimiter.length) === delimiter) {
      parts.push(current);
      current = '';
      i += delimiter.length;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts.map((p) => p.trim());
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

function getField(row: Record<string, unknown>, ident: string): unknown {
  const prop = ident.split('.')[1];
  return row[prop];
}

function resolveParam(token: string, params: Record<string, unknown>): unknown {
  return params[token.slice(1)];
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function likeToRegex(pattern: string, escapeChar: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === escapeChar && i + 1 < pattern.length) {
      regex += escapeRegex(pattern[i + 1]);
      i++;
    } else if (ch === '%') {
      regex += '.*';
    } else if (ch === '_') {
      regex += '.';
    } else {
      regex += escapeRegex(ch);
    }
  }
  return new RegExp(`^${regex}$`, 'i');
}

function compare(fieldVal: unknown, op: string, paramVal: unknown): boolean {
  let a: number | string;
  let b: number | string;

  if (fieldVal instanceof Date) {
    a = fieldVal.getTime();
    b = new Date(paramVal as string).getTime();
  } else {
    a = String(fieldVal);
    b = String(paramVal);
  }

  if (op === '=') return a === b;
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  throw new Error(`unsupported operator ${op}`);
}

function evalAtom(
  atom: string,
  params: Record<string, unknown>,
  row: Record<string, unknown>,
): boolean {
  const trimmed = atom.trim();
  let m: RegExpMatchArray | null;

  if ((m = trimmed.match(/^([\w.]+) IS NOT NULL$/))) {
    return getField(row, m[1]) !== null && getField(row, m[1]) !== undefined;
  }
  if ((m = trimmed.match(/^([\w.]+) IS NULL$/))) {
    return getField(row, m[1]) === null || getField(row, m[1]) === undefined;
  }
  // The citext column is cast to text so the trigram index applies; the cast
  // is transparent to the comparison this evaluator models.
  if (
    (m = trimmed.match(
      /^(?:CAST\(([\w.]+) AS text\)|([\w.]+)) ILIKE (:\w+) ESCAPE (:\w+)$/,
    ))
  ) {
    const value = getField(row, m[1] ?? m[2]) as string;
    const pattern = resolveParam(m[3], params) as string;
    const escapeChar = resolveParam(m[4], params) as string;
    return likeToRegex(pattern, escapeChar).test(value ?? '');
  }
  if ((m = trimmed.match(/^([\w.]+) (<|>|=) (:\w+)$/))) {
    return compare(getField(row, m[1]), m[2], resolveParam(m[3], params));
  }

  throw new Error(`Cannot evaluate atom: ${trimmed}`);
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

  return evalAtom(unwrapped, params, row);
}

function compareForSort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  clause: OrderClause,
): number {
  const field = clause.column.split('.')[1];
  const av = a[field];
  const bv = b[field];
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;

  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsFirst =
      clause.nulls === 'NULLS FIRST' ||
      (!clause.nulls && clause.direction === 'DESC');
    if (nullsFirst) return aNull ? -1 : 1;
    return aNull ? 1 : -1;
  }

  let cmp = 0;
  if (av instanceof Date && bv instanceof Date) {
    cmp = av.getTime() - bv.getTime();
  } else if ((av as string | number) < (bv as string | number)) {
    cmp = -1;
  } else if ((av as string | number) > (bv as string | number)) {
    cmp = 1;
  }

  return clause.direction === 'DESC' ? -cmp : cmp;
}

class FakeQueryBuilder {
  private conditions: { sql: string; params: Record<string, unknown> }[] = [];
  private orderClauses: OrderClause[] = [];
  private limit = Infinity;

  constructor(private readonly rows: Record<string, unknown>[]) {}

  where(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push({ sql, params });
    return this;
  }

  andWhere(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push({ sql, params });
    return this;
  }

  orderBy(
    column: string,
    direction: 'ASC' | 'DESC',
    nulls?: 'NULLS FIRST' | 'NULLS LAST',
  ): this {
    this.orderClauses = [{ column, direction, nulls }];
    return this;
  }

  addOrderBy(column: string, direction: 'ASC' | 'DESC'): this {
    this.orderClauses.push({ column, direction });
    return this;
  }

  take(n: number): this {
    this.limit = n;
    return this;
  }

  getMany(): Promise<Record<string, unknown>[]> {
    const filtered = this.rows.filter((row) =>
      this.conditions.every(({ sql, params }) => evalExpr(sql, params, row)),
    );
    const sorted = [...filtered].sort((a, b) => {
      for (const clause of this.orderClauses) {
        const cmp = compareForSort(a, b, clause);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    return Promise.resolve(sorted.slice(0, this.limit));
  }
}

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const UUID_C = '00000000-0000-4000-8000-000000000003';
const UUID_D = '00000000-0000-4000-8000-000000000004';
const UUID_E = '00000000-0000-4000-8000-000000000005';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: UUID_A,
    email: 'user@example.com',
    passwordHash: 'secret-hash',
    status: UserStatus.ACTIVE,
    pendingExpiresAt: null,
    confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    failedLoginAttempts: 0,
    lockedUntil: null,
    photoUrl: null,
    deletionStartedAt: null,
    lastLoginAt: null,
    ...overrides,
  } as User;
}

describe('UserDirectoryService', () => {
  let service: UserDirectoryService;
  let rows: User[];
  let repository: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    rows = [];
    repository = {
      createQueryBuilder: jest.fn(
        () =>
          new FakeQueryBuilder(rows as unknown as Record<string, unknown>[]),
      ),
    };

    const configService = {
      get: jest.fn().mockReturnValue('test-hmac-secret'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDirectoryService,
        { provide: getRepositoryToken(User), useValue: repository },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(UserDirectoryService);
  });

  function query(
    overrides: Partial<ListUsersQueryDto> = {},
  ): ListUsersQueryDto {
    return { ...overrides };
  }

  describe('default pagination', () => {
    it('sorts by createdAt DESC, id DESC by default', async () => {
      rows = [
        buildUser({ id: UUID_A, createdAt: new Date('2026-01-01T00:00:00Z') }),
        buildUser({ id: UUID_B, createdAt: new Date('2026-01-03T00:00:00Z') }),
        buildUser({ id: UUID_C, createdAt: new Date('2026-01-02T00:00:00Z') }),
      ];

      const page = await service.list(query());

      expect(page.items.map((item) => item.id)).toEqual([
        UUID_B,
        UUID_C,
        UUID_A,
      ]);
    });

    it('mints nextCursor from row `limit` when an extra row exists', async () => {
      rows = [
        buildUser({ id: UUID_A, createdAt: new Date('2026-01-01T00:00:00Z') }),
        buildUser({ id: UUID_B, createdAt: new Date('2026-01-02T00:00:00Z') }),
        buildUser({ id: UUID_C, createdAt: new Date('2026-01-03T00:00:00Z') }),
      ];

      const page = await service.list(query({ limit: 2 }));

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('returns nextCursor null when no extra row exists', async () => {
      rows = [buildUser({ id: UUID_A })];

      const page = await service.list(query({ limit: 20 }));

      expect(page.nextCursor).toBeNull();
    });

    it('omits rows with deletionStartedAt set', async () => {
      rows = [
        buildUser({ id: UUID_A }),
        buildUser({ id: UUID_B, deletionStartedAt: new Date() }),
      ];

      const page = await service.list(query());

      expect(page.items.map((item) => item.id)).toEqual([UUID_A]);
    });

    it('projects only allow-listed fields', async () => {
      rows = [
        buildUser({
          id: UUID_A,
          email: 'alice@example.com',
          photoUrl: 'https://cdn.example.com/a.jpg',
        }),
      ];

      const page = await service.list(query());
      const anyDate = expect.any(Date) as Date;

      expect(page.items[0]).toEqual({
        id: UUID_A,
        email: 'alice@example.com',
        photo: 'https://cdn.example.com/a.jpg',
        createdAt: anyDate,
        status: UserStatus.ACTIVE,
        lastLoginAt: null,
      });
      expect(page.items[0]).not.toHaveProperty('passwordHash');
      expect(page.items[0]).not.toHaveProperty('failedLoginAttempts');
      expect(page.items[0]).not.toHaveProperty('lockedUntil');
      expect(page.items[0]).not.toHaveProperty('deletionStartedAt');
    });

    it('round-trips a cursor stably for the same options', async () => {
      rows = [
        buildUser({ id: UUID_A, createdAt: new Date('2026-01-01T00:00:00Z') }),
        buildUser({ id: UUID_B, createdAt: new Date('2026-01-02T00:00:00Z') }),
        buildUser({ id: UUID_C, createdAt: new Date('2026-01-03T00:00:00Z') }),
      ];

      const firstPage = await service.list(query({ limit: 2 }));
      const secondPageA = await service.list(
        query({ limit: 2, cursor: firstPage.nextCursor! }),
      );
      const secondPageB = await service.list(
        query({ limit: 2, cursor: firstPage.nextCursor! }),
      );

      expect(secondPageA.items.map((i) => i.id)).toEqual(
        secondPageB.items.map((i) => i.id),
      );
      expect(secondPageA.items.map((i) => i.id)).toEqual([UUID_A]);
    });
  });

  describe('search and filter', () => {
    it('matches email case-insensitively and escapes % and _', async () => {
      rows = [
        buildUser({ id: UUID_A, email: 'alice50%off@example.com' }),
        buildUser({ id: UUID_B, email: 'alice500xoff@example.com' }),
      ];

      const page = await service.list(query({ search: '50%' }));

      expect(page.items.map((i) => i.id)).toEqual([UUID_A]);
    });

    it('is case-insensitive', async () => {
      rows = [buildUser({ id: UUID_A, email: 'Alice@Example.com' })];

      const page = await service.list(query({ search: 'ALICE' }));

      expect(page.items.map((i) => i.id)).toEqual([UUID_A]);
    });

    it('matches an id exactly when the search term is a UUID', async () => {
      rows = [
        buildUser({ id: UUID_A, email: 'alice@example.com' }),
        buildUser({ id: UUID_B, email: 'bob@example.com' }),
      ];

      const page = await service.list(query({ search: UUID_B }));

      expect(page.items.map((i) => i.id)).toEqual([UUID_B]);
    });

    it('filters by status equality', async () => {
      rows = [
        buildUser({ id: UUID_A, status: UserStatus.ACTIVE }),
        buildUser({ id: UUID_B, status: UserStatus.PENDING_CONFIRMATION }),
      ];

      const page = await service.list(
        query({ status: UserStatus.PENDING_CONFIRMATION }),
      );

      expect(page.items.map((i) => i.id)).toEqual([UUID_B]);
    });

    it('combines search and status conjunctively', async () => {
      rows = [
        buildUser({
          id: UUID_A,
          email: 'alice@example.com',
          status: UserStatus.ACTIVE,
        }),
        buildUser({
          id: UUID_B,
          email: 'alice@example.com',
          status: UserStatus.PENDING_CONFIRMATION,
        }),
      ];

      const page = await service.list(
        query({ search: 'alice', status: UserStatus.ACTIVE }),
      );

      expect(page.items.map((i) => i.id)).toEqual([UUID_A]);
    });

    it('treats a whitespace-only search as omitted', async () => {
      rows = [buildUser({ id: UUID_A, email: 'alice@example.com' })];

      const page = await service.list(query({ search: '   ' }));

      expect(page.items.map((i) => i.id)).toEqual([UUID_A]);
    });

    it('sorts by email ascending', async () => {
      rows = [
        buildUser({ id: UUID_A, email: 'carol@example.com' }),
        buildUser({ id: UUID_B, email: 'alice@example.com' }),
        buildUser({ id: UUID_C, email: 'bob@example.com' }),
      ];

      const page = await service.list(
        query({
          sort: UserDirectorySortField.EMAIL,
          direction: UserDirectorySortDirection.ASC,
        }),
      );

      expect(page.items.map((i) => i.email)).toEqual([
        'alice@example.com',
        'bob@example.com',
        'carol@example.com',
      ]);
    });

    it('sorts lastLoginAt DESC with NULLS LAST', async () => {
      rows = [
        buildUser({ id: UUID_A, lastLoginAt: null }),
        buildUser({
          id: UUID_B,
          lastLoginAt: new Date('2026-01-02T00:00:00Z'),
        }),
        buildUser({
          id: UUID_C,
          lastLoginAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ];

      const page = await service.list(
        query({
          sort: UserDirectorySortField.LAST_LOGIN_AT,
          direction: UserDirectorySortDirection.DESC,
        }),
      );

      expect(page.items.map((i) => i.id)).toEqual([UUID_B, UUID_C, UUID_A]);
    });

    it('sorts lastLoginAt ASC with NULLS FIRST', async () => {
      rows = [
        buildUser({ id: UUID_A, lastLoginAt: null }),
        buildUser({
          id: UUID_B,
          lastLoginAt: new Date('2026-01-02T00:00:00Z'),
        }),
        buildUser({
          id: UUID_C,
          lastLoginAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ];

      const page = await service.list(
        query({
          sort: UserDirectorySortField.LAST_LOGIN_AT,
          direction: UserDirectorySortDirection.ASC,
        }),
      );

      expect(page.items.map((i) => i.id)).toEqual([UUID_A, UUID_C, UUID_B]);
    });

    it('pages correctly across a lastLoginAt DESC boundary with nulls', async () => {
      rows = [
        buildUser({
          id: UUID_A,
          lastLoginAt: new Date('2026-01-03T00:00:00Z'),
        }),
        buildUser({
          id: UUID_B,
          lastLoginAt: new Date('2026-01-02T00:00:00Z'),
        }),
        buildUser({ id: UUID_C, lastLoginAt: null }),
        buildUser({ id: UUID_D, lastLoginAt: null }),
      ];

      const firstPage = await service.list(
        query({
          limit: 2,
          sort: UserDirectorySortField.LAST_LOGIN_AT,
          direction: UserDirectorySortDirection.DESC,
        }),
      );
      expect(firstPage.items.map((i) => i.id)).toEqual([UUID_A, UUID_B]);

      const secondPage = await service.list(
        query({
          limit: 2,
          sort: UserDirectorySortField.LAST_LOGIN_AT,
          direction: UserDirectorySortDirection.DESC,
          cursor: firstPage.nextCursor!,
        }),
      );
      expect(secondPage.items.map((i) => i.id)).toEqual([UUID_D, UUID_C]);
      expect(secondPage.nextCursor).toBeNull();
    });
  });

  describe('cursor validation', () => {
    it('rejects a malformed cursor without querying users', async () => {
      await expect(
        service.list(query({ cursor: 'not-a-token' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('uses a generic message that does not echo the token', async () => {
      await expect(service.list(query({ cursor: 'garbage' }))).rejects.toThrow(
        'Invalid cursor',
      );
    });

    it('rejects a tampered signature', async () => {
      rows = [buildUser({ id: UUID_A }), buildUser({ id: UUID_B })];
      const page = await service.list(query({ limit: 1 }));
      const [jsonPart] = page.nextCursor!.split('.');
      const tampered = `${jsonPart}.tampered-signature`;

      await expect(
        service.list(query({ limit: 1, cursor: tampered })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cursor with an unsupported version', async () => {
      const buf = Buffer.from(
        JSON.stringify({
          v: 2,
          sort: 'createdAt',
          dir: 'desc',
          fp: 'x',
          id: UUID_A,
        }),
      ).toString('base64url');

      await expect(
        service.list(query({ cursor: `${buf}.signature` })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cursor whose fingerprint does not match the current options', async () => {
      rows = [buildUser({ id: UUID_A }), buildUser({ id: UUID_B })];
      const page = await service.list(query({ limit: 1 }));

      await expect(
        service.list(
          query({ limit: 1, search: 'zzz', cursor: page.nextCursor! }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not invalidate a cursor merely because the previous row is gone', async () => {
      rows = [
        buildUser({ id: UUID_A, createdAt: new Date('2026-01-03T00:00:00Z') }),
        buildUser({ id: UUID_B, createdAt: new Date('2026-01-02T00:00:00Z') }),
        buildUser({ id: UUID_E, createdAt: new Date('2026-01-01T00:00:00Z') }),
      ];

      const firstPage = await service.list(query({ limit: 2 }));
      expect(firstPage.items.map((i) => i.id)).toEqual([UUID_A, UUID_B]);

      // Simulate UUID_B being deleted between page 1 and page 2.
      rows = [
        buildUser({ id: UUID_A, createdAt: new Date('2026-01-03T00:00:00Z') }),
        buildUser({ id: UUID_E, createdAt: new Date('2026-01-01T00:00:00Z') }),
      ];

      const secondPage = await service.list(
        query({ limit: 2, cursor: firstPage.nextCursor! }),
      );

      expect(secondPage.items.map((i) => i.id)).toEqual([UUID_E]);
    });
  });
});
