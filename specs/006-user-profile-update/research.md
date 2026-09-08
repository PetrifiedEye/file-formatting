# Phase 0 Research: User Profile Update

## R1. Multipart photo upload with Fastify

**Decision**: Add `@fastify/multipart` and register it in `main.ts` (`app.register(multipart, { limits: { fileSize: PHOTO_MAX_SIZE_BYTES, files: 1 } })`). In `UsersController.updateProfile`, read the request via `request.file()` (single-file API) rather than `attachFieldsToBody`, so the general-update endpoint stays a pure "upload a photo" operation.

**Rationale**: `attachFieldsToBody` plus running the merged body through `class-validator` would let a JSON `email` field slip in as a text part; FR-002/FR-003 require rejecting the *entire* request if any field outside the allowed set (photo only) is present. It's simpler and more auditable to: (a) reject if the multipart request contains any field name other than the single file part `photo`, (b) reject if `photo` is missing, before doing anything else. This is a manual check in the service/controller, not a DTO — there is no text-field DTO to validate because the allowed field set for this endpoint is `{ photo }` and nothing else (FR-024).

**Alternatives considered**: `attachFieldsToBody: 'keyValues'` + `UpdateProfileDto` with `forbidNonWhitelisted: true` — rejected as needless indirection for a single-file endpoint; would also require a second global `ValidationPipe` config since the app-wide pipe only sets `whitelist: true` (silent strip), not `forbidNonWhitelisted` (hard reject), and changing the global pipe risks affecting unrelated endpoints.

## R2. Photo validation (type/size)

**Decision**: Enforce `fileSize` limit via the multipart plugin's `limits.fileSize` (streams-safe, rejects mid-upload once exceeded — satisfies the edge case "upload fails midway → existing photo unchanged"). Validate the image type by sniffing the first bytes of the buffered stream against known magic numbers for JPEG (`FF D8 FF`), PNG (`89 50 4E 47`), and WebP (`RIFF....WEBP`), not by trusting the client-supplied `Content-Type` or filename extension.

**Rationale**: No image-sniffing library is currently a dependency; adding one (`file-type`) is unnecessary for three well-known magic-number signatures. Trusting `mimetype`/filename alone is a known spoofing vector and conflicts with Principle II (Input Validation & Security).

**Alternatives considered**: Add `file-type` npm package — rejected as an avoidable new dependency for a 3-format allowlist.

## R3. Local asset storage & serving

**Decision**: New shared module `src/core/storage/` (`LocalFileStorageService`, `StorageModule`) writes validated photo buffers to `${ASSETS_DIR}/photos/<uuid>.<ext>` and returns a relative public path. `main.ts` registers `@fastify/static` (already a dependency) rooted at `ASSETS_DIR` under URL prefix `/assets/`. `photoUrl` stored on `User` is `${ASSETS_BASE_URL}/assets/photos/<uuid>.<ext>`. The previous photo file is deleted (best-effort, non-blocking) after the DB update commits, per the "photo replaced not retained" assumption.

**Rationale**: Constitution Principle I places shared infrastructure under `src/core/`; this storage mechanism is generic (any future feature needing local file storage can reuse it), while the *decision* of what may be uploaded (image, 5MB) stays in the `users` module. `@fastify/static` is already a project dependency, confirming static serving was anticipated but never wired up.

**Alternatives considered**: Serve photos through a authenticated NestJS controller route streaming from disk — rejected; the spec assumption states the URL must be "resolvable by clients without requiring separate authentication, consistent with how other static assets are served," which is exactly what `@fastify/static` provides with less code.

## R4. Email-change confirmation flow

**Decision**: Reuse the existing OTP/link-token primitives in `src/modules/auth/utils/confirmation-token.ts` (`generateConfirmationTokens`, `hashSecret`, `CONFIRMATION_TTL_MS`, `RESEND_INTERVAL_MS`) exactly as `PasswordResetService` does. Add a new entity `EmailChangeChallenge` (mirrors `PasswordResetChallenge` shape: `userId`, `newEmail`, `otpHash`, `linkTokenHash`, `issuedAt`, `expiresAt`, `attemptsRemaining`, `lastSentAt`, `invalidatedAt`, `consumedAt`) and a new `EmailChangeService` in the `users` module implementing `initiate`, `resend`, `confirm`, following `PasswordResetService.requestReset`/`confirmReset` control flow (invalidate-prior-then-create, `@Transactional()` on confirm, attempt decrement on mismatch, single active challenge per user via the same partial-unique-index pattern).

**Rationale**: This is a Non-Negotiable per the request ("reuse the SAME pattern... rather than reinvent it") and matches Constitution Principle I (consistent module layout) — the confirmation mechanics are already proven and tested elsewhere in the codebase.

**Alternatives considered**: Reuse `PasswordResetChallenge` table directly with a `purpose` discriminator column — rejected; mixing password-reset and email-change semantics in one table complicates the "one active per user" partial index and the audit trail, and the codebase's own precedent (separate `ConfirmationChallenge`, `LoginChallenge`, `PasswordResetChallenge` tables) is one table per challenge type.

**New field**: `lastSentAt` (not present on `PasswordResetChallenge`) is needed because email-change supports an explicit **resend** endpoint (FR-016 cooldown), whereas password reset does not expose a resend operation — cooldown is measured from `lastSentAt`, updated on both initiate and resend.

## R5. RBAC for admin operations

**Decision**: Extend the existing `users` permission's `actions` array (currently `['read']`) to include `update` (general profile update on another user) and `update-email` (direct email update). Grant these actions to the `admin` role via a new migration, following the `AccessConfigService.hasPermission(roles, 'users', action)` pattern already used in `UsersService.getProfileFor`. Self-access for the general update endpoint is a code-level check (`targetId === actor.id`), not a permission grant — mirroring the existing self-view branch.

**Rationale**: Keeps one coherent permission system (`rbac` module) instead of introducing the simpler `AdminGuard` (`src/modules/settings/guards/admin.guard.ts`) for this feature, so permission grants stay centrally auditable/reconfigurable like every other privileged users-module operation.

**Alternatives considered**: Use `AdminGuard` (hardcoded `admin` role check) for the admin-only endpoints — rejected for inconsistency; the sibling "view profile" capability already uses `AccessConfigService`, and the spec's "Only one administrative permission tier is assumed" assumption is naturally expressed as one permission with distinct actions, not a separate guard mechanism.

## R6. Audit logging for update/email-change events

**Decision**: New entity `ProfileAuditEvent` (separate table from the existing view-only `UserProfileAuditEvent`) with `actorId`, `targetId`, `action` (enum: `PROFILE_UPDATE`, `EMAIL_CHANGE_INITIATED`, `EMAIL_CHANGE_SENT`, `EMAIL_CHANGE_RESENT`, `EMAIL_CHANGE_CONFIRMED`, `EMAIL_CHANGE_FAILED`, `EMAIL_CHANGE_EXPIRED`, `ADMIN_EMAIL_UPDATE`), `fields` (`text[]`, field *names* only — never values), `outcome` (enum: `SUCCESS`, `DENIED`, `FAILURE`, `NOT_FOUND`), `createdAt`. A new `ProfileAuditService.record(...)` is called the same best-effort way as `UsersAuditService.record` (wrapped in try/catch, failures never break the response — FR-020/SC-007 combined with the codebase's existing best-effort audit convention).

**Rationale**: The existing `user_profile_audit_events` table's `outcome` enum (`self_view`/`privileged_view`/`denied`/`not_found`) is purpose-built for *viewing*; reusing it for update/email-change events would conflate two different action types in one column and force a wider, less legible enum. A new table keeps each audit surface's schema minimal, matching the one-table-per-concern precedent (`login_audit_events`, `rbac_audit_events`, `user_profile_audit_events`).

**Alternatives considered**: Extend `UserProfileAuditEvent` with an `action` column — rejected as a breaking migration on an already-shipped table for a conceptually distinct event stream.

## R7. Rate limiting thresholds

**Decision**: Follow the existing `@nestjs/throttler` + `@Throttle({ default: { limit, ttl } })` per-route override pattern from `auth.controller.ts`:
- `PATCH /users/:userId` (photo update): `limit: 10, ttl: 60000` (frequent but bounded self-service action).
- `POST /users/me/email-change` (initiate): `limit: 3, ttl: 600000` (10 min window, mirrors `EMAIL_CAP_WINDOW_MS`/`EMAIL_CAP_MAX` constants already defined for confirmation email caps).
- `POST /users/me/email-change/resend`: `limit: 1, ttl: 60000` (same shape as the existing password-reset-request throttle; business-logic cooldown via `lastSentAt` is the primary control, throttle is defense-in-depth).
- `POST /users/me/email-change/confirm`: `limit: 5, ttl: 60000` (mirrors existing confirm-attempt throttles at `auth.controller.ts:178/207/269`).
- `PATCH /users/:userId/email` (admin direct): `limit: 5, ttl: 60000`.

**Rationale**: Reuses numbers and shapes already established and presumably tuned in this codebase rather than inventing new policy, matching the spec's assumption that rate limits "follow the same general abuse-prevention approach already used elsewhere."

## Summary of unresolved items

None — all Technical Context fields below are resolved; no NEEDS CLARIFICATION remains.
