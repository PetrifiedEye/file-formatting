# Phase 0 Research: Admin User List

All Technical Context items are resolved against the current `dev` codebase.
No `NEEDS CLARIFICATION` markers remain.

## 1. Route shape and NestJS routing

**Decision**: Expose `GET /users` on the existing `UsersController`
(`src/modules/users/users.controller.ts`) as a collection list. Keep
`GET /users/:userId` as the single-profile route. Declare the list handler
(`@Get()`) **above** `@Get(':userId')` so Fastify/Nest never treats a missing
id as a param route.

**Rationale**: REST collection-vs-item convention; the spec does not name a
path, and `/users` is the natural directory URL. Nested paths already used
under this controller (`/users/me/email-change`, `/users/:userId/email`) do
not collide with a parameter-less `GET /users`.

**Alternatives considered**: `GET /admin/users` (clearer admin branding) was
rejected — other admin-only user operations (`PATCH /users/:userId/email`,
`DELETE /users/:userId`) already live under `/users` and are gated by RBAC,
not by an `/admin` prefix.

## 2. Access decision: PermissionGuard vs. service check

**Decision**: Do **not** use `@RequirePermission('users', 'list')` +
`PermissionGuard`. After `JwtAuthGuard` authenticates the caller, the list
handler calls `AccessConfigService.hasPermission(request.user.roles, 'users',
'list')` and throws `ForbiddenException` when false — the same pattern as
`updateProfile`, `updateEmailDirect`, and `adminDeleteUser` in
`users.controller.ts`.

**Rationale**: (1) Every privileged route in `UsersController` already uses
this explicit check, not `PermissionGuard` (which is reserved for `/rbac/*`).
(2) The handler must record a directory audit row on 403 (FR-018); doing the
check in the handler keeps that write next to the decision. (3) FR-020
(`users.read` MUST NOT grant listing) is satisfied because `hasPermission`
matches the action string exactly.

**Request-time evaluation (FR-017)**: `JwtAuthGuard` loads role memberships
from `user_roles` on every request. `AccessConfigService` answers from its
in-memory grants snapshot, which `GrantsService` already reloads on grant
mutations. Permissions are therefore not frozen in the JWT — they reflect
current role membership plus the latest reloaded grant config, matching
existing RBAC semantics.

**Alternatives considered**: Declarative `PermissionGuard` would 403 before
the handler and force all 403 auditing into an exception filter. Rejected to
stay consistent with this module and to keep the deny path testable on the
service.

## 3. New `users.list` permission and Admin grant

**Decision**: Migration appends `'list'` to `permissions.actions` where
`name = 'users'`, and appends `'list'` to the Admin role's grant on that
permission. No other seeded role is granted `list`. Operators can still
grant it later via `POST /rbac/grants`.

Current Admin grant (after 008) is
`['read', 'update', 'update-email', 'delete']`. After this feature:
`['read', 'update', 'update-email', 'delete', 'list']`.

**Rationale**: Spec FR-001/FR-019/Assumptions — `list` is a new action on the
existing `users` permission, distinct from `read`. Follow
`1760200000000-AccountDeletion.migration.ts` (how `delete` was added).

**Alternatives considered**: A separate permission named `users.list` was
rejected — the RBAC model is `(permission name, action)`, not dotted
permission names. A dedicated `users.list.admin` permission (from the raw
feature request) was rejected by the spec in favour of `users.list`.

## 4. Last successful sign-in

**Decision**: Add nullable `users.last_login_at timestamptz`. Treat it as a
**denormalized projection** of existing login history, not a new sign-in
process.

- **Backfill**: `MAX(created_at)` from `login_audit_events` where
  `outcome = 'success'` and `event_type IN ('login_attempt',
  'login_verification_attempt')` grouped by `user_id`.
- **Forward**: set `last_login_at = now()` only when access/refresh tokens
  are actually issued (`AuthService.login` when sign-in confirmation is off;
  `finalizeLoginVerification` when confirmation succeeds). Do **not** update
  it in `UsersService.recordSuccessfulLogin` (that runs on password-ok, even
  when a verification challenge is still required) and do **not** update it
  on token refresh.

**Rationale**: The spec says expose last sign-in from existing history and
not invent a new tracking process. A column is still required because
FR-009 sorts by last sign-in and SC-001 requires a 10k-row directory in
under 2s — a per-row `MAX()` subquery on `login_audit_events` cannot be
`ORDER BY`'d efficiently (constitution Principle III: index columns used in
`ORDER BY`). Denormalizing an already-recorded timestamp is the indexed
projection of that history.

**NULL semantics (FR-009)**: unknown last sign-in sorts **after** known
values when newest-first (`ORDER BY last_login_at DESC NULLS LAST`) and
**before** them when oldest-first (`ORDER BY last_login_at ASC NULLS FIRST`).
PostgreSQL defaults are the opposite (DESC → NULLS FIRST, ASC → NULLS LAST),
so NULLS must be specified explicitly.

**Alternatives considered**: Live subquery/join to `login_audit_events`
(correct but too slow to sort). Using `sessions.issued_at` (sessions were
removed/replaced by JWTs in 004; remaining session tables are not the
source of truth for "last successful sign-in").

## 5. Listable-account filter (deletion)

**Decision**: Directory queries always add `deletion_started_at IS NULL`.
Fully deleted accounts are already gone (`DELETE` of the `users` row in
008). Rows with `deletion_started_at` set are mid-deletion and MUST be
omitted (FR-015). Do not add `blocked`/`deleted` statuses.

**Rationale**: Matches 008's claim-then-delete model and the spec assumption
that those statuses are out of scope. A continuation token MUST NOT fail
solely because a previously listed id has since been deleted — keyset
pagination compares sort keys, not "the previous page's id still exists".

## 6. Cursor pagination

**Decision**: Keyset (seek) pagination with an HMAC-signed opaque cursor.

Token format: `base64url(json).base64url(hmac-sha256)`, HMAC key =
existing `JWT_ACCESS_SECRET` (no new env var). JSON payload:

| Field | Purpose |
|---|---|
| `v` | version (`1`) |
| `sort`, `dir` | sort field + direction used to build this page |
| `fp` | SHA-256 fingerprint of listing options (`search`, `status`, `sort`, `direction`, `limit`) |
| `id` | last item's account id (tie-breaker) |
| `createdAt` / `email` / `lastLoginAt` | last item's sort-key value (only the key for the active sort) |

- Fetch `limit + 1` rows. If the extra row exists, mint a cursor from row
  `limit` and drop the extra; otherwise `nextCursor` is `null`.
- Default sort: `createdAt` descending, `id` descending as the unique
  tie-breaker (FR-006 stability).
- A cursor that fails HMAC, JSON parse, version check, or fingerprint
  mismatch against the current query → `400` (US4 / FR-005), no items.
- Repeating the same options + cursor returns the same ids while those
  rows remain listable (keyset over a unique `(sort_key, id)`).

**Rationale**: Offset pagination is not stable under inserts/deletes (fails
FR-006 and the concurrent-admin edge case). Unsigned base64 cursors can be
forged to skip/filter arbitrarily; HMAC makes the token opaque and
tamper-evident using a secret the process already has.

**Alternatives considered**: Offset/`page` (unstable). Cursor stored
server-side (extra table, unnecessary for a read).

## 7. Search and filter

**Decision**:

- `search`: trim; whitespace-only → treated as omitted (edge case). Escape
  `%` and `_` before `ILIKE`. Match `email ILIKE '%' \|\| :term \|\| '%'`
  (citext → case-insensitive) **OR**, when `:term` is a UUID, `id = :term`.
- `status`: optional enum `active` | `pending_confirmation`; unknown → 400.
- Search AND status are conjunctive (FR-010).

At 10k rows, a citext `ILIKE '%term%'` sequential scan is well under 2s;
do **not** add `pg_trgm` in this feature. Revisit if the directory grows
past this scale. Exact id match uses the PK.

**Alternatives considered**: Prefix-only search (would use the unique email
index, but the spec requires partial match). `pg_trgm` GIN now (premature
for SC-001's 10k bound).

## 8. Response shaping / secrets

**Decision**: Dedicated `UserDirectoryItemDto` + `UserDirectoryPageDto`.
Build each item by copying only the allow-list: `id`, `email`, `photo`
(from `photoUrl`, null if unset), `createdAt`, `status`, `lastLoginAt`
(null if unset). Never select or serialize `passwordHash`,
`failedLoginAttempts`, `lockedUntil`, pending-confirmation internals,
challenge tokens, or `deletionStartedAt`.

**Rationale**: Same explicit-mapping convention as
`toUserProfileResponse` / `getProfileFor` (default-deny by construction).
FR-013: email is full, not masked, for `users.list` holders.

## 9. Query DTO and validation

**Decision**: `ListUsersQueryDto` with `class-validator` +
`class-transformer` (`@Type`, `@Transform` trim). Global `ValidationPipe`
(`whitelist: true`) already applied.

| Query | Default | Validation |
|---|---|---|
| `limit` | `20` | integer 1–100 inclusive; out of range → 400 |
| `cursor` | omitted | string; semantically validated after HMAC decode |
| `search` | omitted | string; blank/whitespace → `undefined` |
| `status` | omitted (all listable) | `UserStatus` enum |
| `sort` | `createdAt` | `createdAt` \| `lastLoginAt` \| `email` |
| `direction` | `desc` | `asc` \| `desc` |

Unrecognized enum/sort/direction values fail validation (US4). Malformed
cursor is a service-level 400, not a pipe 400, so the message can be a
stable "Invalid cursor" without leaking payload contents.

## 10. Rate limiting

**Decision**: `@Throttle({ default: { limit: 30, ttl: 60000 } })` on
`GET /users`. Global throttler remains (`THROTTLE_GLOBAL_TTL` 10s /
`THROTTLE_GLOBAL_LIMIT` 10 as APP_GUARD). The per-route override is the
named `default` throttler used everywhere else in this controller.

**Rationale**: Directory listing is a privileged bulk PII read (FR-016).
30 pages/minute is enough for an administrator paging through results and
stricter than the global ~60/minute. Numbers follow the controller's
existing `@Throttle` style rather than inventing a unique policy (spec
assumption).

**Alternatives considered**: Global-only (like `GET /users/:userId`) —
weaker against scraping. A much tighter limit (e.g. 10/min) would hinder
legitimate paging.

## 11. Audit logging

**Decision**: New `UserDirectoryAuditEvent` + `UserDirectoryAuditService` in
`src/modules/users/`, mirroring `AccountDeletionAuditService` /
`ProfileAuditService` (fire-and-log, never throws, never stores PII).

| Column | Content |
|---|---|
| `actorId` | UUID, **nullable** (unauthenticated attempts) |
| `outcome` | `success` \| `denied` \| `unauthenticated` \| `invalid` \| `rate_limited` |
| `resultCount` | integer, nullable (set only on `success`) |
| `searchUsed` | boolean |
| `statusFilterUsed` | boolean |
| `sortField` | `createdAt` \| `lastLoginAt` \| `email` \| null when the request never reached option parsing |
| `createdAt` | timestamptz |

Never persist search text, email values, cursors, or item payloads.

**Where each outcome is written:**

| Outcome | Writer |
|---|---|
| `success`, `denied` | list handler only |
| `invalid`, `unauthenticated`, `rate_limited` | `UserDirectoryAuditFilter` (single writer for all three) |

The filter is registered as a global `APP_FILTER` and gates on `GET` +
collection path `/users` (no extra segments). It catches
`BadRequestException` (ValidationPipe enum/limit failures and cursor
`Invalid cursor`), `UnauthorizedException` (`JwtAuthGuard`), and
`ThrottlerException` (global `ThrottlerGuard`). It does **not** catch
`ForbiddenException` (handler already recorded `denied`).

The list handler MUST NOT call `record()` for cursor 400s — rethrow
`BadRequestException` and let the filter write `invalid` once.
Option-kind flags on filter-written rows use query-parameter presence
only (no search text, no emails); null if the query is unavailable.

**Rationale**: FR-018 requires 401 and 429 rows, but those exceptions are
thrown by guards before the handler. This repo has no existing exception
filters; a path-gated global `APP_FILTER` is the minimum hook that can
observe them without changing `JwtAuthGuard` or the global throttler.
A controller-scoped `@UseFilters` is **not** sufficient for 429:
`ThrottlerGuard` is `APP_GUARD` in `AppModule`, and controller filters
often never see that exception. Path gating prevents the filter from
auditing unrelated routes. Best-effort: a failed audit write must not
change the HTTP outcome (spec assumption).

**Alternatives considered**: Skipping 401/429 in the directory table
(violates FR-018). Subclassing `JwtAuthGuard` (too invasive). A generic
audit interceptor for all routes (out of scope).

## 12. Indexes (Principle III)

**Decision**: Partial indexes on listable rows only
(`WHERE deletion_started_at IS NULL`):

1. `(created_at DESC, id DESC)` — default sort / keyset.
2. `(email, id)` — email sort / keyset (citext).
3. `(last_login_at DESC, id DESC)` — last-sign-in sort; query specifies
   `NULLS LAST`/`NULLS FIRST` explicitly.

PK covers exact id search. No trgm index in this feature (see §7).

## 13. Tests

**Decision**: Colocated unit specs for `UserDirectoryService` (keyset,
filters, allow-list, cursor HMAC, NULL sort) and
`UserDirectoryAuditService`. E2E: `test/users-directory.e2e-spec.ts`
following `test/users-profile.e2e-spec.ts` / `test/account-deletion.e2e-spec.ts`
(real JWT cookies, seeded Admin grant vs `users.read`-only vs anonymous).

**Rationale**: Constitution Principle IV; existing users e2e helpers already
show how to mint roles/grants and call `AccessConfigService.reload()`.

## 14. Error handling

**Decision**: Built-in Nest exceptions only — `UnauthorizedException` (401,
JwtAuthGuard), `ForbiddenException` (403), `BadRequestException` (400 for
invalid query/cursor). `ThrottlerGuard` → 429. No custom exception classes.

Messages stay generic (`Insufficient permissions`, `Invalid cursor`,
`Authentication required`) and never include search text or account data.
