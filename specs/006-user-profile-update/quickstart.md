# Quickstart: Validating User Profile Update

## Prerequisites

- Local Postgres running and migrated: `npm run migration:run`
- `.env` includes `ASSETS_DIR` (e.g. `./assets`), `ASSETS_BASE_URL` (e.g. `http://localhost:3000`), `PHOTO_MAX_SIZE_BYTES` (default `5242880`)
- App running: `npm run start:dev`
- A signed-in regular user session (cookie `access_token`) and a signed-in admin session — reuse the existing login flow (`POST /auth/login`) with a seeded admin-role account (see `test/support/rbac-test-auth.module.ts` for how tests seed roles).
- A small JPEG/PNG/WebP test image under 5MB, and one oversized/invalid file for negative tests.

## Scenario 1 — Self updates own photo (US1, FR-001/006/007, SC-001/002)

```bash
curl -i -b cookies-user.txt \
  -F "photo=@./test-avatar.jpg" \
  http://localhost:3000/users/<selfUserId>
```

Expected: `200`, response JSON includes `photo` pointing at a new `/assets/photos/...` URL; the URL is fetchable unauthenticated (`curl -I <photo_url>` → 200).

## Scenario 2 — Self attempts to change email via general update (US1, FR-002)

```bash
curl -i -b cookies-user.txt \
  -F "email=new@example.com" \
  http://localhost:3000/users/<selfUserId>
```

Expected: `400`, no field changed. Confirm via `GET /users/<selfUserId>` that `email` is unchanged.

## Scenario 3 — Self changes email via confirmation (US2, FR-008..017, SC-005/006)

```bash
curl -i -b cookies-user.txt -H 'Content-Type: application/json' \
  -d '{"newEmail":"new@example.com"}' \
  http://localhost:3000/users/me/email-change
```

Expected: `202`. Retrieve the OTP from the dev mail sink (or logs, per `EmailService` config), then:

```bash
curl -i -b cookies-user.txt -H 'Content-Type: application/json' \
  -d '{"code":"<otp-from-mail>"}' \
  http://localhost:3000/users/me/email-change/confirm
```

Expected: `200`, `GET /users/<selfUserId>` now shows the new email; old email no longer authenticates at `/auth/login`.

Negative checks:
- Resend before 60s: `POST /users/me/email-change/resend` → `429`.
- Wrong code 5 times → 6th attempt still rejected even if correct (`attempts_remaining` exhausted) → `400`.
- Wait past 10 minutes (or adjust `CONFIRMATION_TTL_MS` in a test) → confirm → `400` expired.
- Initiate twice in a row → first challenge invalidated; confirming with the first challenge's old OTP → `400`.

## Scenario 4 — Admin updates another user directly (US3, FR-018/019, SC-008)

```bash
curl -i -b cookies-admin.txt -H 'Content-Type: application/json' \
  -d '{"email":"admin-set@example.com"}' \
  http://localhost:3000/users/<otherUserId>/email
```

Expected: `200`, email changed immediately, no OTP involved.

Negative: same call with `<otherUserId>` replaced by the admin's own ID → `403` (FR-019). Same call from a non-admin session → `403` (SC-004).

## Scenario 5 — IDOR / RBAC checks (FR-004, SC-003/004)

- Non-admin calling `PATCH /users/<someoneElseId>` with a photo → `403`.
- Unauthenticated request (no cookie) to any endpoint above → `401`.
- `PATCH /users/<nonexistentUuid>` (as admin) → `404`.

## Verifying audit trail (FR-020, SC-007)

Query `profile_audit_events` after running the scenarios above; confirm one row per action with `outcome` set correctly and `fields` containing only field *names* (`photo`, `email`) — never the actual uploaded bytes or email string.

```sql
SELECT action, outcome, fields, actor_id, target_id, created_at
FROM profile_audit_events
ORDER BY created_at DESC
LIMIT 20;
```

## Automated coverage

- Unit: `*.spec.ts` for `UsersService` (photo update branch), new `EmailChangeService`, new `ProfileAuditService`, `LocalFileStorageService`.
- E2E: extend `test/users-profile.e2e-spec.ts` or add `test/users-profile-update.e2e-spec.ts` covering scenarios 1-5 above end-to-end against a real (test) Postgres, per existing e2e conventions.
