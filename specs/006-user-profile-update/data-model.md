# Phase 1 Data Model: User Profile Update

## Entity: `User` (existing — modified)

`src/modules/users/entities/user.entity.ts` — no new columns required; `photo_url` and `email` already exist. Behavior added:
- `photoUrl` is overwritten (not versioned) on successful photo upload.
- `email` is overwritten on successful email-change confirmation (self) or admin direct update.

## Entity: `EmailChangeChallenge` (new)

Table `email_change_challenges`. Mirrors `PasswordResetChallenge` with one addition (`newEmail`, `lastSentAt`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | `gen_random_uuid()` |
| `user_id` | uuid, FK → `users.id`, `ON DELETE CASCADE` | requester |
| `new_email` | citext | the requested new address; re-checked for uniqueness at confirm time too (race-safety) |
| `otp_hash` | varchar(64) | sha256 hex of the 6-digit OTP |
| `link_token_hash` | varchar(64), indexed | sha256 hex of the magic-link token |
| `issued_at` | timestamptz | set on creation and on resend |
| `last_sent_at` | timestamptz | updated on initiate and resend; drives the resend cooldown (FR-016) |
| `expires_at` | timestamptz | `issued_at + CONFIRMATION_TTL_MS` (10 min) |
| `attempts_remaining` | smallint, default 5 | decremented on each wrong-code confirm attempt (FR-015) |
| `invalidated_at` | timestamptz, nullable | set when superseded by a newer request (FR-017) |
| `consumed_at` | timestamptz, nullable | set on successful confirmation (single-use, FR-013) |
| `created_at` | timestamptz | audit trail |

**Indexes**:
- Partial unique index `idx_email_change_challenges_active` on `(user_id)` `WHERE invalidated_at IS NULL AND consumed_at IS NULL` — enforces "at most one active pending request per user" (FR-017) at the DB level, same pattern as `idx_password_reset_challenges_active`.
- Index on `link_token_hash` for confirm-by-link lookups.

**Validation rules**:
- `new_email` MUST pass email format validation before the challenge is created (FR-010).
- `new_email` MUST NOT equal any other user's current `email` at creation time (FR-009) — re-checked at confirm time inside the same transaction to close the TOCTOU window.
- A confirm attempt is rejected if: no active (non-invalidated, non-consumed) challenge exists for the user, `expires_at` has passed, `attempts_remaining <= 0`, or the supplied code/token hash matches neither `otp_hash` nor `link_token_hash` (FR-014).
- A resend is rejected if `now - last_sent_at < RESEND_INTERVAL_MS` (FR-016).

**State transitions**: `active` → `consumed` (success, terminal) | `active` → `invalidated` (superseded by new request, or expired — expiry is evaluated lazily at confirm/resend time, not via a background sweep, matching `PasswordResetService`'s approach of checking `isExpired` on read rather than eagerly invalidating).

## Entity: `ProfileAuditEvent` (new)

Table `profile_audit_events`. One row per profile-update / email-change lifecycle event.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `actor_id` | uuid | who performed the action (self or admin) |
| `target_id` | varchar | whose profile was affected (not FK, mirrors `user_profile_audit_events.target_id`, so a not-found target ID is still recorded) |
| `action` | enum | `profile_update`, `email_change_initiated`, `email_change_sent`, `email_change_resent`, `email_change_confirmed`, `email_change_failed`, `email_change_expired`, `admin_email_update` |
| `outcome` | enum | `success`, `denied`, `failure`, `not_found` |
| `fields` | text[] | field *names* only (e.g. `{photo}`, `{email}`) — never values (FR-020) |
| `created_at` | timestamptz | |

**Indexes**: `idx_profile_audit_actor_created` on `(actor_id, created_at)` — mirrors `idx_user_profile_audit_viewer_created`.

**Write pattern**: best-effort, always wrapped in try/catch by the calling service so an audit-write failure never blocks or fails the primary operation (matches `UsersService.recordAudit`).

## Permission model changes

`permissions` row `name = 'users'` (added by migration `1759900000000-UsersProfile`) gets its `actions` array extended from `['read']` to `['read', 'update', 'update-email']`. A new migration grants `update` and `update-email` to the `admin` role via a `grants` row (or extends the existing admin grant's `actions` if one already exists for `users`).

## Response shape (reused)

`UserProfileResponseDto` (existing, `src/modules/users/dto/user-profile-response.dto.ts`) is reused for all success responses (FR-023): self-view/self-update shape includes `id, photo, email, status, createdAt`; privileged/admin shape includes `id, photo` (extend if admin needs to see `email` post-update — see `contracts/users-profile-update.md` for the exact per-endpoint shape).
