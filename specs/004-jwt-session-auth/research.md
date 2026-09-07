# Research: JWT Cookie-Based Session Authorization

## 1. JWT library

- **Decision**: `@nestjs/jwt` (thin Nest wrapper over `jsonwebtoken`).
- **Rationale**: First-party Nest integration (module/service DI, matches existing
  `ConfigModule`/Joi pattern), actively maintained, already the de-facto standard for
  Nest + cookie-based auth. `@fastify/cookie` is already installed and configured for
  reading/writing cookies, so only the token library is new.
- **Alternatives considered**:
  - Raw `jsonwebtoken` — works but loses DI ergonomics `@nestjs/jwt` provides for free;
    no material benefit for this codebase.
  - `passport` + `passport-jwt` — pulls in a strategy/session abstraction the codebase
    doesn't otherwise use (existing guards are plain `CanActivate` classes calling a
    service directly, e.g. `SessionAuthGuard`); adopting Passport here would be a bigger
    pattern change than the feature warrants.

## 2. Token structure & signing

- **Decision**: Two HMAC-SHA256 (HS256) secrets, `JWT_ACCESS_SECRET` and
  `JWT_REFRESH_SECRET`, both required env vars validated via the existing Joi schema in
  `config.validation.ts`. Payload for both token kinds: `{ sub: userId, typ: 'access' |
  'refresh' }` plus standard `iat`/`exp` (library-managed). No roles, email, or other
  mutable claims are embedded.
- **Rationale**:
  - Separate secrets mean a refresh token can never be misused as an access token (or
    vice versa) even if a code path forgets to check `typ`; defense in depth per
    Constitution Principle II.
  - `typ` claim gives a second, cheap check against calling `/auth/refresh` with an
    access cookie or a protected route with a refresh cookie.
  - Roles are intentionally excluded: FR-003 requires the user's current active state to
    be checked on every protected request, and role membership can change between token
    issuance and use (RBAC feature). Embedding them would let stale roles silently
    persist for up to 15 minutes; a DB lookup already happens for the user-status check,
    so fetching roles in the same guard costs nothing extra and stays correct.
- **Alternatives considered**: single shared secret for both token kinds (rejected —
  cheaper but removes the type-confusion defense at effectively zero implementation
  cost); embedding roles in the access token to skip a query (rejected — correctness
  risk explicitly called out by FR-003 outweighs the minor DB cost, and the RBAC guard
  already performs this same lookup today).

## 3. Replacing the existing opaque session mechanism

- **Decision**: This feature replaces, not augments, the current DB-backed session
  design (`Session` entity/table, `SessionService`, `SessionAuthGuard`) introduced in
  `1757000000000-AuthLogin.migration.ts`. FR-010 explicitly forbids server-side
  refresh-credential storage (no allowlist/denylist/jti), which is incompatible with the
  existing `sessions` table approach of storing a hashed token server-side.
- **Rationale**: The spec is unambiguous that this is a different session model
  (stateless JWT vs. stored opaque token), not an additive one. Keeping both would mean
  two competing "what is the current session" mechanisms, violating Constitution
  Principle I (no entangled/duplicate auth logic) and confusing the single cookie-name
  contract already in use (`session`).
- **Migration plan**: New migration drops the `sessions` table and its index; the
  `Session` entity, `SessionService`, and `SessionAuthGuard` are deleted and replaced by
  `TokenService` (sign/verify access & refresh JWTs) and `JwtAuthGuard`. `AuthService`
  call sites that issued/consumed `IssuedSession` are updated to the new token pair
  shape. `login-audit.service` and its entity are reused unchanged for audit logging
  (see §5); only new `LoginAuditEventType` values are added.
- **Alternatives considered**: Keep `sessions` table as an audit trail only (not used
  for validation) — rejected as unnecessary scope creep; `login_audit_events` already
  serves the audit purpose FR-013 requires, without persisting the credential itself.

## 4. Cookie attributes & names

- **Decision**: Two cookies, `access_token` (path `/`, `maxAge` 15 min) and
  `refresh_token` (path `/auth`, `maxAge` 30 days). Both: `httpOnly: true`,
  `secure: NODE_ENV === 'production'` (matches existing `setSessionCookie` pattern),
  `sameSite: 'lax'`.
- **Rationale**: `httpOnly` + `secure` + `sameSite=lax` satisfies FR-012 (no page-JS
  access, encrypted-only transmission, same-site restriction) and mirrors the pattern
  already used for the `session` cookie. Scoping the refresh cookie's `path` to `/auth`
  means the browser only ever sends the longer-lived, higher-value credential to the
  auth endpoints (`/auth/refresh`, `/auth/logout`) rather than on every request to every
  route, shrinking its exposure surface without adding any new capability.
- **Alternatives considered**: single combined cookie carrying both tokens (rejected —
  forces the refresh token onto every request path, the opposite of minimizing its
  exposure); `SameSite=strict` (rejected — spec's assumptions section keeps the app
  same-site/same-origin for now but `strict` would break top-level navigation after an
  external link/redirect flow; `lax` is the documented industry default for this case
  and matches the existing cookie).

## 5. Audit logging for auth/refresh failures

- **Decision**: Reuse `LoginAuditEvent`/`LoginAuditService` (already satisfies "no
  secret values, structured, categorized failure reason" per Principle V and FR-014).
  Add two new `LoginAuditEventType` values: `ACCESS_CHECK_FAILED` and
  `TOKEN_REFRESH_ATTEMPT`. Failure reasons are short category strings only:
  `missing`, `expired`, `invalid_signature`, `malformed`, `user_not_found`,
  `user_inactive`.
- **Rationale**: FR-013 requires an audit entry per failed authentication/renewal
  attempt with a failure-reason category and no credential material; the existing
  entity/service already enforces exactly that shape, so extending its enum is the
  smallest change that satisfies the requirement without introducing a parallel logging
  path.
- **Alternatives considered**: plain `Logger.warn` calls only (rejected — doesn't meet
  the durable, queryable audit trail FR-013 implies, and is inconsistent with how login
  failures are already audited elsewhere in this module).

## 6. Clock skew tolerance

- **Decision**: `clockTolerance: 5` (seconds) passed to `@nestjs/jwt`'s verify options
  for both access and refresh verification.
- **Rationale**: Matches the spec's "small, fixed tolerance... on the order of a few
  seconds" assumption; 5s is `jsonwebtoken`'s own commonly-documented example value and
  needs no new config surface.

## 7. `/auth/refresh` user-state check

- **Decision**: On refresh, after verifying the refresh JWT's signature/expiry/`typ`,
  look up the user by `sub` and require `status === ACTIVE` before issuing new tokens,
  same check as the protected-resource guard.
- **Rationale**: FR-010's "no server-side session state" ban is about not persisting the
  *refresh credential itself* (or an allow/deny list keyed on it); it does not prohibit
  reading the `users` table, which the system already does on every protected request
  (FR-003). Skipping this check on refresh would let a deactivated/blocked user keep
  minting fresh 15-minute access tokens for up to 30 days after being blocked, which
  contradicts the intent of User Story 1's deactivation scenario even though that
  scenario's acceptance criteria only names the protected-resource path explicitly.
- **Alternatives considered**: skip the check on refresh, rely solely on the
  protected-resource guard to catch deactivated users (rejected — leaves a real gap:
  refresh never touches a protected resource, so a blocked user could refresh
  indefinitely without ever hitting the check that blocks them).

## 8. `/auth/logout` semantics

- **Decision**: `/auth/logout` no longer requires a valid session guard. It always
  clears both cookies (if present) and returns success, regardless of whether the
  incoming access token is present/valid.
- **Rationale**: Edge case in the spec: "sign-out with no active session cookies → no-op
  success." Requiring a valid guard first would reject exactly the case the spec calls
  out as an accepted no-op, and there is no server-side state to invalidate anyway
  (FR-011), so there is nothing a guard would protect here.
- **Alternatives considered**: keep `JwtAuthGuard` on logout as today's `SessionAuthGuard`
  is used (rejected — contradicts the explicit no-op-on-missing-cookies acceptance
  scenario).
