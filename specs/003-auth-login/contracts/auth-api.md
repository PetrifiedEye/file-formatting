# API Contract: Login, Session, and Password Recovery

Extends the existing `auth` controller (`/auth/register`, `/auth/register/confirm/*`,
`/auth/register/resend`) with the endpoints below. All responses are JSON; all mutating endpoints
are `POST` except link-style confirmations (`GET`, matching the existing
`register/confirm/link` convention). Session is carried via an `httpOnly` cookie
(name: `session`), never in the response body.

## `POST /auth/login`

Rate limit: `{ limit: 5, ttl: 60000 }` (same as `/auth/register`).

Request:
```json
{ "email": "user@example.com", "password": "string" }
```

Responses:
- `200 OK`, no pending verification — session cookie set:
  ```json
  { "message": "Signed in.", "verificationRequired": false }
  ```
- `200 OK`, sign-in confirmation enabled — no cookie yet:
  ```json
  { "message": "Enter the code sent to your email to finish signing in.", "verificationRequired": true }
  ```
- `401 Unauthorized` — invalid credentials (unknown email OR wrong password OR unconfirmed
  registration is *not* this case, see below): generic body
  `{ "message": "Invalid email or password." }` (FR-002, FR-003, SC-002).
- `403 Forbidden` — account exists, password correct, but `status = pending_confirmation`:
  `{ "message": "Please confirm your email before signing in.", "canResend": true }` (FR-016).
- `423 Locked` — account temporarily locked from failed attempts:
  `{ "message": "Too many failed attempts. Try again later." }` (FR-008; does not reveal lockout
  duration or attempt count, per Story 3 Acceptance Scenario 1).
- `429 Too Many Requests` — throttled.

## `POST /auth/login/verify`

Rate limit: `{ limit: 5, ttl: 60000 }`. Completes a pending sign-in verification (FR-005).

Request:
```json
{ "email": "user@example.com", "code": "123456" }
```

Responses:
- `200 OK` — session cookie set: `{ "message": "Signed in." }`.
- `400 Bad Request` — wrong/expired code or attempts exhausted (generic):
  `{ "message": "Unable to verify sign-in. Please check your code or start over." }`.
- `404 Not Found` — no pending login verification for that email.

## `GET /auth/login/verify/link?token=...`

Magic-link equivalent of the above, matching `register/confirm/link`'s convention. Same response
shapes as `POST /auth/login/verify`, keyed by link token instead of email+code.

## `POST /auth/logout`

Requires a valid session (`SessionAuthGuard`). Invalidates the current session and clears the
cookie (FR-006).

Responses:
- `200 OK`: `{ "message": "Signed out." }`.
- `401 Unauthorized` — no/invalid session.

## `POST /auth/password-reset/request`

Rate limit: `{ limit: 1, ttl: 60000 }` (same style as `/auth/register/resend`).

Request:
```json
{ "email": "user@example.com" }
```

Response (always, regardless of whether the email exists or recovery is enabled — FR-010,
no-enumeration):
```json
{ "message": "If this email is registered, password reset instructions have been sent." }
```
`429 Too Many Requests` on throttling or the same per-email send cap used for registration
(`EMAIL_CAP_MAX` within `EMAIL_CAP_WINDOW_MS`).

## `POST /auth/password-reset/confirm`

Request:
```json
{ "email": "user@example.com", "code": "123456", "newPassword": "string" }
```

Responses:
- `200 OK`: `{ "message": "Your password has been reset. Please sign in." }` — password updated,
  challenge consumed, all of the user's active sessions invalidated (FR-013, FR-015).
- `400 Bad Request` — invalid/expired/already-used code, or `newPassword` fails the password
  policy (generic message; password-policy violations reuse the existing
  `validatePassword` error array, same shape as `/auth/register`'s `400`).

## `GET /auth/password-reset/confirm/link?token=...`

Magic-link variant, mirroring `register/confirm/link`. On success it does **not** itself set the
new password (a link alone can't safely accept `newPassword` via query string); it exchanges the
link token for a short-lived confirmation the client then submits, alongside the new password, to
`POST /auth/password-reset/confirm` (email + code path reused with the code omitted /
link-derived). *Implementation note for tasks phase*: simplest compliant option is for this route
to redirect/respond with the same `otp`-equivalent flow already used for registration, i.e. treat
the link as validating the challenge and returning the underlying reset token for the client form
to post back — do not accept `newPassword` as a query parameter.

## Guard/middleware contract (internal, not HTTP-facing)

- `SessionAuthGuard`: on any route it decorates, requires cookie `session` to resolve to an
  active `sessions` row; sets `request.user = { id, roles }`; throws `401` otherwise. Applied to
  `/auth/logout` and, combined with `PermissionGuard`, to all `/rbac/*` and `/admin/settings/*`
  routes (closing the gap described in research.md §5).
