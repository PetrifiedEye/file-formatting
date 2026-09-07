# Quickstart: Validate JWT Cookie Session Auth

## Prerequisites

- `.env` includes `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (new, required — see
  `config.validation.ts`), in addition to the existing required vars.
- Local stack running per repo `README.md` (Postgres + Mailpit via `docker compose`,
  then `npm run start:dev`).
- A confirmed, active user account (via existing `/auth/register` +
  `/auth/register/confirm/code` flow, or an existing seeded account).

## 1. Sign in and receive a session

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"correct-horse-battery-staple"}'
```

**Expected**: `200 OK`; `Set-Cookie` headers for `access_token` (`Path=/`, `Max-Age=900`)
and `refresh_token` (`Path=/auth`, `Max-Age=2592000`); `cookies.txt` now holds both.

## 2. Call a protected resource

```bash
curl -i -b cookies.txt http://localhost:3000/rbac/roles
```

**Expected**: `200 OK` (or whatever the endpoint's normal authorized response is).

Negative checks:

```bash
curl -i http://localhost:3000/rbac/roles                # no cookies -> 401
curl -i -b <(echo "Cookie: access_token=garbage") \
  http://localhost:3000/rbac/roles                       # tampered -> 401
```

## 3. Simulate access-token expiry and renew

Wait for the access token to expire (or sign the JWT locally with a past `exp` using
`JWT_ACCESS_SECRET` for a faster loop), then:

```bash
curl -i -b cookies.txt http://localhost:3000/rbac/roles   # 401, access expired
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3000/auth/refresh
```

**Expected**: `200 OK`; fresh `access_token` **and** `refresh_token` cookies are set
(rotation). Re-run the protected-resource call — it succeeds again without
re-authenticating with a password.

## 4. Refresh with an invalid/expired renewal credential

```bash
curl -i -b "Cookie: refresh_token=garbage" -X POST http://localhost:3000/auth/refresh
```

**Expected**: `401 Unauthorized`, no cookies set.

## 5. Sign out

```bash
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3000/auth/logout
curl -i -b cookies.txt http://localhost:3000/rbac/roles    # now 401
```

**Expected**: logout returns `200 OK` and clears both cookies; the same cookie jar can
no longer reach the protected resource. Calling `/auth/logout` again with an empty
cookie jar also returns `200 OK` (no-op).

## 6. Verify no server-side refresh state exists

```bash
psql "$POSTGRES_URL" -c "\dt sessions"        # relation does not exist
```

**Expected**: the `sessions` table no longer exists after the migration in this feature
runs (FR-010).

## Automated coverage

- `TokenService` unit tests: sign/verify round-trip, expired/tampered/wrong-secret/
  wrong-`typ` rejection, clock-skew tolerance.
- `JwtAuthGuard` unit tests: happy path populates `request.user`; each rejection
  category (missing/malformed/expired/bad-signature/user-not-found/user-inactive)
  throws `UnauthorizedException` and triggers an `ACCESS_CHECK_FAILED` audit record.
- `AuthController`/`AuthService` e2e: login sets both cookies; `/auth/refresh`
  happy-path rotation and each rejection category; `/auth/logout` clears cookies and is
  a no-op with none present; a protected route round-trips through login → access →
  expiry → refresh → access again.
