# Phase 1 Data Model: Admin User List

## Entities

### User (modified)

Existing entity: `src/modules/users/entities/user.entity.ts`, table `users`.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | unchanged — directory item `id`; exact-match search key |
| `email` | `citext`, unique | unchanged — returned in full (FR-013); case-insensitive `ILIKE` search |
| `passwordHash` | `varchar(255)` | unchanged — **never** selected or returned |
| `status` | enum `pending_confirmation` \| `active` | unchanged — optional equality filter (FR-008) |
| `pendingExpiresAt` | `timestamptz`, nullable | unchanged — not a directory field |
| `confirmedAt` | `timestamptz`, nullable | unchanged — not a directory field |
| `createdAt` | `timestamptz` | unchanged — directory item + default sort |
| `updatedAt` | `timestamptz` | unchanged — not a directory field |
| `failedLoginAttempts` | `smallint` | unchanged — secret/internal; never returned |
| `lockedUntil` | `timestamptz`, nullable | unchanged — never returned |
| `photoUrl` | `varchar`, nullable | unchanged — serialized as `photo` |
| `deletionStartedAt` | `timestamptz`, nullable | unchanged — listable iff `NULL` (FR-015) |
| **`lastLoginAt`** | `timestamptz`, nullable | **NEW** — column `last_login_at`; denormalized last successful sign-in (see [research.md §4](./research.md)). `NULL` if the account has never completed sign-in. |

No new user statuses. `blocked` / `deleted` remain out of scope.

### Listable Account (query predicate, not a table)

A `users` row is listable when `deletion_started_at IS NULL`. Fully deleted
rows are absent. Mid-deletion rows (`deletion_started_at IS NOT NULL`) are
omitted from every page, including pages requested with an older cursor.

### User Directory Item (response projection, not a table)

Allow-listed fields only (FR-011 / FR-012):

| Field | Source | Nullability |
|---|---|---|
| `id` | `users.id` | never null |
| `email` | `users.email` | never null (full, unmasked) |
| `photo` | `users.photo_url` | null when unset |
| `createdAt` | `users.created_at` | never null |
| `status` | `users.status` | `active` or `pending_confirmation` |
| `lastLoginAt` | `users.last_login_at` | null when unknown |

### Directory Page (response projection, not a table)

| Field | Notes |
|---|---|
| `items` | Array of directory items, length `0..limit` |
| `nextCursor` | Opaque HMAC token string when another page exists; `null` when this page is the last (including empty results) |

### UserDirectoryAuditEvent (new)

New entity: `src/modules/users/entities/user-directory-audit-event.entity.ts`,
table `user_directory_audit_events`. Mirrors `AccountDeletionAuditEvent`
conventions (no FK to `users`, no PII columns).

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | `gen_random_uuid()` default |
| `actorId` | `uuid`, nullable | authenticated caller's id; `NULL` for unauthenticated attempts |
| `outcome` | enum | `SUCCESS`, `DENIED`, `UNAUTHENTICATED`, `INVALID`, `RATE_LIMITED` |
| `resultCount` | `integer`, nullable | item count on `SUCCESS`; `NULL` otherwise |
| `searchUsed` | `boolean`, nullable | whether a non-empty search phrase was supplied; `NULL` if options were never parsed |
| `statusFilterUsed` | `boolean`, nullable | whether a status filter was supplied |
| `sortField` | `varchar`, nullable | `createdAt` \| `lastLoginAt` \| `email` after defaults applied; `NULL` if options were never parsed |
| `createdAt` | `timestamptz` | `CreateDateColumn` |

Postgres enum labels: `success`, `denied`, `unauthenticated`, `invalid`,
`rate_limited`.

**Index**: `idx_user_directory_audit_actor_created` on `(actor_id, created_at)`
(nullable `actor_id` still useful for authenticated reviews).

No search-text, email, cursor, or item-payload columns exist on this entity
(FR-018).

## Relationships

- `User.lastLoginAt` is a scalar. It is maintained from login success paths
  in `AuthService`; it is not a FK to `login_audit_events`.
- `UserDirectoryAuditEvent.actorId` conceptually references `users.id` but
  is stored without an FK so history survives account deletion (same
  precedent as other users-module audit tables).

## Indexes (new, listable rows only)

```sql
CREATE INDEX idx_users_directory_created
  ON users (created_at DESC, id DESC)
  WHERE deletion_started_at IS NULL;

CREATE INDEX idx_users_directory_email
  ON users (email, id)
  WHERE deletion_started_at IS NULL;

CREATE INDEX idx_users_directory_last_login
  ON users (last_login_at DESC, id DESC)
  WHERE deletion_started_at IS NULL;
```

**Rationale**: keyset `ORDER BY` / `WHERE` on the three supported sorts;
partial predicate matches the listable filter so mid-deletion rows do not
bloat the index. Unique email index already exists for exact lookups; it
does not serve `%term%` `ILIKE` (accepted at 10k scale — [research.md §7](./research.md)).

## Validation Rules

- `limit`: integer 1–100; default 20; otherwise 400, no query executed.
- `status`: omitted or one of `UserStatus`; otherwise 400.
- `sort`: omitted or `createdAt` | `lastLoginAt` | `email`; otherwise 400.
- `direction`: omitted or `asc` | `desc`; otherwise 400.
- `search`: optional string; trim; empty after trim → no search. `%` and
  `_` escaped before `ILIKE`.
- `cursor`: optional; must HMAC-verify, parse, `v === 1`, and fingerprint
  the current listing options; otherwise 400. Must not error merely because
  the previously listed account has been deleted.

## State Transitions

None for account lifecycle. This feature is read-only against user rows
except:

1. Migration backfill of `last_login_at` from `login_audit_events`.
2. Subsequent writes to `last_login_at` on completed sign-in (token issue)
   in `AuthService` — a denormalized update of existing login history, not
   a new user status.

## Cursor payload (not persisted)

Opaque token contents (HMAC-signed, see [research.md §6](./research.md)):

- `v`, `sort`, `dir`, `fp` (options fingerprint)
- `id` (tie-breaker)
- the active sort-key value (`createdAt` | `email` | `lastLoginAt`, the
  last of which may be JSON `null`)

The token is not stored. Invalid/mismatched tokens are rejected; they are
not "skipped" to the next available row.
