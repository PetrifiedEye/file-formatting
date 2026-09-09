import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { isUUID } from 'class-validator';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

import {
  ListUsersQueryDto,
  UserDirectorySortDirection,
  UserDirectorySortField,
} from './dto/list-users-query.dto';
import { UserDirectoryItemDto } from './dto/user-directory-item.dto';
import { UserDirectoryPageDto } from './dto/user-directory-page.dto';
import { User } from './entities/user.entity';

const CURSOR_VERSION = 1;
const INVALID_CURSOR_MESSAGE = 'Invalid cursor';

interface EffectiveOptions {
  limit: number;
  search?: string;
  status?: string;
  sort: UserDirectorySortField;
  direction: UserDirectorySortDirection;
}

interface CursorPayload {
  v: number;
  sort: string;
  dir: string;
  fp: string;
  id: string;
  createdAt?: string;
  email?: string;
  lastLoginAt?: string | null;
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

@Injectable()
export class UserDirectoryService {
  private readonly hmacSecret: string;

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {
    this.hmacSecret = this.configService.get('JWT_ACCESS_SECRET');
  }

  async list(query: ListUsersQueryDto): Promise<UserDirectoryPageDto> {
    const trimmedSearch = query.search?.trim();

    const options: EffectiveOptions = {
      limit: query.limit ?? 20,
      search:
        trimmedSearch && trimmedSearch.length > 0 ? trimmedSearch : undefined,
      status: query.status,
      sort: query.sort ?? UserDirectorySortField.CREATED_AT,
      direction: query.direction ?? UserDirectorySortDirection.DESC,
    };

    const fingerprint = this.computeFingerprint(options);

    const cursorPayload = query.cursor
      ? this.decodeCursor(query.cursor, fingerprint)
      : null;

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .where('user.deletionStartedAt IS NULL');

    this.applySearch(qb, options.search);
    this.applyStatus(qb, options.status);
    this.applyKeyset(qb, options.sort, options.direction, cursorPayload);
    this.applyOrder(qb, options.sort, options.direction);

    qb.take(options.limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;

    const items = pageRows.map((user) => this.toItem(user));

    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor(
            pageRows[pageRows.length - 1],
            options.sort,
            options.direction,
            fingerprint,
          )
        : null;

    return { items, nextCursor };
  }

  private applySearch(
    qb: SelectQueryBuilder<User>,
    search: string | undefined,
  ): void {
    if (!search) {
      return;
    }

    const escaped = escapeLikeTerm(search);

    if (isUUID(search)) {
      qb.andWhere(
        '(user.email ILIKE :searchTerm ESCAPE :escapeChar OR user.id = :searchId)',
        { searchTerm: `%${escaped}%`, escapeChar: '\\', searchId: search },
      );
    } else {
      qb.andWhere('user.email ILIKE :searchTerm ESCAPE :escapeChar', {
        searchTerm: `%${escaped}%`,
        escapeChar: '\\',
      });
    }
  }

  private applyStatus(
    qb: SelectQueryBuilder<User>,
    status: string | undefined,
  ): void {
    if (!status) {
      return;
    }

    qb.andWhere('user.status = :status', { status });
  }

  private applyOrder(
    qb: SelectQueryBuilder<User>,
    sort: UserDirectorySortField,
    direction: UserDirectorySortDirection,
  ): void {
    const desc = direction === UserDirectorySortDirection.DESC;

    if (sort === UserDirectorySortField.LAST_LOGIN_AT) {
      qb.orderBy(
        'user.lastLoginAt',
        desc ? 'DESC' : 'ASC',
        desc ? 'NULLS LAST' : 'NULLS FIRST',
      ).addOrderBy('user.id', desc ? 'DESC' : 'ASC');
      return;
    }

    const column =
      sort === UserDirectorySortField.EMAIL ? 'user.email' : 'user.createdAt';

    qb.orderBy(column, desc ? 'DESC' : 'ASC').addOrderBy(
      'user.id',
      desc ? 'DESC' : 'ASC',
    );
  }

  private applyKeyset(
    qb: SelectQueryBuilder<User>,
    sort: UserDirectorySortField,
    direction: UserDirectorySortDirection,
    cursor: CursorPayload | null,
  ): void {
    if (!cursor) {
      return;
    }

    const desc = direction === UserDirectorySortDirection.DESC;
    const cmp = desc ? '<' : '>';

    if (sort === UserDirectorySortField.LAST_LOGIN_AT) {
      const value = cursor.lastLoginAt ?? null;

      if (value === null) {
        // NULLs sort last on DESC and first on ASC; a null cursor row means
        // every remaining row on this page's side is also null (DESC) or
        // every non-null row has already been fully paged past (ASC).
        if (desc) {
          qb.andWhere('user.lastLoginAt IS NULL AND user.id ' + cmp + ' :cid', {
            cid: cursor.id,
          });
        } else {
          qb.andWhere(
            '(user.lastLoginAt IS NOT NULL OR (user.lastLoginAt IS NULL AND user.id ' +
              cmp +
              ' :cid))',
            { cid: cursor.id },
          );
        }
        return;
      }

      if (desc) {
        qb.andWhere(
          '(user.lastLoginAt < :sval OR (user.lastLoginAt = :sval AND user.id < :cid) OR user.lastLoginAt IS NULL)',
          { sval: value, cid: cursor.id },
        );
      } else {
        qb.andWhere(
          '(user.lastLoginAt > :sval OR (user.lastLoginAt = :sval AND user.id > :cid))',
          { sval: value, cid: cursor.id },
        );
      }
      return;
    }

    const column =
      sort === UserDirectorySortField.EMAIL ? 'user.email' : 'user.createdAt';
    const value =
      sort === UserDirectorySortField.EMAIL ? cursor.email : cursor.createdAt;

    qb.andWhere(
      `(${column} ${cmp} :sval OR (${column} = :sval AND user.id ${cmp} :cid))`,
      { sval: value, cid: cursor.id },
    );
  }

  private toItem(user: User): UserDirectoryItemDto {
    return {
      id: user.id,
      email: user.email,
      photo: user.photoUrl,
      createdAt: user.createdAt,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    };
  }

  private computeFingerprint(options: EffectiveOptions): string {
    const payload = JSON.stringify({
      search: options.search ?? null,
      status: options.status ?? null,
      sort: options.sort,
      direction: options.direction,
      limit: options.limit,
    });

    return createHash('sha256').update(payload).digest('hex');
  }

  private encodeCursor(
    lastRow: User,
    sort: UserDirectorySortField,
    direction: UserDirectorySortDirection,
    fingerprint: string,
  ): string {
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      sort,
      dir: direction,
      fp: fingerprint,
      id: lastRow.id,
    };

    if (sort === UserDirectorySortField.EMAIL) {
      payload.email = lastRow.email;
    } else if (sort === UserDirectorySortField.LAST_LOGIN_AT) {
      payload.lastLoginAt = lastRow.lastLoginAt
        ? lastRow.lastLoginAt.toISOString()
        : null;
    } else {
      payload.createdAt = lastRow.createdAt.toISOString();
    }

    const json = JSON.stringify(payload);
    const jsonPart = base64UrlEncode(Buffer.from(json, 'utf8'));
    const signature = createHmac('sha256', this.hmacSecret)
      .update(json)
      .digest();
    const signaturePart = base64UrlEncode(signature);

    return `${jsonPart}.${signaturePart}`;
  }

  private decodeCursor(token: string, fingerprint: string): CursorPayload {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) {
        throw new Error('malformed');
      }

      const [jsonPart, signaturePart] = parts;
      const json = base64UrlDecode(jsonPart).toString('utf8');

      const expectedSignature = createHmac('sha256', this.hmacSecret)
        .update(json)
        .digest();
      const actualSignature = base64UrlDecode(signaturePart);

      if (
        expectedSignature.length !== actualSignature.length ||
        !timingSafeEqual(expectedSignature, actualSignature)
      ) {
        throw new Error('bad signature');
      }

      const payload = JSON.parse(json) as CursorPayload;

      if (payload.v !== CURSOR_VERSION) {
        throw new Error('bad version');
      }

      if (payload.fp !== fingerprint) {
        throw new Error('fingerprint mismatch');
      }

      return payload;
    } catch {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
  }
}
