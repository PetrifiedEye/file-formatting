# Quickstart: User Registration Validation

**Feature**: `001-user-registration`  
**Branch**: `001-user-registration`

Runnable scenarios to validate registration end-to-end. See [data-model.md](./data-model.md) and [contracts/registration-api.openapi.yaml](./contracts/registration-api.openapi.yaml) for details.

---

## Prerequisites

1. **PostgreSQL** running (`docker compose up -d` if using project compose file).
2. **Mailpit** (or Mailhog) for local SMTP capture:
   ```bash
   docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
   ```
3. **Environment** — copy `.env.example` and set at minimum:
   ```env
   PORT=3000
   NODE_ENV=development
   COOKIE_SECRET=dev-secret-change-me
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=postgres
   POSTGRES_DB=file_formatting
   POSTGRES_MIGRATIONS_RUN=true
   SMTP_HOST=localhost
   SMTP_PORT=1025
   SMTP_FROM=noreply@localhost
   APP_BASE_URL=http://localhost:3000
   ```
4. **Install & migrate**:
   ```bash
   npm install
   npm run migration:run
   npm run start:dev
   ```
5. Open Mailpit UI: http://localhost:8025  
6. Open Swagger (after implementation): http://localhost:3000/api/docs

---

## Scenario 1 — Register without confirmation (P1)

**Setup**: Ensure registration confirmation is **disabled** (default seed).

```bash
curl -s -X PATCH http://localhost:3000/admin/settings/confirmation-policy \
  -H 'Content-Type: application/json' \
  -d '{"registrationConfirmationEnabled": false}'
```

**Register**:
```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"newuser@example.com","password":"validpass1"}'
```

**Expected**:
- HTTP `201`
- Body includes `"confirmationRequired": false`
- No email in Mailpit
- DB: `users` row with `status = active`, `email = newuser@example.com`

**Duplicate email** (anti-enumeration):
```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"newuser@example.com","password":"otherpass2"}'
```

**Expected**:
- Generic success-shaped response (no "email already registered")
- Still exactly one `active` user for that email
- Audit event with `failure_reason = duplicate_email`

---

## Scenario 2 — Register with confirmation (P2)

**Setup**:
```bash
curl -s -X PATCH http://localhost:3000/admin/settings/confirmation-policy \
  -H 'Content-Type: application/json' \
  -d '{"registrationConfirmationEnabled": true}'
```

**Register**:
```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"confirm@example.com","password":"validpass1"}'
```

**Expected**:
- HTTP `201`, `"confirmationRequired": true`
- Mailpit: email with 6-digit code **and** confirmation link
- DB: user `status = pending_confirmation`; active challenge row exists

**Sign-in readiness** (manual DB check until sign-in feature exists):
```bash
# user.status must remain pending_confirmation until confirm succeeds
```

---

## Scenario 3 — Confirm with OTP (P3)

Continue from Scenario 2. Read OTP from Mailpit.

```bash
curl -s -X POST http://localhost:3000/auth/register/confirm/code \
  -H 'Content-Type: application/json' \
  -d '{"email":"confirm@example.com","code":"REPLACE_WITH_OTP"}'
```

**Expected**:
- HTTP `200`, `"accountReady": true`
- User `status = active`, `confirmed_at` set
- Challenge `consumed_at` set

**Wrong code** (repeat up to 5 times with bad code):
```bash
curl -s -X POST http://localhost:3000/auth/register/confirm/code \
  -H 'Content-Type: application/json' \
  -d '{"email":"confirm@example.com","code":"000000"}'
```

**Expected**: HTTP `400`, `attempts_remaining` decremented; account stays unusable.

---

## Scenario 4 — Confirm with magic link (P3)

Repeat Scenario 2 with a fresh email. Open the link from Mailpit in browser or:

```bash
curl -s "http://localhost:3000/auth/register/confirm/link?token=TOKEN_FROM_EMAIL"
```

**Expected**: Account becomes `active`. Re-opening the same link returns failure without side effects.

---

## Scenario 5 — Resend confirmation (P4)

With a pending registration, wait **≥ 60 seconds**, then:

```bash
curl -s -X POST http://localhost:3000/auth/register/resend \
  -H 'Content-Type: application/json' \
  -d '{"email":"confirm@example.com"}'
```

**Expected**:
- New email in Mailpit
- Previous OTP/link no longer valid

**Too soon** (< 60 s):
```bash
curl -s -X POST http://localhost:3000/auth/register/resend \
  -H 'Content-Type: application/json' \
  -d '{"email":"confirm@example.com"}'
```

**Expected**: HTTP `429` or generic wait message; no additional email.

---

## Scenario 6 — Admin policy independence (P2)

```bash
# Enable recovery flag only — registration behavior unchanged
curl -s -X PATCH http://localhost:3000/admin/settings/confirmation-policy \
  -H 'Content-Type: application/json' \
  -d '{"passwordRecoveryConfirmationEnabled": true}'

# Register with confirmation still off
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"policy@example.com","password":"validpass1"}'
```

**Expected**: Account immediately `active` (registration flag still off).

---

## Scenario 7 — Rate limiting (SC-007)

Send 6+ registration or resend requests for the same email within 10 minutes.

**Expected**: Requests beyond limit return HTTP `429`; audit shows rejected attempts; no excess emails in Mailpit.

---

## Automated Tests

After implementation:

```bash
npm run test          # unit: services, validators, policy logic
npm run test:e2e      # HTTP contracts against test database
npm run test:cov      # coverage report
```

E2E suite MUST cover at minimum: Scenarios 1, 2, 3, and duplicate-email anti-enumeration.

---

## Audit Verification

Query audit table (operator view):

```sql
SELECT event_type, outcome, failure_reason, normalized_email, created_at
FROM registration_audit_events
WHERE normalized_email = 'confirm@example.com'
ORDER BY created_at;
```

**Expected**: Chain of `registration_attempt` → `confirmation_email_sent` → `confirmation_attempt` without any password or OTP columns.
