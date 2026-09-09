# Data Model: Delete User Account

## Modified entity: `User` (`src/modules/users/entities/user.entity.ts`)

Add one nullable column, no other changes.

| Field | Type | Notes |
|-------|------|-------|
| `deletionStartedAt` | `timestamptz`, nullable | New. Set atomically (`UPDATE ... WHERE deletion_started_at IS NULL`) the instant a deletion transaction claims the row. Never read anywhere except the deletion code path — not a general status field. Cleared implicitly by the row being deleted (no rollback-to-null path needed since a claim that doesn't complete only happens on transaction rollback, which un-sets it for free). |

No change to `UserStatus` enum, `photoUrl`, or any other existing column.

## New entity: `AccountDeletionChallenge`

Table `account_deletion_challenges`. Mirrors `EmailChangeChallenge` field-for-field except it has
no "new value" column (deletion has nothing analogous to `newEmail`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `uuid`, PK | |
| `userId` | `uuid`, FK → `users.id`, `ON DELETE CASCADE` | |
| `otpHash` | `varchar(64)` | sha256 of the 6-digit OTP, via `generateConfirmationTokens()` |
| `linkTokenHash` | `varchar(64)`, indexed | sha256 of the base64url link token |
| `issuedAt` | `timestamptz`, default `now()` | |
| `lastSentAt` | `timestamptz`, default `now()` | resend-cooldown anchor |
| `expiresAt` | `timestamptz` | `issuedAt + CONFIRMATION_TTL_MS` (10 min) |
| `attemptsRemaining` | `smallint`, default 5 | decremented on each wrong confirm attempt |
| `invalidatedAt` | `timestamptz`, nullable | set when superseded by a newer challenge |
| `consumedAt` | `timestamptz`, nullable | set when successfully confirmed |
| `createdAt` | `timestamptz`, default `now()` | |

**Index**: partial unique index `idx_account_deletion_challenges_active` on `(userId)` `WHERE
invalidated_at IS NULL AND consumed_at IS NULL` — enforces one active pending self-deletion request
per user, identical to `idx_email_change_challenges_active`.

**Lifecycle**: created by `initiate()`; invalidated and replaced by `resend()` (regenerates
tokens, same row semantics as `EmailChangeChallenge.resend`); consumed by `confirm()` on success.
Cascade-deleted automatically when the `users` row is deleted (whether via this same confirm
transaction or an admin delete that races it — either way the row disappears, which is correct).

## New entity: `AccountDeletionAuditEvent`

Table `account_deletion_audit_events`. Mirrors `ProfileAuditEvent` shape; intentionally has **no**
FK to `users` (must remain queryable after the target user row no longer exists).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `uuid`, PK | |
| `actorId` | `uuid` | the authenticated caller performing the action |
| `targetId` | `varchar` | the account being deleted; not a FK (tolerates post-deletion lookups) |
| `action` | `enum AccountDeletionAuditAction` | see below |
| `outcome` | `enum AccountDeletionAuditOutcome` | `success \| denied \| failure \| not_found \| conflict` |
| `createdAt` | `timestamptz`, default `now()` | |

```ts
enum AccountDeletionAuditAction {
  SELF_DELETE_INITIATED = 'self_delete_initiated',
  SELF_DELETE_RESENT = 'self_delete_resent',
  SELF_DELETE_CONFIRMED = 'self_delete_confirmed',
  SELF_DELETE_FAILED = 'self_delete_failed',
  ADMIN_DELETE = 'admin_delete',
}

enum AccountDeletionAuditOutcome {
  SUCCESS = 'success',
  DENIED = 'denied',
  FAILURE = 'failure',
  NOT_FOUND = 'not_found',
  CONFLICT = 'conflict',
}
```

Self- vs. admin-initiated is encoded in the `action` value itself (`SELF_DELETE_*` vs.
`ADMIN_DELETE`), matching the existing convention (`EMAIL_CHANGE_CONFIRMED` vs.
`ADMIN_EMAIL_UPDATE`) — no separate boolean column is needed. **No PII values (email, photo
contents, etc.) are ever written to this table**, satisfying FR-014/SC-005.

**Index**: `idx_account_deletion_audit_actor_created` on `(actorId, createdAt)`, matching
`idx_profile_audit_actor_created`.

## Permission model change

The existing `users` permission row (`permissions.name = 'users'`) gains a new action:

- **Before**: `actions = ['read', 'update', 'update-email']`
- **After**: `actions = ['read', 'update', 'update-email', 'delete']`

The `admin` role's `grants` row for the `users` permission is updated (or inserted, if its
`actions` override is non-null and doesn't already include everything) to include `'delete'`,
following the exact pattern in `1760100000000-AdminUsersReadGrant.migration.ts`.

## Redaction of pre-existing PII in unrelated audit tables

`login_audit_events.normalized_email` and `registration_audit_events.normalized_email` store the
user's plaintext (case-normalized) email and are **not** cleared by the `user_id` FK's
`ON DELETE SET NULL` — only the FK column is nulled, the email string remains. To satisfy FR-009
("MUST NOT retain the deleted personal data itself"), the shared deletion procedure additionally
nulls `normalized_email` on both tables for the target `userId`, in the same transaction, before
the `users` row is removed.

## State transitions (self-deletion challenge)

```
(none) --initiate()--> active (invalidated_at=NULL, consumed_at=NULL)
active --resend()--> active (new tokens, same row semantics as email-change resend: old row invalidated, new row created)
active --confirm() success--> consumed (consumed_at=now()); users row + all cascaded rows deleted in the same transaction
active --confirm() wrong code--> active (attemptsRemaining -= 1)
active --attemptsRemaining reaches 0--> active row remains but further confirm attempts are rejected (attemptsRemaining <= 0 check), matching EmailChangeChallenge.confirm behavior
active --expiresAt elapses--> treated as expired on next confirm/resend attempt (isExpired check), matching EmailChangeChallenge
```

## State transitions (`User.deletionStartedAt`)

```
NULL --claim (self-confirm or admin-delete transaction start)--> now()  [atomic UPDATE ... WHERE deletion_started_at IS NULL]
now() --transaction commits--> row deleted (column moot, row gone)
now() --transaction rolls back (e.g., file-delete or later step throws)--> NULL (rollback restores it)
```

A second concurrent deletion attempt observing `deletionStartedAt IS NOT NULL` (0 rows affected by
the claim UPDATE) is reported as a conflict (409) if the user still exists, or "already removed"
if a prior transaction already completed and the row is gone (FR-010, FR-011).
