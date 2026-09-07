# Research: User Login & Session Authentication

## 1. Session mechanism

**Decision**: Opaque, database-backed session tokens delivered via an `httpOnly`, `secure`
(in production), `sameSite=lax` cookie, using the `@fastify/cookie` plugin and `COOKIE_SECRET`
already registered in `src/main.ts`. The cookie carries the raw random token
(`crypto.randomBytes(32).toString('base64url')`); the database stores only its SHA-256 hash
(`sessions.token_hash`, unique + indexed), mirroring the existing `linkTokenHash` pattern in
`confirmation-token.ts` / `ConfirmationChallenge`.

**Rationale**: No JWT/passport dependency exists in `package.json`, and the codebase already has
a working, audited pattern for hashed opaque secrets (registration OTP/link tokens) plus cookie
infrastructure wired in `main.ts` with `credentials: true` CORS. A DB-backed session is trivially
revocable (required by FR-006 logout and FR-015 "reset invalidates other sessions"), which a
stateless JWT would need a denylist to achieve anyway. Reusing the established hash-lookup pattern
keeps the new code idiomatic with `ConfirmationChallengeService.findByLinkTokenHash`.

**Alternatives considered**:
- *JWT access tokens*: rejected — adds a new dependency (`@nestjs/jwt`), and stateless tokens
  can't be individually revoked on logout/reset without an extra denylist table, which is no
  simpler than just storing sessions directly.
- *express-session / connect style server-side session store*: rejected — project runs on the
  Fastify adapter; would add a new dependency for something the existing cookie plugin plus one
  TypeORM entity already covers.

## 2. Login verification & password reset — challenge pattern reuse

**Decision**: Do not repurpose the existing `confirmation_challenges` table (it is tightly coupled
to `UserStatus.PENDING_CONFIRMATION` semantics in `AuthService`/`UsersService`). Instead, add two
new tables that reuse the *shape and utilities* of `ConfirmationChallenge`
(`generateConfirmationTokens`, `hashSecret`, `CONFIRMATION_TTL_MS`, 5-attempt limit) via the
existing generic `utils/confirmation-token.ts` helpers:
- `login_challenges` — pending sign-in verification (User Story 2).
- `password_reset_challenges` — pending password reset (User Story 4).

**Rationale**: FR-005 and FR-011 say to reuse "the same expiration and attempt-limit *behavior*",
not the same table. Keeping registration, login, and reset challenges in separate tables preserves
single-responsibility per Principle I (Modular Architecture) and keeps each table's active-row
partial index simple (`WHERE consumed_at IS NULL AND invalidated_at IS NULL`), same as
`idx_confirmation_challenges_active`.

**Alternatives considered**:
- *Single generic `challenges` table with a `purpose` enum*: rejected as unnecessary abstraction
  for three call sites with different owning entities and lifecycle rules (registration challenges
  key off pending users; login/reset challenges key off active users) — would require nullable
  columns and cross-cutting `WHERE purpose = ...` filters on every query, no simpler in practice.

## 3. Failed-attempt tracking & lockout (FR-007, FR-008)

**Decision**: Add `failed_login_attempts` (smallint, default 0) and `locked_until` (timestamptz,
nullable) columns directly on `users`. Every failed attempt increments the counter and, on
reaching 5, sets `locked_until = now() + 15 minutes`; every successful login resets the counter to
0 and clears `locked_until`. The lockout check on each login is therefore a single indexed
row-read on `users` (already fetched by email), not an aggregate query.

A separate, full-fidelity `login_audit_events` table (see below) still records every attempt for
SC-003/FR-009 traceability, but it is **not** queried on the hot path to decide lockout — only
written to.

**Rationale**: Principle III (Database Performance & Integrity) requires avoiding unbounded scans;
counting audit rows within a time window on every login attempt would not use a partial/unique
index the way a direct column check does, and would grow more expensive as history accumulates.
This mirrors common lockout implementations (e.g., Django's `axes`, ASP.NET Identity's
`AccessFailedCount`/`LockoutEnd`).

**Alternatives considered**:
- *Redis-based counters*: rejected — no cache/Redis dependency exists in this project; would add
  new infrastructure for a feature the existing PostgreSQL row already handles at this scale.
- *Counting `login_audit_events` rows in a sliding window*: rejected per Principle III as above;
  kept only as the audit trail, not the lockout decision.

## 4. Audit logging (FR-009)

**Decision**: New `login_audit_events` table, structurally identical to
`registration_audit_events` (event type, outcome, normalized email, user id, IP, user agent,
failure reason, jsonb metadata, created-at index), with event types: `LOGIN_ATTEMPT`,
`LOGIN_VERIFICATION_ATTEMPT`, `LOGOUT`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_ATTEMPT`.

**Rationale**: `RegistrationAuditEvent`/`RegistrationAuditService` are explicitly scoped to
registration by name and by their existing call sites; adding login/session event types to that
table would blur its purpose. A parallel table with the identical shape keeps `LoginAuditService`
a drop-in sibling of `RegistrationAuditService`, satisfying "consistent with existing registration
audit logging" (FR-009) without repurposing a differently-named entity.

## 5. Current-user resolution seam (route protection, FR-014 / Story 5)

**Finding**: `PermissionGuard` (`src/modules/rbac/guards/permission.guard.ts`) already expects
`request.user: { id, roles }` to be populated upstream, and throws `UnauthorizedException` when it
is absent — but nothing in the running application ever sets it today. The only existing code that
populates it is `test/support/rbac-test-auth.module.ts`, a **test-only** Fastify `onRequest` hook
that trusts an `x-test-user-id` header. This means all RBAC-protected endpoints
(`/rbac/roles`, `/rbac/permissions`, `/rbac/grants`) are currently unusable outside tests, and
`AdminGuard` (`src/modules/settings/guards/admin.guard.ts`) is a checked-in placeholder that always
returns `true` (see its own TODO comment).

**Decision**: Introduce a `SessionAuthGuard` in the auth module that:
1. Reads the session cookie, hashes it, looks up an active, unexpired `sessions` row.
2. Loads the owning user's role names (via `user_roles`/`roles`, same join `rbac-test-auth.module.ts`
   already performs).
3. Sets `request.user = { id, roles }` and allows the request through; throws
   `UnauthorizedException` otherwise.

`SessionAuthGuard` is applied before `PermissionGuard` on the RBAC controllers
(`@UseGuards(SessionAuthGuard, PermissionGuard)`), which makes those endpoints work end-to-end for
the first time. `AdminGuard` is reimplemented on top of the same session lookup, additionally
requiring the `admin` role (the only role seeded today, by
`RbacSeedAdmin1756730200000`) — introducing a dedicated `settings` RBAC permission is out of scope
for this feature and can be a follow-up once more admin-only modules exist.

**Rationale**: This is the exact integration point the RBAC feature's own test scaffolding
anticipated (its doc comment references "a real authentication layer (none exists yet)"). Fixing
it is required for FR-014/FR-015 (protecting authenticated-only actions) and is the natural,
minimal-scope way to close the gap without inventing a second parallel auth mechanism.

**Alternatives considered**:
- *Nest global guard via `APP_GUARD`*: rejected as the default — several endpoints (register,
  login, resend, password-reset request) must stay anonymous; an explicit `@UseGuards(...)` per
  controller (matching the existing RBAC controllers' style) is clearer than a global guard with a
  growing `@Public()` allowlist, given the current controller count.

## 6. `passwordRecoveryConfirmationEnabled` semantics

**Finding**: This boolean already exists on `SystemSettings` (migration
`1756730000000-UserRegistration`) but is not read anywhere in application code yet — it was
provisioned ahead of this feature, alongside `signInConfirmationEnabled` (which *is* used, per
FR-005).

**Decision**: Treat it as a feature kill-switch for self-service password recovery, mirroring
`registrationConfirmationEnabled`'s on/off role for its own flow: when `false`, `POST
/auth/password-reset/request` still returns the generic non-enumerating response (FR-010) but does
not create a challenge or send an email; when `true`, the full FR-011 flow runs (send code/link,
require confirmation). This preserves the no-enumeration guarantee in both states and gives
operators the same kind of on/off control they already have for registration and sign-in
confirmation.

**Alternatives considered**: Treating the flag as always-on/ignored was rejected because the field
was clearly added intentionally alongside the other two policy toggles and the settings API already
exposes it for admin editing (`SettingsController`/`ConfirmationPolicyResponseDto`).

## 7. Session lifetime

**Decision**: Fixed 24-hour absolute session lifetime (`SESSION_TTL_MS`), consistent with the
existing 24-hour `PENDING_TTL_MS` used for pending registrations. No sliding/rolling extension in
this iteration. Login-verification (`login_challenges`) and password-reset
(`password_reset_challenges`) reuse the existing 10-minute `CONFIRMATION_TTL_MS` and 5-attempt
limit already defined in `utils/confirmation-token.ts`.

**Rationale**: Matches "Session/token lifetime ... will mirror the conservative defaults already
used for registration" (spec Assumptions). A fixed TTL is the simplest correct implementation of
FR-015 ("bounded lifetime"); sliding expiration can be added later without a breaking schema
change (the `expiresAt` column supports either).

## 8. Rate limiting (FR-007)

**Decision**: Apply `@Throttle(...)` from `@nestjs/throttler` on `POST /auth/login`,
`POST /auth/login/verify`, `POST /auth/password-reset/request`, and
`POST /auth/password-reset/confirm`, following the same per-route override style already used on
`POST /auth/register` (`@Throttle({ default: { limit: 5, ttl: 60000 } })`) and `POST
/auth/register/resend` (`@Throttle({ default: { limit: 1, ttl: 60000 } })`). Global throttling
(`ThrottlerModule`, already registered) remains the floor for every other route.

**Rationale**: Directly reuses the mechanism the constitution mandates (Principle II) and the
project already depends on — no new library needed.

## Summary of resolved unknowns

| Unknown | Resolution |
|---|---|
| Session/token format | Opaque random token in httpOnly cookie; SHA-256 hash stored in `sessions` table |
| Login-verification storage | New `login_challenges` table, same shape/utils as `ConfirmationChallenge` |
| Password-reset storage | New `password_reset_challenges` table, same shape/utils |
| Lockout implementation | Counter + `locked_until` columns on `users`, checked directly (not aggregated) |
| Audit storage | New `login_audit_events` table, sibling of `registration_audit_events` |
| Route protection | New `SessionAuthGuard` populates `request.user` for the already-present `PermissionGuard`; `AdminGuard` rebuilt on the same session lookup + `admin` role check |
| `passwordRecoveryConfirmationEnabled` | Kill-switch for the whole recovery flow, non-enumerating either way |
| Session TTL | Fixed 24h absolute |
| Rate limiting | `@nestjs/throttler` per-route overrides, same style as existing registration endpoints |
