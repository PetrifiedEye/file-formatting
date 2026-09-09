# Quickstart: Validating Account Deletion

Prerequisites: local Postgres running, migrations applied, app started
(`npm run start:dev`), and a mailbox capture for local email (however the existing email-change
flow is validated in this environment — same transport, `src/core/email/email.service.ts`).

All requests below assume the same cookie-based session pattern used by existing e2e tests
(`extractSessionCookie` helper in `test/users-profile-update.e2e-spec.ts`): sign in first and
reuse the `access_token` cookie.

## Scenario 1 — Self-deletion, happy path (User Story 1, P1)

1. Register/sign in as `user@example.com`; capture the session cookie.
2. `POST /users/me/delete` → expect `202`, body contains a confirmation message. Check the test
   mailbox for a code/link addressed to `user@example.com`.
3. `POST /users/me/delete/confirm` with `{ "code": "<the emailed code>" }` → expect `200`.
4. Attempt to sign in again as `user@example.com` → expect authentication failure (account gone).
5. Verify in the DB: no `users` row for that id; no `email_change_challenges` /
   `account_deletion_challenges` rows for that id; if the user had a profile photo, its file is
   removed from `ASSETS_DIR/photos/`.
6. Verify an `account_deletion_audit_events` row exists with `action = 'self_delete_confirmed'`,
   `outcome = 'success'`, and does **not** contain the user's email or any PII value.

**Maps to**: FR-001, FR-002, FR-007, FR-008, FR-014, SC-001, SC-003, SC-005.

## Scenario 2 — Self-deletion rejected without confirmation (User Story 1, AS-3)

1. Sign in as a user; do not call `/users/me/delete`.
2. Attempt to sign in again → still succeeds (account untouched), confirming no route exists to
   delete without going through the confirm step.

**Maps to**: FR-002.

## Scenario 3 — Self-deletion confirmation expires (User Story 1, AS-4)

1. `POST /users/me/delete` to create a challenge.
2. Wait past the 10-minute expiry window (or, in a test, manipulate `expiresAt` directly in the DB
   as other email-change tests do).
3. `POST /users/me/delete/confirm` with the original code → expect `400`, account remains active.

**Maps to**: FR-003, Edge Cases (expired confirmation).

## Scenario 4 — Admin deletes another user directly (User Story 2, P2)

1. Sign in as a user holding the `admin` role (granted the `users`/`delete` permission).
2. Sign in as a separate target user; capture their id.
3. As the admin, `DELETE /users/{targetId}` → expect `200`, no email sent to the target.
4. Attempt to sign in as the target → fails.
5. Verify `account_deletion_audit_events` has an `action = 'admin_delete'`, `outcome = 'success'`
   row with the admin as `actorId` and the target as `targetId`.

**Maps to**: FR-004, User Story 2 AS-1, SC-002 (partially), SC-003, SC-005.

## Scenario 5 — Admin re-deletes an already-deleted account (User Story 2, AS-2)

1. Repeat Scenario 4, then call `DELETE /users/{targetId}` again for the same id.
2. Expect a success/"already removed" response, not an error, and no new deletion side effects
   (no second audit `success` entry for a deletion that already happened — or an idempotent
   `not_found`/`already_removed` audit outcome, per implementation).

**Maps to**: FR-010, SC-004.

## Scenario 6 — Non-admin cannot delete another user (User Story 3, P2)

1. Sign in as a user without the `users`/`delete` permission.
2. `DELETE /users/{otherUserId}` for any other existing user → expect `403`.
3. Verify the other user's account is unaffected (can still sign in).

**Maps to**: FR-005, User Story 3 AS-1, SC-002.

## Scenario 7 — Non-admin cannot bypass self-confirmation even with other elevated rights

1. Sign in as a user who holds some other permission but not a bypass for self-deletion (there is
   no direct "self-delete without confirmation" route at all — only `/users/me/delete*` exists,
   which always requires the confirm step).
2. Confirm no route/parameter combination deletes the caller's own account without a valid
   confirmation code.

**Maps to**: User Story 3 AS-2.

## Scenario 8 — Deletion targeting a nonexistent user

1. As an admin, `DELETE /users/{randomUuid}` for an id that never existed → expect `200` with an
   already-removed message (idempotent no-op, same shape as re-deleting an already-deleted user).

**Maps to**: FR-012, Edge Cases.

## Scenario 9 — Concurrent deletion attempts (conflict)

1. Trigger two near-simultaneous `DELETE /users/{targetId}` calls (or one admin-delete racing a
   self-confirm for the same user) → the loser gets `409 Conflict`, the winner gets `200`; the
   account ends up deleted exactly once.

**Maps to**: FR-011, Edge Cases.

## Scenario 10 — Rate limiting

1. Call `POST /users/me/delete/resend` twice within 60 seconds → the second call gets `429`.
2. Call `POST /users/me/delete` (or `/confirm`) more than its configured limit within its window →
   subsequent calls get `429`.

**Maps to**: FR-013, Edge Cases (rapid repeated requests).

## Scenario 11 — Wrong confirmation code attempts exhausted

1. `POST /users/me/delete` to create a challenge.
2. `POST /users/me/delete/confirm` with an incorrect code 5 times (or however many attempts the
   challenge allows) → each returns `400`; after the limit, further attempts (even with the
   correct code) are rejected and the account remains active.

**Maps to**: FR-003, Edge Cases (repeated incorrect confirmation attempts).

Automated coverage for all of the above belongs in a new
`test/account-deletion.e2e-spec.ts`, following the existing scaffold in
`test/users-profile-update.e2e-spec.ts` (Fastify test app via `AppModule`, direct repository
injection for fixtures, `supertest` for HTTP calls, `extractSessionCookie` helper), plus unit tests
(`*.spec.ts`) for the new service(s) alongside `src/modules/users/`.
