# Data Model: User Login & Session Authentication

All new tables follow the existing conventions in `src/database/migrations/` (uuid PKs via
`gen_random_uuid()`, `timestamptz` columns, snake_case column names mapped from camelCase
TypeORM properties, partial indexes for "active row" lookups).

## Modified entity

### `User` (`src/modules/users/entities/user.entity.ts`)

New columns:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `failed_login_attempts` | smallint | `0` | Consecutive failed logins since the last success (FR-008) |
| `locked_until` | timestamptz, nullable | `NULL` | Set when the account is temporarily locked; cleared on next successful login |

Behavior:
- Any failed login (wrong password or unknown-but-normalized-to-existing... N/A for unknown
  email, see Login Attempt Record) increments `failed_login_attempts` on the matched user row.
- On `failed_login_attempts` reaching 5, `locked_until = now() + 15 minutes`.
- A successful login resets `failed_login_attempts` to `0` and `locked_until` to `NULL`.
- A password reset also resets both (a completed reset is a strong signal the legitimate owner
  regained control).

No new index needed — lockout checks happen on the row already fetched by the unique `email`
index.

## New entities

### `Session` → table `sessions`

Represents an issued, potentially still-valid authenticated session (Key Entity: "Authenticated
Session").

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid, FK → `users.id`, `ON DELETE CASCADE` | Owning user |
| `token_hash` | varchar(64), unique | SHA-256 hex of the opaque cookie token |
| `issued_at` | timestamptz | `now()` |
| `expires_at` | timestamptz | `issued_at + 24h` (fixed TTL, see research.md §7) |
| `invalidated_at` | timestamptz, nullable | Set on logout or on password reset (invalidate-others) |
| `ip_address` | inet, nullable | For audit/diagnostics |
| `user_agent` | text, nullable | For audit/diagnostics |
| `created_at` | timestamptz | `now()` |

Indexes:
- Unique index on `token_hash` (session lookup on every authenticated request).
- Partial index `idx_sessions_active` on `user_id` `WHERE invalidated_at IS NULL` (used to
  invalidate all of a user's other sessions on password reset, FR-015).

Validity rule: a session is usable iff `invalidated_at IS NULL AND expires_at > now()`.

### `LoginChallenge` → table `login_challenges`

Represents a login attempt that passed password verification and is awaiting sign-in
confirmation (Key Entity: "Pending Login Verification"). Shape mirrors
`ConfirmationChallenge`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid, FK → `users.id`, `ON DELETE CASCADE` | |
| `otp_hash` | varchar(64) | SHA-256 of the one-time code |
| `link_token_hash` | varchar(64) | SHA-256 of the magic-link token |
| `issued_at` | timestamptz | |
| `expires_at` | timestamptz | `issued_at + CONFIRMATION_TTL_MS` (10 min) |
| `attempts_remaining` | smallint | Default 5 |
| `invalidated_at` | timestamptz, nullable | Set if superseded by a newer login attempt |
| `consumed_at` | timestamptz, nullable | Set when the challenge is confirmed |
| `created_at` | timestamptz | |

Indexes: partial index on `user_id` `WHERE invalidated_at IS NULL AND consumed_at IS NULL`
(active challenge lookup); index on `link_token_hash`.

### `PasswordResetChallenge` → table `password_reset_challenges`

Represents an outstanding password-reset request (Key Entity: "Password Reset Request"). Same
shape as `LoginChallenge`/`ConfirmationChallenge`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid, FK → `users.id`, `ON DELETE CASCADE` | |
| `otp_hash` | varchar(64) | |
| `link_token_hash` | varchar(64) | |
| `issued_at` | timestamptz | |
| `expires_at` | timestamptz | `issued_at + CONFIRMATION_TTL_MS` (10 min) |
| `attempts_remaining` | smallint | Default 5 |
| `invalidated_at` | timestamptz, nullable | Set if superseded by a newer reset request |
| `consumed_at` | timestamptz, nullable | Set once the new password has been applied (prevents reuse, FR-013) |
| `created_at` | timestamptz | |

Indexes: same pattern as `login_challenges`.

### `LoginAuditEvent` → table `login_audit_events`

Represents one recorded login/session-lifecycle event (Key Entity: "Login Attempt Record"),
structurally identical to `RegistrationAuditEvent`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `event_type` | enum | `login_attempt`, `login_verification_attempt`, `logout`, `password_reset_requested`, `password_reset_attempt` |
| `outcome` | enum | `success`, `failure`, `locked_out` |
| `normalized_email` | citext | Target email, even when the account doesn't exist (no-enumeration logging) |
| `user_id` | uuid, FK → `users.id`, `ON DELETE SET NULL`, nullable | |
| `ip_address` | inet, nullable | |
| `user_agent` | text, nullable | |
| `failure_reason` | varchar(100), nullable | e.g. `invalid_credentials`, `locked_out`, `email_not_confirmed`, `expired_code`, `wrong_code`, `attempts_exhausted` |
| `metadata` | jsonb | |
| `created_at` | timestamptz | |

Indexes: `(normalized_email, created_at)`, `(event_type, created_at)` — same as
`registration_audit_events`.

## Entity relationship summary

```text
users 1──* sessions
users 1──* login_challenges
users 1──* password_reset_challenges
users 1──0..1 login_audit_events.user_id (nullable FK; email-only rows keep user_id NULL)
user_roles / roles (existing RBAC tables) — read (not written) by SessionAuthGuard to populate
  request.user.roles
```

## State transitions

**Session**: `active` (issued, not expired, not invalidated) → `expired` (past `expires_at`) |
`invalidated` (logout, or password reset invalidating other sessions). Terminal once expired or
invalidated; a new login always issues a new session row.

**LoginChallenge / PasswordResetChallenge**: `pending` → `consumed` (verified successfully,
terminal) | `invalidated` (superseded by a newer request for the same user, terminal) | implicitly
`expired` once `now() > expires_at` (checked at read time, no separate column transition).

**User lockout**: `normal` (`locked_until IS NULL`) → `locked` (`locked_until` in the future,
set once `failed_login_attempts` reaches 5) → `normal` again once `locked_until` elapses or a
password reset completes.
