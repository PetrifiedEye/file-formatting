# Phase 1 Data Model: View User Profile

## Entities

### User (modified)

Existing entity: `src/modules/users/entities/user.entity.ts`, table `users`.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | unchanged |
| `email` | `citext`, unique | unchanged |
| `passwordHash` | `varchar(255)` | unchanged — never returned in any profile response |
| `status` | enum (`pending_confirmation`, `active`) | unchanged |
| `pendingExpiresAt` | `timestamptz`, nullable | unchanged |
| `confirmedAt` | `timestamptz`, nullable | unchanged |
| `createdAt` / `updatedAt` | `timestamptz` | unchanged |
| `failedLoginAttempts` | `smallint` | unchanged |
| `lockedUntil` | `timestamptz`, nullable | unchanged |
| **`photoUrl`** | `varchar`, nullable | **NEW** — column `photo_url`; URL reference to the user's profile photo, `null` if unset. Added via migration. |

No other new profile fields are introduced — spec FR-011 only names `email` and
`photo` explicitly; "other profile fields" in the self view maps to the existing
non-sensitive columns already on `User` (`id`, `email`, `photoUrl`, `status`,
`createdAt`). `passwordHash`, `failedLoginAttempts`, `lockedUntil`,
`pendingExpiresAt`, `confirmedAt` are operational/security fields, not profile
fields, and MUST NOT appear in either response shape.

### Profile Field Visibility Policy (code-level, not a DB entity)

Implemented as two field sets in `UsersService`, not as configurable data (no
requirement in the spec for runtime configurability):

| Access level | Fields included |
|---|---|
| Self (`viewerId === targetId`) | `id`, `email`, `photo`, `status`, `createdAt` |
| Privileged (`viewerId !== targetId`, viewer holds `users:read`) | `id`, `photo` only |
| Neither | request denied (403) before any fields are read |

### UserProfileAuditEvent (new)

New entity: `src/modules/users/entities/user-profile-audit-event.entity.ts`,
table `user_profile_audit_events`. Mirrors `LoginAuditEvent`
(`src/modules/auth/entities/login-audit-event.entity.ts`) shape/conventions.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | `gen_random_uuid()` default |
| `viewerId` | `uuid` | the authenticated requester's id (never null — audit only fires post-auth) |
| `targetId` | `varchar` | the requested `userId` path value, stored as-received (may be malformed/non-existent — do not attempt to resolve it to a real user before logging) |
| `outcome` | enum: `SELF_VIEW`, `PRIVILEGED_VIEW`, `DENIED`, `NOT_FOUND` | maps 1:1 to the four response branches (200-self, 200-privileged, 403, 404) |
| `createdAt` | `timestamptz` | `CreateDateColumn`, default now |

No field-value columns exist on this entity by design (FR-010: "never include
the profile field values themselves — only the identifiers and outcome").

## Relationships

- `UserProfileAuditEvent.viewerId` → conceptually references `users.id`, but
  (matching `LoginAuditEvent` precedent) is stored as a plain `uuid` column
  without a FK constraint, so audit history survives user deletion.
- No new relationship on `User` itself — `photoUrl` is a scalar column, not a
  relation.

## Validation Rules

- `photoUrl`: no format validation enforced at write time by this feature
  (no write path is introduced — this feature is read-only); column is
  nullable `varchar` with no length constraint beyond Postgres defaults.
- `userId` path param: must be a syntactically valid UUID (`ParseUUIDPipe`);
  a syntactically invalid value is treated identically to "not found" per
  spec Edge Cases — never surfaced as a distinct 400.

## State Transitions

None — this feature is read-only and introduces no state machine. `User.status`
and other lifecycle fields are unaffected and out of scope.
