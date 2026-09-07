# Data Model: JWT Cookie-Based Session Authorization

No new database tables. The existing `sessions` table is **removed** (server-side
refresh storage is explicitly forbidden by FR-010). One existing enum is extended for
audit logging.

## Access Token (JWT, not persisted)

Carried in the `access_token` cookie. Structure only — never stored server-side.

| Claim | Type | Notes |
|-------|------|-------|
| `sub` | string (uuid) | `User.id` |
| `typ` | `'access'` | Distinguishes from refresh tokens signed with a different secret |
| `iat` | number (unix seconds) | Issued-at, set by `@nestjs/jwt` |
| `exp` | number (unix seconds) | `iat + 15m`, set by `@nestjs/jwt` |

Signed with `JWT_ACCESS_SECRET` (HS256). Validity = signature verifies AND `exp` not
passed (± 5s clock tolerance) AND `typ === 'access'`.

## Refresh Token (JWT, not persisted)

Carried in the `refresh_token` cookie (`path=/auth`). Structure only — never stored,
tracked, or indexed server-side (FR-010).

| Claim | Type | Notes |
|-------|------|-------|
| `sub` | string (uuid) | `User.id` |
| `typ` | `'refresh'` | Distinguishes from access tokens signed with a different secret |
| `iat` | number (unix seconds) | Issued-at |
| `exp` | number (unix seconds) | `iat + 30d` |

Signed with `JWT_REFRESH_SECRET` (HS256). Validity = signature verifies AND `exp` not
passed (± 5s clock tolerance) AND `typ === 'refresh'`. No uniqueness/jti/allowlist —
by design, a prior refresh token remains cryptographically "valid" until its own `exp`,
even after rotation (accepted trade-off, FR-008/FR-010/edge cases).

## User Account (existing entity, read-only for this feature)

`src/modules/users/entities/user.entity.ts` — unchanged. This feature reads
`User.status` on every protected request and on refresh:

- `status === UserStatus.ACTIVE` → allowed to proceed.
- `status === UserStatus.PENDING_CONFIRMATION` or user row not found → rejected
  (FR-003). There is currently no dedicated "blocked/deactivated" status in `UserStatus`;
  "not active" is treated as the reject condition, which already covers the spec's
  deactivation scenario for any status other than `ACTIVE`. Introducing an explicit
  `BLOCKED` status is out of scope for this feature (not required by any FR here).

## Login Audit Event (existing entity, extended enum only)

`src/modules/auth/entities/login-audit-event.entity.ts` — table and columns unchanged.
`LoginAuditEventType` gains two members:

| New value | Recorded when |
|-----------|----------------|
| `ACCESS_CHECK_FAILED` | A protected-resource request is rejected by `JwtAuthGuard` (missing/malformed/expired/bad-signature access token, or user not found/inactive) |
| `TOKEN_REFRESH_ATTEMPT` | `POST /auth/refresh` is called; `outcome` is `SUCCESS` or `FAILURE` per existing `LoginAuditOutcome` enum |

`failureReason` values used by this feature (all short category strings, never token
material, per FR-013/FR-014): `missing`, `malformed`, `invalid_signature`, `expired`,
`user_not_found`, `user_inactive`.

This requires a migration to alter the Postgres enum type backing
`login_audit_events.event_type` (add-value only, no data migration needed).

## Removed: Session (entity, table, service, guard)

`src/modules/auth/entities/session.entity.ts`, the `sessions` table (and its
`idx_sessions_active` index), `SessionService`, and `SessionAuthGuard` are deleted.
Superseded by:

- `TokenService` — signs/verifies access & refresh JWTs (`src/modules/auth/token.service.ts`).
- `JwtAuthGuard` — validates the `access_token` cookie and attaches `request.user`
  (`id`, `roles`), replacing `SessionAuthGuard` (`src/modules/auth/guards/jwt-auth.guard.ts`).

`request.user` shape (`RequestUser`) is unchanged (`{ id: string; roles: string[] }`) so
every existing consumer of `SessionAuthGuard`'s attached user (e.g. RBAC decorators/
guards) keeps working without modification.
