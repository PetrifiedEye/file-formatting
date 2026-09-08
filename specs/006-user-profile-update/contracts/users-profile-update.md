# API Contract: User Profile Update

All endpoints require `JwtAuthGuard` (cookie `access_token`). All responses on validation/access failure follow existing Nest exception-filter JSON shape (`{ statusCode, message, error }`). Success responses use `UserProfileResponseDto` unless noted.

## 1. `PATCH /users/:userId` — update allowed profile field (photo)

**Auth**: Self (`userId === request.user.id`) OR `AccessConfigService.hasPermission(roles, 'users', 'update')`.

**Request**: `multipart/form-data`, exactly one part named `photo` (file). Any other part name present (including `email`) → reject whole request.

| Status | Condition |
|---|---|
| 200 | Photo stored, `photoUrl` updated, returns `UserProfileResponseDto` (self shape if self, `{id, photo}` if privileged) |
| 400 | No `photo` part present; photo fails type/size validation; unrecognized field present |
| 401 | Not authenticated |
| 403 | Not self and lacks `users:update` permission |
| 404 | `userId` does not exist |
| 429 | Rate limit exceeded (`limit: 10, ttl: 60000`) |

**Side effects**: `ProfileAuditEvent` (`action=profile_update`, `fields=['photo']`, `outcome`) recorded regardless of outcome. Previous photo file deleted best-effort after DB commit.

## 2. `POST /users/me/email-change` — initiate email change (Self only)

**Auth**: any authenticated user; target is always the caller.

**Request body**: `{ "newEmail": string }` (validated: email format).

| Status | Condition |
|---|---|
| 202 | Pending challenge created, confirmation sent to `newEmail`; generic message returned, does not leak whether `newEmail` was already taken beyond the FR-009 rejection |
| 400 | `newEmail` invalid format |
| 409 | `newEmail` already the confirmed email of another account (FR-009) |
| 401 | Not authenticated |
| 429 | Rate limit exceeded (`limit: 3, ttl: 600000`) |

**Side effects**: any prior active challenge for the caller is invalidated (FR-017). `ProfileAuditEvent` (`action=email_change_initiated` then `email_change_sent`, `fields=['email']`).

## 3. `POST /users/me/email-change/resend` — resend confirmation (Self only)

**Request body**: none.

| Status | Condition |
|---|---|
| 202 | New OTP/link issued for the existing active challenge, `last_sent_at` updated |
| 400 | No active pending challenge for the caller |
| 429 | Cooldown not elapsed (`RESEND_INTERVAL_MS` = 60s) or rate limit exceeded (`limit: 1, ttl: 60000`) |

**Side effects**: `ProfileAuditEvent` (`action=email_change_resent`).

## 4. `POST /users/me/email-change/confirm` — confirm pending email change (Self only)

**Request body**: `{ "code": string }` (accepts either the 6-digit OTP or the magic-link token, same dual-check as `PasswordResetService.confirmReset`).

| Status | Condition |
|---|---|
| 200 | Email updated to `newEmail`, challenge consumed, returns `UserProfileResponseDto` |
| 400 | Wrong code (attempts decremented), expired, no active challenge, or attempts exhausted — generic message, no detail leak (matches `GENERIC_CONFIRM_FAILURE` pattern) |
| 401 | Not authenticated |
| 409 | `newEmail` became taken by another account between initiate and confirm (race close) |
| 429 | Rate limit exceeded (`limit: 5, ttl: 60000`) |

**Side effects**: `ProfileAuditEvent` (`action=email_change_confirmed` on success, `email_change_failed` on each rejected attempt, `email_change_expired` when the specific rejection reason is expiry).

## 5. `PATCH /users/:userId/email` — admin direct email update

**Auth**: `AccessConfigService.hasPermission(roles, 'users', 'update-email')` AND `userId !== request.user.id` (FR-019 — forbidden even for an admin acting on themselves; use this operation's confirmation-free path only on *other* accounts).

**Request body**: `{ "email": string }` (format-validated).

| Status | Condition |
|---|---|
| 200 | Email updated immediately, no confirmation step, returns `{id, photo, email}` |
| 400 | Invalid email format |
| 401 | Not authenticated |
| 403 | Caller lacks `users:update-email` permission, or caller targeted themselves |
| 404 | `userId` does not exist |
| 409 | `email` already in use by another account |
| 429 | Rate limit exceeded (`limit: 5, ttl: 60000`) |

**Side effects**: `ProfileAuditEvent` (`action=admin_email_update`, `fields=['email']`, `outcome`).

## Cross-cutting

- Every endpoint above writes exactly one (or, for confirm, potentially a sequence of) `ProfileAuditEvent` row(s), best-effort (never fails the primary request) — see [data-model.md](../data-model.md#entity-profileauditevent-new).
- `Swagger`/OpenAPI decorators (`@ApiOperation`, `@ApiOkResponse`, `@ApiForbiddenResponse`, etc.) MUST be added on every new controller method per Constitution Principle V, mirroring the existing `UsersController.getProfile` style.
