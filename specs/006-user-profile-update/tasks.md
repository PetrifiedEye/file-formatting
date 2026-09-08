---

description: "Task list for User Profile Update feature"

---

# Tasks: User Profile Update

**Input**: Design documents from `/specs/006-user-profile-update/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/users-profile-update.md](./contracts/users-profile-update.md)

**Tests**: Included — Constitution Principle IV (Test Coverage, NON-NEGOTIABLE) requires unit specs for all new services and e2e coverage for new endpoints.

**Organization**: Tasks are grouped by user story (US1, US2, US3) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Paths are relative to `backend/` (this repo root)

## Path Conventions

Single NestJS backend project. Source under `src/`, e2e tests under `test/`, unit specs colocated with source (`*.spec.ts`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add new dependency, config, and DB schema needed by every user story

- [X] T001 Add `@fastify/multipart` dependency via `npm install @fastify/multipart` (package.json/package-lock.json)
- [X] T002 Register `@fastify/multipart` (with `limits: { fileSize: PHOTO_MAX_SIZE_BYTES, files: 1 }`) and `@fastify/static` (rooted at `ASSETS_DIR`, prefix `/assets/`) in [src/main.ts](../../src/main.ts)
- [X] T003 [P] Add `ASSETS_DIR`, `ASSETS_BASE_URL`, `PHOTO_MAX_SIZE_BYTES` fields in [src/core/config/config.types.ts](../../src/core/config/config.types.ts)
- [X] T004 [P] Add Joi validation rules for `ASSETS_DIR`, `ASSETS_BASE_URL`, `PHOTO_MAX_SIZE_BYTES` (default `5242880`) in [src/core/config/config.validation.ts](../../src/core/config/config.validation.ts)
- [X] T005 [P] Add `ASSETS_DIR`/`ASSETS_BASE_URL`/`PHOTO_MAX_SIZE_BYTES` sample values to `.env.example` (or equivalent env template) if one exists in repo root

**Checkpoint**: Multipart uploads can be received and static assets can be served; config is validated at boot.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure, entities, migration, and RBAC grants that every user story depends on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T006 Create `LocalFileStorageService` (`save(buffer, ext)` writes to `${ASSETS_DIR}/photos/<uuid>.<ext>`, returns relative path; `delete(path)` best-effort) in [src/core/storage/local-file-storage.service.ts](../../src/core/storage/local-file-storage.service.ts)
- [X] T007 [P] Create `StorageModule` exporting `LocalFileStorageService` in [src/core/storage/storage.module.ts](../../src/core/storage/storage.module.ts)
- [X] T008 [P] Unit spec for `LocalFileStorageService` (save writes file & returns path, delete is best-effort/non-throwing) in [src/core/storage/local-file-storage.service.spec.ts](../../src/core/storage/local-file-storage.service.spec.ts)
- [X] T009 Create `EmailChangeChallenge` entity (`user_id`, `new_email` citext, `otp_hash`, `link_token_hash`, `issued_at`, `last_sent_at`, `expires_at`, `attempts_remaining`, `invalidated_at`, `consumed_at`, `created_at`) in [src/modules/users/entities/email-change-challenge.entity.ts](../../src/modules/users/entities/email-change-challenge.entity.ts)
- [X] T010 [P] Create `ProfileAuditEvent` entity (`actor_id`, `target_id` varchar, `action` enum, `outcome` enum, `fields` text[], `created_at`) in [src/modules/users/entities/profile-audit-event.entity.ts](../../src/modules/users/entities/profile-audit-event.entity.ts)
- [X] T011 Create migration `<timestamp>-EmailChangeAndProfileUpdate.migration.ts` in [src/database/migrations/](../../src/database/migrations/): creates `email_change_challenges` table + partial unique index `idx_email_change_challenges_active` on `(user_id) WHERE invalidated_at IS NULL AND consumed_at IS NULL` + index on `link_token_hash`; creates `profile_audit_events` table + index `idx_profile_audit_actor_created` on `(actor_id, created_at)`; extends `users` permission's `actions` array to `['read', 'update', 'update-email']` and grants `update`/`update-email` to the `admin` role
- [X] T012 Register `EmailChangeChallenge` and `ProfileAuditEvent` entities, `StorageModule` import, and new providers in [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts)
- [X] T013 Create `ProfileAuditService.record(...)` (best-effort, try/catch, never throws — mirrors `UsersAuditService.record`) in [src/modules/users/profile-audit.service.ts](../../src/modules/users/profile-audit.service.ts)
- [X] T014 [P] Unit spec for `ProfileAuditService` (record persists row; write failure swallowed, does not throw) in [src/modules/users/profile-audit.service.spec.ts](../../src/modules/users/profile-audit.service.spec.ts)

**Checkpoint**: Storage, entities, migration, RBAC grants, and audit service exist — user story implementation can now begin.

---

## Phase 3: User Story 1 - Self updates own profile fields (Priority: P1) 🎯 MVP

**Goal**: Self (or Admin with `users:update`) can update the allowed profile field set (photo only); `email` or any other field in the same request is rejected with no partial change.

**Independent Test**: Sign in as a user, `PATCH /users/:userId` with a `photo` multipart part → profile reflects new `photoUrl`; retry with an `email` part → 400 and no field changed.

### Tests for User Story 1 ⚠️

- [X] T015 [P] [US1] Unit spec: `UsersService.updatePhoto` stores file via `LocalFileStorageService`, updates `photoUrl`, deletes previous photo best-effort, in [src/modules/users/users.service.spec.ts](../../src/modules/users/users.service.spec.ts)
- [X] T016 [P] [US1] E2E spec covering scenarios 1, 2, and IDOR/RBAC checks from [quickstart.md](./quickstart.md) (self photo upload success; self email-in-body rejected 400; non-admin updating another user rejected 403; unauthenticated 401; nonexistent userId as admin 404) in [test/users-profile-update.e2e-spec.ts](../../test/users-profile-update.e2e-spec.ts)

### Implementation for User Story 1

- [X] T017 [US1] Implement `UsersService.updatePhoto(targetId, fileBuffer, ext)`: validates target exists (404 if not), sniffs magic numbers for JPEG/PNG/WebP (400 if invalid), calls `LocalFileStorageService.save`, updates `user.photoUrl` to `${ASSETS_BASE_URL}/assets/photos/<uuid>.<ext>`, deletes old photo file best-effort after commit, in [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts) (depends on T006, T009 done in Phase 2)
- [X] T018 [US1] Implement `PATCH /users/:userId` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): reads single-file `photo` part via `request.file()`, rejects if any other multipart field name present or `photo` missing (400), auth guard = self OR `AccessConfigService.hasPermission(roles, 'users', 'update')` (403 otherwise), calls `UsersService.updatePhoto`, returns `UserProfileResponseDto` (self shape vs privileged `{id, photo}` shape), applies `@Throttle({ default: { limit: 10, ttl: 60000 } })` (depends on T017)
- [X] T019 [US1] Add Swagger decorators (`@ApiOperation`, `@ApiConsumes('multipart/form-data')`, `@ApiOkResponse`, `@ApiBadRequestResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiTooManyRequestsResponse`) to the new controller method in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T018)
- [X] T020 [US1] Wire `ProfileAuditEvent` write (`action=profile_update`, `fields=['photo']`, `outcome` reflecting success/denied/failure/not_found) around the `PATCH /users/:userId` handler via `ProfileAuditService.record` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T013, T018)

**Checkpoint**: User Story 1 is fully functional and independently testable — self photo update works, email/foreign fields rejected, RBAC/IDOR enforced, audited.

---

## Phase 4: User Story 2 - Self changes email via confirmation (Priority: P2)

**Goal**: Self can initiate an email change, receive an OTP/link, confirm it (with attempt limits, expiry, resend cooldown, single active challenge per user), and have their email updated only on successful confirmation.

**Independent Test**: Initiate an email change, retrieve the OTP from the mail sink, confirm it → email updated, old email no longer authenticates; verify resend cooldown, wrong-code attempt limit, and expiry all reject as specified.

### Tests for User Story 2 ⚠️

- [X] T021 [P] [US2] Unit spec: `EmailChangeService.initiate` invalidates prior active challenge, rejects email already used by another account (409), creates challenge with correct TTL/attempts, sends confirmation in [src/modules/users/email-change.service.spec.ts](../../src/modules/users/email-change.service.spec.ts)
- [X] T022 [P] [US2] Unit spec: `EmailChangeService.resend` enforces `RESEND_INTERVAL_MS` cooldown, rejects when no active challenge, in [src/modules/users/email-change.service.spec.ts](../../src/modules/users/email-change.service.spec.ts)
- [X] T023 [P] [US2] Unit spec: `EmailChangeService.confirm` — success updates email and consumes challenge; wrong code decrements `attempts_remaining`; rejects when expired, when attempts exhausted, when no active challenge, and re-checks email uniqueness at confirm time (race close, 409), in [src/modules/users/email-change.service.spec.ts](../../src/modules/users/email-change.service.spec.ts)
- [X] T024 [P] [US2] E2E spec covering scenario 3 from [quickstart.md](./quickstart.md) (initiate → confirm success; resend before cooldown → 429; wrong code 5 times then correct code still rejected; expired challenge rejected; second initiate invalidates first challenge's OTP) in [test/users-profile-update.e2e-spec.ts](../../test/users-profile-update.e2e-spec.ts)

### Implementation for User Story 2

- [X] T025 [P] [US2] Add `sendEmailChangeConfirmation(user, newEmail, otp, linkToken)` to [src/modules/auth/confirmation-mail.service.ts](../../src/modules/auth/confirmation-mail.service.ts)
- [X] T026 [P] [US2] Create `InitiateEmailChangeDto` (`newEmail: string`, email-format validated) in [src/modules/users/dto/initiate-email-change.dto.ts](../../src/modules/users/dto/initiate-email-change.dto.ts)
- [X] T027 [P] [US2] Create `ConfirmEmailChangeDto` (`code: string`) in [src/modules/users/dto/confirm-email-change.dto.ts](../../src/modules/users/dto/confirm-email-change.dto.ts)
- [X] T028 [US2] Implement `EmailChangeService` (`initiate`, `resend`, `confirm`) in [src/modules/users/email-change.service.ts](../../src/modules/users/email-change.service.ts), following `PasswordResetService.requestReset`/`confirmReset` control flow: reuses `src/modules/auth/utils/confirmation-token.ts` (`generateConfirmationTokens`, `hashSecret`, `CONFIRMATION_TTL_MS`, `RESEND_INTERVAL_MS`); `confirm` wrapped in `@Transactional()`, re-checks `newEmail` uniqueness inside the transaction, decrements `attempts_remaining` on mismatch, invalidates prior challenge on new `initiate` (depends on T009, T025, T026, T027)
- [X] T029 [US2] Implement `POST /users/me/email-change`, `POST /users/me/email-change/resend`, `POST /users/me/email-change/confirm` routes in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): target is always the caller; apply `@Throttle` per [research.md § R7](./research.md#r7-rate-limiting-thresholds) (`3/600000`, `1/60000`, `5/60000` respectively); confirm route returns `UserProfileResponseDto` on success (depends on T028)
- [X] T030 [US2] Add Swagger decorators to the three new controller methods in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T029)
- [X] T031 [US2] Wire `ProfileAuditEvent` writes (`email_change_initiated`/`email_change_sent` on initiate, `email_change_resent` on resend, `email_change_confirmed`/`email_change_failed`/`email_change_expired` on confirm, `fields=['email']`) via `ProfileAuditService.record` in [src/modules/users/email-change.service.ts](../../src/modules/users/email-change.service.ts) (depends on T013, T028)

**Checkpoint**: User Stories 1 AND 2 both work independently — self email-change confirmation flow is complete and audited.

---

## Phase 5: User Story 3 - Admin updates any user's profile or email directly (Priority: P2)

**Goal**: An Admin (holding `users:update`/`users:update-email`) can update another user's photo or email directly, with no confirmation step; Self is forbidden from using the direct email-update operation on any account including their own.

**Independent Test**: Sign in as an admin, `PATCH /users/:otherUserId/email` with a new email → email updated immediately, no OTP; same call targeting the admin's own ID → 403; same call from a non-admin session → 403.

### Tests for User Story 3 ⚠️

- [X] T032 [P] [US3] Unit spec: `UsersService.updateEmailDirect` updates email immediately, rejects email already used by another account (409), in [src/modules/users/users.service.spec.ts](../../src/modules/users/users.service.spec.ts)
- [X] T033 [P] [US3] E2E spec covering scenario 4 from [quickstart.md](./quickstart.md) (admin direct email update success; admin targeting own ID → 403; non-admin caller → 403; nonexistent userId → 404) in [test/users-profile-update.e2e-spec.ts](../../test/users-profile-update.e2e-spec.ts)

### Implementation for User Story 3

- [X] T034 [P] [US3] Create `AdminUpdateEmailDto` (`email: string`, format-validated) in [src/modules/users/dto/admin-update-email.dto.ts](../../src/modules/users/dto/admin-update-email.dto.ts)
- [X] T035 [US3] Implement `UsersService.updateEmailDirect(targetId, newEmail)`: validates target exists (404), rejects if `newEmail` already used by another account (409), updates `user.email` immediately, in [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts) (depends on T034)
- [X] T036 [US3] Implement `PATCH /users/:userId/email` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): guard requires `AccessConfigService.hasPermission(roles, 'users', 'update-email')` AND `userId !== request.user.id` (403 if either fails, including admin targeting self per FR-019), returns `{id, photo, email}`, applies `@Throttle({ default: { limit: 5, ttl: 60000 } })` (depends on T035)
- [X] T037 [US3] Add Swagger decorators to the new controller method in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T036)
- [X] T038 [US3] Wire `ProfileAuditEvent` write (`action=admin_email_update`, `fields=['email']`, `outcome`) around `PATCH /users/:userId/email` via `ProfileAuditService.record` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T013, T036)

**Checkpoint**: All user stories are independently functional — self profile/email updates, confirmation flow, and admin direct updates all work and are audited.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all stories

- [X] T039 [P] Update project README/API docs (if a manually-maintained endpoint list exists) to mention the five new routes
- [X] T040 Run full quickstart.md validation end-to-end against local Postgres (all 5 scenarios + audit trail query) per [quickstart.md](./quickstart.md)
- [X] T041 Run `npm run lint` and `npm run test` (unit) and `npm run test:e2e` to confirm no regressions across `users` and `auth` modules

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — no dependency on US2/US3
- **User Story 2 (Phase 4)**: Depends on Foundational — independent of US1/US3 (does not touch photo/update endpoint)
- **User Story 3 (Phase 5)**: Depends on Foundational — reuses `UsersService`/`ProfileAuditService` from Phase 2/US1 but is independently testable via its own endpoint
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational — independently testable, no shared files with US1 beyond the controller/module (additive routes)
- **User Story 3 (P3)**: Can start after Foundational — independently testable; shares `users.service.ts`/`users.controller.ts` files with US1 (additive methods, not conflicting logic)

### Within Each User Story

- Tests written first, expected to fail before implementation
- DTOs before services
- Services before controller routes
- Controller routes before Swagger decorators and audit wiring
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] (T003, T004, T005) can run in parallel
- Foundational tasks marked [P] (T007, T008, T010, T014) can run in parallel; T006 blocks T007/T008, T009/T010 block T011/T012
- Once Foundational completes, US1, US2, and US3 phases can be worked in parallel by different developers (US3 touches the same files as US1 in `users.service.ts`/`users.controller.ts`, so coordinate merges there)
- Within US1: T015, T016 in parallel; within US2: T021-T024 in parallel, T025-T027 in parallel; within US3: T032, T033 in parallel, T034 standalone

---

## Parallel Example: User Story 2

```bash
# Launch all tests for User Story 2 together:
Task: "Unit spec: EmailChangeService.initiate in src/modules/users/email-change.service.spec.ts"
Task: "Unit spec: EmailChangeService.resend in src/modules/users/email-change.service.spec.ts"
Task: "Unit spec: EmailChangeService.confirm in src/modules/users/email-change.service.spec.ts"
Task: "E2E spec covering scenario 3 in test/users-profile-update.e2e-spec.ts"

# Launch DTOs and mail-service addition for User Story 2 together:
Task: "Add sendEmailChangeConfirmation to src/modules/auth/confirmation-mail.service.ts"
Task: "Create InitiateEmailChangeDto in src/modules/users/dto/initiate-email-change.dto.ts"
Task: "Create ConfirmEmailChangeDto in src/modules/users/dto/confirm-email-change.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run quickstart.md scenarios 1, 2, 5 (photo upload, email rejection, IDOR/RBAC)
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (storage, entities, migration, RBAC grants, audit service)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP — self photo update)
3. Add User Story 2 → Test independently → Deploy/Demo (self email-change confirmation)
4. Add User Story 3 → Test independently → Deploy/Demo (admin direct updates)
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (photo update)
   - Developer B: User Story 2 (email-change confirmation flow)
   - Developer C: User Story 3 (admin direct updates) — coordinate with Developer A on `users.service.ts`/`users.controller.ts` merges
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies (or additive to a shared file with no logical overlap)
- [Story] label maps task to specific user story for traceability
- Every new route MUST get Swagger decorators (Constitution Principle V) and a `ProfileAuditEvent` write (FR-020) — both are explicit tasks in each story phase, not left implicit
- Audit writes are best-effort and must never throw or block the primary request (FR-020, matches existing `UsersAuditService` convention)
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence
