# Research: Delete User Account

All unknowns from the Technical Context are resolved by reusing existing, already-proven patterns
in this codebase rather than introducing new mechanisms. No NEEDS CLARIFICATION items remain.

## 1. Self-deletion confirmation mechanism

- **Decision**: Reuse the email-change challenge pattern verbatim. Add a new
  `AccountDeletionChallenge` entity/table mirroring `EmailChangeChallenge`
  (`src/modules/users/entities/email-change-challenge.entity.ts`): OTP + link token, both
  sha256-hashed, `expiresAt` (10 min, `CONFIRMATION_TTL_MS`), `attemptsRemaining` (default 5),
  `lastSentAt` (60s resend cooldown, `RESEND_INTERVAL_MS`), `invalidatedAt`/`consumedAt`, and a
  partial unique index enforcing one active challenge per user.
- **Rationale**: FR-003 and the spec's Assumptions explicitly require reusing "the same style of
  emailed code/link, expiry window, attempt limit, and resend cooldown already established... for
  other sensitive account changes." `src/modules/auth/utils/confirmation-token.ts` already
  centralizes `generateConfirmationTokens()` and the TTL/cooldown constants — no new token logic
  is needed, only a new entity/service that calls the same utility.
- **Alternatives considered**: A generic/shared "confirmation challenge" table covering all flows
  (email-change, deletion, password-reset) was considered but rejected — the codebase already has
  three independent per-flow challenge entities (`EmailChangeChallenge`,
  `password-reset-challenge.entity.ts`, `confirmation-challenge.entity.ts`); unifying them is a
  cross-cutting refactor out of scope for this feature and would violate the "don't refactor
  beyond what the task requires" guidance.

## 2. Detecting/rejecting concurrent or repeat deletions (idempotency + conflict)

- **Decision**: Add a nullable `deletion_started_at timestamptz` column to `users`. Both the
  self-confirm and admin-delete code paths first execute an atomic
  `UPDATE users SET deletion_started_at = now() WHERE id = :id AND deletion_started_at IS NULL`
  inside the `@Transactional()` deletion method. If zero rows are affected, a second `SELECT`
  determines the outcome: user no longer exists → report "already removed" (idempotent, FR-010);
  user exists with `deletion_started_at` already set → report conflict (FR-011). If one row is
  affected, the same transaction proceeds to delete owned files, personal data, and the user row.
- **Rationale**: The spec's Assumptions explicitly scope this to "a brief in-progress 'deleting'
  state... solely to detect and reject overlapping duplicate requests... not a long-running
  asynchronous job queue" — i.e., deletion is synchronous and single-transaction, so the flag only
  needs to survive for the lifetime of one transaction plus protect against a concurrent second
  transaction via the `WHERE ... IS NULL` guard (equivalent to a row-level compare-and-set).
- **Alternatives considered**: Adding a new `UserStatus.DELETING` enum value was rejected because
  altering a Postgres `enum` type requires a more invasive migration (`ALTER TYPE ... ADD VALUE`
  cannot run inside the same transaction as its first use) and the status enum is also read by
  `JwtAuthGuard` for unrelated `ACTIVE` checks — a nullable timestamp column is additive, requires
  no changes to existing status-based checks, and is trivial to add via a normal `ADD COLUMN`.

## 3. Admin permission check style

- **Decision**: Add a new `'delete'` action to the existing `users` permission's `actions` array
  (currently `['read', 'update', 'update-email']`, set in
  `1760000000000-EmailChangeAndProfileUpdate.migration.ts` and
  `1760100000000-AdminUsersReadGrant.migration.ts`) and grant it to the `admin` role via a new
  migration following the exact `UPDATE permissions.actions` / `UPDATE grants.actions` pattern in
  `1760100000000-AdminUsersReadGrant.migration.ts`. The controller checks the permission inline via
  `accessConfigService.hasPermission(request.user.roles, 'users', 'delete')`, matching the
  existing inline-check style already used for `'update'`/`'update-email'` in
  `users.controller.ts` (NOT the `@RequirePermission`/`PermissionGuard` decorator style used
  elsewhere in the RBAC module).
- **Rationale**: `UsersController` never uses the decorator/guard style for its own routes; staying
  consistent with the file's existing convention (per Principle I, Modular Architecture, and to
  avoid mixing two authorization styles in the same controller) outweighs adopting the
  decorator style used in other modules.
- **Alternatives considered**: A hardcoded `role === 'admin'` check was rejected — roles/permissions
  are data-driven in this system (`RbacModule`), and the spec's Assumptions require deletion rights
  to come "through the system's existing role/permission model, as a distinct permission."

## 4. Revoking access immediately on deletion (no server-side session store)

- **Decision**: Rely entirely on deleting the `users` row. `JwtAuthGuard`
  (`src/modules/auth/guards/jwt-auth.guard.ts`) already loads the `User` row on every request and
  rejects (401) if it is missing or not `ACTIVE`; once the row is deleted, the very next request
  bearing the old access token is rejected. No new session/token revocation list is introduced.
- **Rationale**: The codebase is stateless-JWT only — the historical `sessions` table was
  intentionally dropped in `1758000000000-JwtSessionAuth.migration.ts` in favor of short-lived
  (15 min) access tokens verified against the live `User` row on each request. Adding a revocation
  list would be new cross-cutting infrastructure disproportionate to this feature; the existing
  per-request user lookup already satisfies FR-007 ("immediately and permanently prevent... from
  authenticating again") because deletion removes the row the guard depends on.
- **Residual limitation (documented, not fixed by this feature)**: an access token issued *before*
  deletion remains cryptographically valid until its 15-minute expiry, but every request using it
  will fail at the `JwtAuthGuard`'s user-lookup step once the row is gone, so it cannot be used to
  access or mutate anything — this satisfies "no further login/access" in practice without a
  dedicated blocklist.

## 5. Removing PII and owned files

- **Decision**: Inside the same deletion transaction: (a) delete the profile photo file via
  `LocalFileStorageService.delete()` (`src/core/storage/local-file-storage.service.ts`), reusing
  `UsersService.toRelativeAssetPath` to convert `photoUrl` back to a relative path, matching the
  existing best-effort delete pattern used in `updatePhoto`; (b) delete rows that are wholly
  personal to the user and carry PII — `EmailChangeChallenge` (already `ON DELETE CASCADE` via its
  FK) and the new `AccountDeletionChallenge` (same FK cascade) — via the user row's cascade delete;
  (c) delete the `users` row itself, which cascades `user_roles` (membership is meaningless once
  the user is gone); (d) leave audit-event tables (`profile_audit_events`,
  `user_profile_audit_events`, `login_audit_events`, `rbac_audit_events`) untouched — they already
  store only `actorId`/`targetId` UUIDs and non-PII metadata (per Section 7 of the investigation),
  never raw PII, and their `target_id`/`actor_id` columns are plain `varchar`/`uuid` with no FK
  constraint, so they tolerate referencing a deleted user without breaking (satisfies FR-009).
- **Rationale**: The spec's Assumptions explicitly distinguish "records... personal to the user
  (e.g., their own profile), which is fully removed" from other related records "preserved... with
  personal data detached." Existing audit tables were already designed field-name/UUID-only
  (no PII payloads), so no anonymization step is needed for them — they already comply.
- **Alternatives considered**: Cascading deletes onto audit tables was rejected — it would violate
  FR-014/SC-005 (deletion must remain traceable to actor/target/outcome after the fact) and the
  spec's explicit requirement that audit trails survive deletion.

## 6. Audit logging for deletion attempts

- **Decision**: Add a new `AccountDeletionAuditEvent` entity + `AccountDeletionAuditService`,
  mirroring `ProfileAuditEvent`/`ProfileAuditService` exactly (`actorId`, `targetId`, `action`
  enum, `outcome` enum, `createdAt`), with actions covering
  `SELF_DELETE_INITIATED | SELF_DELETE_RESENT | SELF_DELETE_CONFIRMED | SELF_DELETE_FAILED |
  ADMIN_DELETE`. Whether an event is self- or admin-initiated is derivable from the action itself
  (no extra column needed, consistent with how existing audit actions like
  `ADMIN_EMAIL_UPDATE` vs `EMAIL_CHANGE_CONFIRMED` already encode actor type in the action name).
  Recording follows the existing best-effort/try-catch pattern in
  `UsersService.recordAudit` (users.service.ts:172-182) — audit failures must never affect the
  response.
- **Rationale**: No generic/shared audit module exists in this codebase; every feature rolls its
  own audit entity following one consistent shape. FR-014 requires capturing actor, target,
  self/admin, and outcome without PII — the action-name convention already used elsewhere encodes
  self/admin without a redundant boolean column.
- **Alternatives considered**: Extending `ProfileAuditEvent`'s existing `action` enum with deletion
  actions instead of a new table was considered, but rejected — deletion audit entries must survive
  even after the user row (and any FK-cascaded rows) are gone; keeping it as its own table with no
  FK to `users` (matching `profile_audit_events`'s own `target_id: varchar` design) keeps this
  independent of the entity being deleted and avoids conflating an unrelated feature's audit
  action enum with this one.

## 7. Rate limiting

- **Decision**: Reuse `@nestjs/throttler`'s per-route `@Throttle({ default: { limit, ttl } } )`
  decorator, matching the existing values used for the analogous email-change endpoints in
  `users.controller.ts`: initiate self-delete `{ limit: 3, ttl: 600000 }` (10 min), resend
  `{ limit: 1, ttl: 60000 }` (1 min), confirm `{ limit: 5, ttl: 60000 }` (1 min), admin-direct
  delete `{ limit: 5, ttl: 60000 }` (1 min, matching `updateEmailDirect`'s admin route).
- **Rationale**: FR-013 requires rate limiting without specifying exact numbers; matching sibling
  endpoints already in this controller keeps rate-limit posture consistent across similarly
  sensitive account-mutation routes, per Principle II (throttler MUST protect abuse-prone
  endpoints).
- **Alternatives considered**: Per-user (rather than per-IP, the throttler default) limiting was
  considered but rejected as out of scope — no existing endpoint in this codebase does per-user
  throttling; introducing it here would be inconsistent with every sibling endpoint.

## 8. Migration sequencing

- **Decision**: One new migration, timestamped after the latest existing migration
  (`1760100000000-AdminUsersReadGrant.migration.ts`), e.g.
  `1760200000000-AccountDeletion.migration.ts`, combining: `account_deletion_challenges` table +
  partial unique index, `account_deletion_audit_events` table + enum types, `deletion_started_at`
  column on `users`, and the `users` permission's `actions` array / admin grant update — following
  the combined-migration style of `1760000000000-EmailChangeAndProfileUpdate.migration.ts` (which
  also did table + audit table + permission/grant changes in one migration).
