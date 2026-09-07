# Contract: Auth Endpoints (JWT Cookie Session)

Base path: `/auth`. All responses are JSON. Cookies below are set via `Set-Cookie`
response headers, never in the JSON body.

## POST /auth/login (existing endpoint, cookie output changes)

Unchanged request/response body (`LoginRequestDto` / `LoginResponseDto`) and unchanged
verification sub-flows (`/auth/login/verify`, `/auth/login/verify/link`). **Only the
cookies issued on success change**:

- `Set-Cookie: access_token=<JWT>; HttpOnly; Secure*; SameSite=Lax; Path=/; Max-Age=900`
- `Set-Cookie: refresh_token=<JWT>; HttpOnly; Secure*; SameSite=Lax; Path=/auth; Max-Age=2592000`

(`Secure` present only when `NODE_ENV=production`, matching existing behavior.)

Previously a single `session=<opaque>` cookie was set — this cookie is no longer issued
by any endpoint.

## POST /auth/refresh (new)

- **Auth**: none (reads `refresh_token` cookie directly; not gated by `JwtAuthGuard`).
- **Rate limit**: `@Throttle` — same class of limit as `/auth/login` (5/min) to bound
  abuse per Constitution Principle II.
- **Request**: no body. Requires `refresh_token` cookie.
- **200 OK** — refresh token valid, user active:
  - Body: `{ "message": "Session refreshed." }`
  - Sets new `access_token` and new `refresh_token` cookies (rotation — FR-008), same
    attributes as login.
- **401 Unauthorized** — refresh token missing, malformed, invalid signature, expired,
  wrong `typ`, or user not found/inactive:
  - Body: `{ "statusCode": 401, "message": "Authentication required" }`
  - No cookies are set or cleared (FR-009 — client already has whatever it had before).
  - Audit event `TOKEN_REFRESH_ATTEMPT` / `FAILURE` recorded with a category
    `failureReason` (see data-model.md), never the token value (FR-013/FR-014).

## POST /auth/logout (existing endpoint, auth requirement removed)

- **Auth**: none (previously required `SessionAuthGuard`). Always succeeds.
- **Request**: no body. Cookies optional.
- **200 OK**:
  - Body: `{ "message": "Signed out." }`
  - Clears `access_token` (`Path=/`) and `refresh_token` (`Path=/auth`) via
    `Set-Cookie: ...; Max-Age=0`, whether or not they were present (FR-011, no-op edge
    case).

## Any protected endpoint (contract change: guard swap)

Every endpoint currently decorated `@UseGuards(SessionAuthGuard)` (e.g. RBAC's
`PermissionGuard`/`AdminGuard` consumers, `/auth/logout` previously) is re-decorated
`@UseGuards(JwtAuthGuard)`. Behavioral contract as seen by a caller:

- **200/2xx** — `access_token` cookie present, signature valid, `typ === 'access'`, not
  expired (± 5s skew), and the identified user exists with `status === ACTIVE`.
  `request.user = { id, roles }` is populated identically to today's
  `SessionAuthGuard` behavior, so downstream RBAC checks are unaffected.
- **401 Unauthorized**, body `{ "statusCode": 401, "message": "Authentication required" }`
  — cookie missing, malformed, wrong `typ`, bad signature, expired, or user not
  found/inactive. Audit event `ACCESS_CHECK_FAILED` / `FAILURE` recorded with a category
  `failureReason`, never the token value.

No response body field ever changes shape based on *why* authentication failed — per
FR-015 the client gets one consistent "not authenticated" signal (401) it can react to
(try `/auth/refresh`, then fall back to sign-in if that also fails).
