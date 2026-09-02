# Data Model: User Registration

**Feature**: `001-user-registration`  
**Date**: 2026-09-01

## Entity Relationship Overview

```text
system_settings (singleton)
       │
       │ read at registration time
       ▼
users ◄──── confirmation_challenges (0..1 active per pending user)
  │
  └── registration_audit_events (0..N)
```

---

## 1. User (`users`)

Represents a registered person. May be usable (`active`) or awaiting confirmation (`pending_confirmation`).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | |
| `email` | `citext` | NOT NULL, UNIQUE | Normalized: trim + lowercase before insert |
| `password_hash` | `varchar(255)` | NOT NULL | bcrypt hash; never exposed |
| `status` | `enum` | NOT NULL, default `pending_confirmation` | `pending_confirmation` \| `active` |
| `pending_expires_at` | `timestamptz` | NULL when `active` | Set on registration/resend; 24 h from last confirmation email |
| `confirmed_at` | `timestamptz` | NULL until confirmed | Set when status → `active` via confirmation |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | |

**Indexes**:
- UNIQUE on `email`
- INDEX on `status` WHERE `status = 'pending_confirmation'` (partial, for expiry cleanup queries)

**Validation rules** (service layer):
- Email must pass RFC 5322–practical regex / `class-validator` `@IsEmail()`
- Password validated against `PasswordPolicy` before hashing
- Cannot transition to `active` without valid confirmation when registration confirmation is enabled
- When confirmation disabled, created directly as `active` with `confirmed_at = now()`, `pending_expires_at = NULL`

**State transitions**:

```text
[confirmation OFF]  (register) ──► active

[confirmation ON]   (register) ──► pending_confirmation
                    (confirm OK) ──► active
                    (expire 24h) ──► (row deleted or status expired — see note)

Note: On expiry, implementation deletes the pending user row (or marks expired)
so the email can be reused (FR-020). Audit events retained with user_id nullable.
```

---

## 2. Confirmation Challenge (`confirmation_challenges`)

Current OTP + magic link for a pending user. At most one non-invalidated challenge per user.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `user_id` | `uuid` | FK → `users.id`, NOT NULL, ON DELETE CASCADE | |
| `otp_hash` | `varchar(64)` | NOT NULL | SHA-256 of 6-digit OTP |
| `link_token_hash` | `varchar(64)` | NOT NULL | SHA-256 of base64url token |
| `issued_at` | `timestamptz` | NOT NULL, default `now()` | |
| `expires_at` | `timestamptz` | NOT NULL | `issued_at + 10 minutes` |
| `attempts_remaining` | `smallint` | NOT NULL, default `5` | Decremented on wrong OTP |
| `last_sent_at` | `timestamptz` | NOT NULL | Used for 60 s resend gate |
| `invalidated_at` | `timestamptz` | NULL | Set on resend, successful confirm, or manual invalidation |
| `consumed_at` | `timestamptz` | NULL | Set on successful confirmation |
| `created_at` | `timestamptz` | NOT NULL | |

**Indexes**:
- INDEX on `(user_id)` WHERE `invalidated_at IS NULL AND consumed_at IS NULL`
- INDEX on `link_token_hash` (lookup on magic-link confirm)

**Validation rules**:
- OTP verify: reject if `now() > expires_at`, `attempts_remaining = 0`, or `invalidated_at`/`consumed_at` set
- Link verify: reject if expired, consumed, or invalidated
- Successful confirm sets `consumed_at`, invalidates challenge, activates user — single transaction

---

## 3. System Settings (`system_settings`)

Singleton configuration row (`id = 1`).

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | `smallint` | `1` | PK; CHECK `id = 1` |
| `registration_confirmation_enabled` | `boolean` | `false` | FR-008, FR-017 |
| `password_recovery_confirmation_enabled` | `boolean` | `false` | Stored only; not used by this feature |
| `sign_in_confirmation_enabled` | `boolean` | `false` | Stored only; not used by this feature |
| `password_min_length` | `smallint` | `8` | FR-004 |
| `password_require_uppercase` | `boolean` | `false` | FR-004 |
| `password_require_digit` | `boolean` | `false` | FR-004 |
| `password_require_special` | `boolean` | `false` | FR-004 |
| `updated_at` | `timestamptz` | `now()` | |

**Seed**: Migration inserts row `id=1` with defaults above.

---

## 4. Registration Audit Event (`registration_audit_events`)

Append-only security/audit log.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` | PK | |
| `event_type` | `enum` | NOT NULL | See enum below |
| `outcome` | `enum` | NOT NULL | `success` \| `failure` |
| `normalized_email` | `citext` | NOT NULL | For operator lookup |
| `user_id` | `uuid` | FK nullable | NULL if no user row created |
| `ip_address` | `inet` | NULL | From request |
| `user_agent` | `text` | NULL | Truncated to 512 chars |
| `failure_reason` | `varchar(100)` | NULL | e.g. `duplicate_email`, `invalid_password`, `expired_code` |
| `metadata` | `jsonb` | default `{}` | Extra non-secret context |
| `created_at` | `timestamptz` | NOT NULL | |

**`event_type` enum**:
- `registration_attempt`
- `confirmation_email_sent`
- `confirmation_attempt` (code or link)

**Indexes**:
- INDEX on `(normalized_email, created_at DESC)` — rate-limit queries
- INDEX on `(event_type, created_at DESC)` — operator dashboards

**Never store**: raw password, raw OTP, raw link token, password hash.

---

## Cross-Entity Rules

| Rule | Source |
|------|--------|
| One usable account per normalized email | FR-005, SC-003 |
| Pending registration re-register same email → no second row; resend path | Edge case spec |
| Admin disables registration confirmation → new registrations skip pending state | US-6 |
| Pending registrations stay pending when flag turned off | US-6 acceptance #4 |
| Confirmation email cap: 5 per email per 10 min | SC-007, assumptions |
| Resend min interval: 60 s from `last_sent_at` | FR-013 |
| OTP TTL: 10 min; max 5 wrong attempts | FR-010 |
| Link TTL: 10 min; single use | FR-011 |
| Pending TTL: 24 h from last confirmation email | FR-020 |

---

## TypeORM Entity Files (implementation reference)

```text
src/modules/users/entities/user.entity.ts
src/modules/auth/entities/confirmation-challenge.entity.ts
src/modules/auth/entities/registration-audit-event.entity.ts
src/modules/settings/entities/system-settings.entity.ts
```
