import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { CursorCodec } from '@/core/pagination/cursor-codec';
import { fetchPageWithTotal } from '@/core/pagination/cursor-page';
import { isUuid } from '@/core/validation/joi-fields';

import {
  ListUsersQueryDto,
  UserDirectorySortDirection,
  UserDirectorySortField,
} from '@/modules/users/dto/list-users-query.dto';
import { UserDirectoryItemDto } from '@/modules/users/dto/user-directory-item.dto';
import { UserDirectoryPageDto } from '@/modules/users/dto/user-directory-page.dto';
import { User } from '@/modules/users/entities/user.entity';

interface EffectiveOptions {
  limit: number;
  search?: string;
  status?: string;
  sort: UserDirectorySortField;
  direction: UserDirectorySortDirection;
}

/** The last row served, by the one sort key in use plus the `id` tiebreak. */
interface CursorPosition {
  id: string;
  createdAt?: string;
  email?: string;
  lastLoginAt?: string | null;
}

function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

@Injectable()
export class UserDirectoryService {
  private readonly cursors: CursorCodec<CursorPosition>;

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {
    this.cursors = new CursorCodec(this.configService.get('JWT_ACCESS_SECRET'));
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

    const cursor = query.cursor
      ? this.cursors.decode(query.cursor, fingerprint)
      : null;

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .where('user.deletionStartedAt IS NULL');

    this.applySearch(qb, options.search);
    this.applyStatus(qb, options.status);

    const { rows, total } = await fetchPageWithTotal(qb, (page) => {
      this.applyKeyset(page, options.sort, options.direction, cursor);
      this.applyOrder(page, options.sort, options.direction);
      page.take(options.limit + 1);
    });

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;

    const items = pageRows.map((user) => this.toItem(user));

    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor(
            pageRows[pageRows.length - 1],
            options.sort,
            fingerprint,
          )
        : null;

    return { items, nextCursor, total };
  }

  private applySearch(
    qb: SelectQueryBuilder<User>,
    search: string | undefined,
  ): void {
    if (!search) {
      return;
    }

    const escaped = escapeLikeTerm(search);

    // Cast to text so the trigram index (`idx_users_directory_email_trgm`) can
    // serve the leading-wildcard match: pg_trgm has no citext operator class,
    // and against citext the planner had no usable plan and scanned every row.
    // ILIKE on text is case-insensitive too, so the results are unchanged.
    // Spelled `CAST(... AS text)` because `user.email::text` confuses the query
    // builder's alias resolution.
    if (isUuid(search)) {
      qb.andWhere(
        '(CAST(user.email AS text) ILIKE :searchTerm ESCAPE :escapeChar OR user.id = :searchId)',
        { searchTerm: `%${escaped}%`, escapeChar: '\\', searchId: search },
      );
    } else {
      qb.andWhere(
        'CAST(user.email AS text) ILIKE :searchTerm ESCAPE :escapeChar',
        { searchTerm: `%${escaped}%`, escapeChar: '\\' },
      );
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
    cursor: CursorPosition | null,
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
    return this.cursors.fingerprint({
      search: options.search ?? null,
      status: options.status ?? null,
      sort: options.sort,
      direction: options.direction,
      limit: options.limit,
    });
  }

  private encodeCursor(
    lastRow: User,
    sort: UserDirectorySortField,
    fingerprint: string,
  ): string {
    const position: CursorPosition = { id: lastRow.id };

    if (sort === UserDirectorySortField.EMAIL) {
      position.email = lastRow.email;
    } else if (sort === UserDirectorySortField.LAST_LOGIN_AT) {
      position.lastLoginAt = lastRow.lastLoginAt
        ? lastRow.lastLoginAt.toISOString()
        : null;
    } else {
      position.createdAt = lastRow.createdAt.toISOString();
    }

    return this.cursors.encode(fingerprint, position);
  }
}
