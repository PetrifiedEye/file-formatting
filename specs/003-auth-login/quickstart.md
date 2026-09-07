# Quickstart: Validating Login & Session Authentication

## Prerequisites

- Local stack running per repo `README.md` (Postgres + Mailpit + the Nest app), migrations
  applied: `npm run migration:run`.
- A confirmed test user. Easiest path: with `registration_confirmation_enabled = false`
  (default), `POST /auth/register` immediately creates an `active` user — no email step needed.

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -c /tmp/cookies.txt \
  -d '{"email":"quickstart@example.com","password":"CorrectHorse123!"}'
```

## Scenario 1 — Basic login + protected action (User Story 1)

```bash
# Login, capturing the session cookie
curl -si -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -c /tmp/cookies.txt \
  -d '{"email":"quickstart@example.com","password":"CorrectHorse123!"}'
# Expect: 200, verificationRequired:false, Set-Cookie: session=...

# Use the session against an authenticated-only route (e.g. logout itself, or any
# SessionAuthGuard-protected route added by this feature)
curl -si -X POST http://localhost:3000/auth/logout -b /tmp/cookies.txt
# Expect: 200

# Reuse the now-invalidated cookie
curl -si -X POST http://localhost:3000/auth/logout -b /tmp/cookies.txt
# Expect: 401
```

Wrong password / unknown email both return the same generic `401`:

```bash
curl -si -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","password":"wrong"}'
curl -si -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"wrong"}'
# Both: 401 with identical { "message": "Invalid email or password." }
```

## Scenario 2 — Sign-in verification (User Story 2)

```bash
# Enable sign-in confirmation (requires an authenticated admin session — see Scenario 5)
curl -s -X PATCH http://localhost:3000/admin/settings/confirmation-policy \
  -H 'Content-Type: application/json' -b /tmp/admin-cookies.txt \
  -d '{"signInConfirmationEnabled": true}'

curl -si -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","password":"CorrectHorse123!"}'
# Expect: 200, verificationRequired:true, no session cookie set

# Fetch the OTP from Mailpit (http://localhost:8025) and submit it
curl -si -X POST http://localhost:3000/auth/login/verify \
  -H 'Content-Type: application/json' -c /tmp/cookies.txt \
  -d '{"email":"quickstart@example.com","code":"<otp-from-mailpit>"}'
# Expect: 200, session cookie set
```

## Scenario 3 — Lockout (User Story 3)

```bash
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"quickstart@example.com","password":"wrong"}'
done
# Expect: five 401s

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","password":"CorrectHorse123!"}'
# Expect: 423 even with the CORRECT password — account is locked
```

Check the audit trail directly in Postgres (see data-model.md for the table shape):

```sql
select event_type, outcome, failure_reason, created_at
from login_audit_events
where normalized_email = 'quickstart@example.com'
order by created_at desc limit 10;
```

## Scenario 4 — Password recovery (User Story 4)

```bash
curl -s -X POST http://localhost:3000/auth/password-reset/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com"}'
# Expect: 200, generic message, regardless of whether the email exists

# Fetch the OTP from Mailpit, then:
curl -s -X POST http://localhost:3000/auth/password-reset/confirm \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","code":"<otp-from-mailpit>","newPassword":"NewPassw0rd!"}'
# Expect: 200

# Old password now fails, new password works
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","password":"CorrectHorse123!"}'
# Expect: 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"quickstart@example.com","password":"NewPassw0rd!"}'
# Expect: 200
```

## Scenario 5 — Route protection (User Story 5)

```bash
# No session
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/rbac/roles
# Expect: 401

# With a valid session but insufficient permissions
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/rbac/roles -b /tmp/cookies.txt
# Expect: 403 (quickstart@example.com has no admin role)
```

## Automated verification

- Unit tests: `npm run test` — new specs for `SessionService`, `LoginAuditService`,
  `SessionAuthGuard`, `AuthService` login/verify/reset methods, lockout logic on `UsersService`.
- E2E tests: `npm run test:e2e` — new `test/auth-login.e2e-spec.ts` covering Scenarios 1–5 above
  against a real (test) Postgres instance, following the existing pattern in
  `test/auth-registration.e2e-spec.ts` and `test/rbac-access-check.e2e-spec.ts`.
- Full gate: `npm run verify` (typecheck + lint + unit tests) before opening a PR, per the
  constitution's Development Workflow & Quality Gates.
