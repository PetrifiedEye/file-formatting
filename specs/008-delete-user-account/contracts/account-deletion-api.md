# API Contract: Account Deletion

All routes are added to the existing `UsersController` (`src/modules/users/users.controller.ts`),
under `@Controller('users')` with the class-level `@UseGuards(JwtAuthGuard)`. Authentication
(valid access-token cookie) is required for every route below (FR-006); an unauthenticated request
gets `401` from the guard before reaching the handler.

## `POST /users/me/delete`

Initiate self-deletion for the authenticated caller. Mirrors `POST /users/me/email-change`.

- **Throttle**: `{ limit: 3, ttl: 600000 }` (3 per 10 min)
- **Auth**: caller only (no body target — always acts on `request.user.id`)
- **Request body**: none
- **Response `202 Accepted`**: `{ "message": string }` — confirmation sent; nothing deleted yet (FR-001, FR-002, AS-1)
- **`409 Conflict`**: the account is already mid-deletion (`deletionStartedAt` set) — a concurrent confirm/admin-delete has claimed the row (FR-011). Calling this route again while a self-deletion challenge is merely *pending* (not yet mid-deletion) is not a conflict: it invalidates the old challenge and issues a new one, mirroring `EmailChangeService.initiate()`.
- **`429 Too Many Requests`**: rate limit exceeded (FR-013)
- Audit: `SELF_DELETE_INITIATED` / `SUCCESS` on send; failure path audited as `FAILURE`

## `POST /users/me/delete/resend`

Resend the pending self-deletion confirmation. Mirrors `POST /users/me/email-change/resend`.

- **Throttle**: `{ limit: 1, ttl: 60000 }` (1 per min)
- **Response `202 Accepted`**: `{ "message": string }`
- **`400 Bad Request`**: no pending self-deletion request exists
- **`429 Too Many Requests`**: cooldown not yet elapsed, or rate limit exceeded
- Audit: `SELF_DELETE_RESENT` / `SUCCESS`

## `POST /users/me/delete/confirm`

Confirm the pending self-deletion with the emailed code or link token. Mirrors
`POST /users/me/email-change/confirm`.

- **Throttle**: `{ limit: 5, ttl: 60000 }` (5 per min)
- **Request body**: `{ "code": string }` (accepts either the 6-digit OTP or the link token, same
  as `ConfirmEmailChangeDto` / `EmailChangeService.confirm`)
- **Response `200 OK`**: `{ "message": string }` — account access revoked, PII and owned files
  removed (FR-002 AS-2, FR-007, FR-008)
- **`400 Bad Request`**: wrong code, expired challenge, or attempts exhausted — generic message,
  no information leak (matching `GENERIC_CONFIRM_FAILURE` pattern); account remains active (AS-3, AS-4)
- **`409 Conflict`**: account is already mid-deletion (concurrent request won the race) (FR-011)
- **`429 Too Many Requests`**: rate limit exceeded
- Audit: `SELF_DELETE_CONFIRMED` / `SUCCESS` on success; `SELF_DELETE_FAILED` / `FAILURE` on wrong
  code/expired/exhausted; `SELF_DELETE_FAILED` / `CONFLICT` if mid-deletion race lost

## `DELETE /users/:userId`

Admin-direct deletion of another user's account, no confirmation step. Mirrors the permission-check
shape of `PATCH /users/:userId/email` (admin-direct email update).

- **Throttle**: `{ limit: 5, ttl: 60000 }` (5 per min)
- **Auth**: caller must hold the `users` permission's `delete` action
  (`accessConfigService.hasPermission(request.user.roles, 'users', 'delete')`); self-targeting via
  this route is rejected regardless of permission — self-deletion always goes through the
  `/me/delete*` confirmation flow (AS from User Story 3, scenario 2)
- **Response `200 OK`**: `{ "message": "deleted" }` — target account access revoked, PII and owned
  files removed immediately, no email confirmation (FR-004, User Story 2 AS-1)
- **`403 Forbidden`**: caller lacks the `delete` action, or `userId === request.user.id`
  (FR-005, User Story 3 AS-1, AS-2)
- **`200 OK` idempotent no-op**: target user does not exist — either the id never existed, or the
  account was already deleted by a prior call. Both cases resolve to the same `SELECT` finding no
  row, so both return `{ "message": "already removed" }` rather than a `404` (FR-010, FR-012,
  User Story 2 AS-2, Edge Cases). This deliberately does not distinguish "never existed" from
  "already deleted," matching SC-004.
- **`409 Conflict`**: target account is currently mid-deletion in another transaction (FR-011)
- **`429 Too Many Requests`**: rate limit exceeded
- Audit: `ADMIN_DELETE` / `SUCCESS`, `DENIED`, `NOT_FOUND`, or `CONFLICT` as appropriate

## Shared deletion procedure (used by both self-confirm and admin-delete)

Executed inside one `@Transactional()` method:

1. Atomically claim the row: `UPDATE users SET deletion_started_at = now() WHERE id = :id AND deletion_started_at IS NULL`.
2. If 0 rows affected: `SELECT` the user by id — no row → not-found/already-removed outcome; row
   found → conflict outcome. Return without further side effects.
3. If 1 row affected: read `photoUrl`, compute the relative asset path
   (`UsersService.toRelativeAssetPath`), delete the user row (cascades `user_roles`,
   `email_change_challenges`, `account_deletion_challenges` via FK `ON DELETE CASCADE`).
3a. Redact PII in unrelated audit history: `UPDATE login_audit_events SET normalized_email = NULL
    WHERE user_id = :id` and the same for `registration_audit_events` (FR-009).
4. After the transaction commits, best-effort delete the photo file via
   `LocalFileStorageService.delete()` (file deletion happens after commit, matching the existing
   `updatePhoto` ordering — DB is the source of truth; a failed file unlink is logged, not thrown).
5. Record the audit entry (best-effort, try/catch, never affects the response — matching
   `UsersService.recordAudit`).

## Swagger/OpenAPI

Each new route MUST carry `@ApiOperation`, `@ApiOkResponse`/`@ApiAcceptedResponse`,
`@ApiBadRequestResponse`, `@ApiConflictResponse`,
`@ApiForbiddenResponse` (admin route only), `@ApiUnauthorizedResponse`, and
`@ApiTooManyRequestsResponse` decorators, matching the density already present on every existing
route in `users.controller.ts` (Principle V: OpenAPI docs MUST reflect the actual running
contract).
