---

description: "Task list for Delete User Account feature"

---

# Tasks: Delete User Account

**Input**: Design documents from `/specs/008-delete-user-account/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/account-deletion-api.md](./contracts/account-deletion-api.md), [quickstart.md](./quickstart.md)

**Tests**: Included — Constitution Principle IV (Test Coverage, NON-NEGOTIABLE) requires unit specs for all new services and e2e coverage for new endpoints.

**Organization**: Tasks are grouped by user story (US1, US2, US3) to enable independent implementation and testing of each story. All three stories converge on one shared transactional deletion procedure (Phase 2), so US2 and US3 are thin route/permission layers on top of that shared procedure rather than separate deletion logic.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Paths are relative to `backend/` (this repo root)

## Path Conventions

Single NestJS backend project. Source under `src/`, e2e tests under `test/`, unit specs colocated with source (`*.spec.ts`).

---

## Phase 1: Setup

**Purpose**: Confirm the local environment is ready before adding a migration and new module files. No new dependencies or config are required — this feature reuses existing throttler, storage, mail, and RBAC infrastructure.

- [X] T001 Run `npm run migration:run` and `npm run lint` at repository root to confirm the baseline is clean before starting feature work (no code changes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, entities, shared claim-and-delete procedure, and audit plumbing that every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Add nullable `deletionStartedAt` column (`@Column({ name: 'deletion_started_at', type: 'timestamptz', nullable: true })`, type `Date | null`) to `User` in [src/modules/users/entities/user.entity.ts](../../src/modules/users/entities/user.entity.ts)
- [X] T003 [P] Create `AccountDeletionChallenge` entity (table `account_deletion_challenges`; columns `id` uuid PK, `userId` uuid FK → `users.id` `ON DELETE CASCADE`, `otpHash` varchar(64), `linkTokenHash` varchar(64) indexed, `issuedAt`/`lastSentAt` timestamptz default `now()`, `expiresAt` timestamptz, `attemptsRemaining` smallint default 5, `invalidatedAt`/`consumedAt` timestamptz nullable, `createdAt` `CreateDateColumn`; partial unique index `idx_account_deletion_challenges_active` on `(userId)` `WHERE invalidated_at IS NULL AND consumed_at IS NULL`) mirroring [src/modules/users/entities/email-change-challenge.entity.ts](../../src/modules/users/entities/email-change-challenge.entity.ts) in [src/modules/users/entities/account-deletion-challenge.entity.ts](../../src/modules/users/entities/account-deletion-challenge.entity.ts)
- [X] T004 [P] Create `AccountDeletionAuditEvent` entity (table `account_deletion_audit_events`; no FK to `users`; columns `id` uuid PK, `actorId` uuid, `targetId` varchar, `action` enum `AccountDeletionAuditAction` (`self_delete_initiated`, `self_delete_resent`, `self_delete_confirmed`, `self_delete_failed`, `admin_delete`), `outcome` enum `AccountDeletionAuditOutcome` (`success`, `denied`, `failure`, `not_found`, `conflict`), `createdAt` `CreateDateColumn`; index `idx_account_deletion_audit_actor_created` on `(actorId, createdAt)`) mirroring [src/modules/users/entities/profile-audit-event.entity.ts](../../src/modules/users/entities/profile-audit-event.entity.ts) in [src/modules/users/entities/account-deletion-audit-event.entity.ts](../../src/modules/users/entities/account-deletion-audit-event.entity.ts)
- [X] T005 Create migration `src/database/migrations/1760200000000-AccountDeletion.migration.ts` combining, in one `up`/`down` pair (follow the combined style of `1760000000000-EmailChangeAndProfileUpdate.migration.ts`): `ADD COLUMN deletion_started_at timestamptz NULL` on `users`; `account_deletion_challenges` table + partial unique index `idx_account_deletion_challenges_active` + index on `link_token_hash`; `account_deletion_audit_events` table + enum types for `action`/`outcome` + index `idx_account_deletion_audit_actor_created`; extend the `users` permission's `actions` array to `['read', 'update', 'update-email', 'delete']` and grant `delete` to the `admin` role, following the exact `UPDATE permissions.actions` / `UPDATE grants.actions` pattern in [src/database/migrations/1760100000000-AdminUsersReadGrant.migration.ts](../../src/database/migrations/1760100000000-AdminUsersReadGrant.migration.ts) (depends on T002, T003, T004)
- [X] T006 Change `toRelativeAssetPath` in [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts) from `private` to package-internal (no access modifier) so `AccountDeletionService` (a sibling provider in the same module) can convert a user's `photoUrl` back to a relative asset path before deleting the file
- [X] T007 Add `sendAccountDeletionConfirmation(to: string, otp: string, linkToken: string): Promise<void>` to [src/modules/auth/confirmation-mail.service.ts](../../src/modules/auth/confirmation-mail.service.ts), mirroring `sendEmailChangeConfirmation` (link path `/account/delete/confirm?token=...`, subject "Confirm account deletion")
- [X] T008 Create `AccountDeletionAuditService.record(actorId: string, targetId: string, action: AccountDeletionAuditAction, outcome: AccountDeletionAuditOutcome): Promise<void>` (best-effort, try/catch, never throws — mirrors `ProfileAuditService.record`) in [src/modules/users/account-deletion-audit.service.ts](../../src/modules/users/account-deletion-audit.service.ts) (depends on T004)
- [X] T008a Add `redactPriorAuditEmails(userId: string): Promise<void>` to
  `AccountDeletionAuditService` (or as a step inside the shared claim-and-delete procedure in
  `AccountDeletionService`) that, within the same `@Transactional()` deletion transaction, runs
  `UPDATE login_audit_events SET normalized_email = NULL WHERE user_id = :userId` and
  `UPDATE registration_audit_events SET normalized_email = NULL WHERE user_id = :userId`
  — executed *before* the `users` row delete (while `user_id` FK still resolves), so `SET NULL`
  cascade on the FK doesn't race the redaction (depends on T004, T008)
- [X] T009 [P] Unit spec for `AccountDeletionAuditService` (record persists a row with the given actor/target/action/outcome and no PII fields; a repository save failure is swallowed, not rethrown) in [src/modules/users/account-deletion-audit.service.spec.ts](../../src/modules/users/account-deletion-audit.service.spec.ts) (depends on T008)
- [X] T010 Register `AccountDeletionChallenge` and `AccountDeletionAuditEvent` entities in `TypeOrmModule.forFeature([...])`, and provide `AccountDeletionAuditService` (Phase 2) plus `AccountDeletionService` (added in Phase 3) in [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts) (depends on T003, T004, T008)

**Checkpoint**: Migration, entities, mail method, and audit service exist — user story implementation can now begin.

---

## Phase 3: User Story 1 - Self deletes own account (Priority: P1) 🎯 MVP

**Goal**: A signed-in user can request deletion of their own account, confirm it via an emailed code/link within the expiry window, and have their account, PII, and owned files removed; an unconfirmed or expired request deletes nothing.

**Independent Test**: Sign in as a user, `POST /users/me/delete` → capture the emailed code, `POST /users/me/delete/confirm` with the code → verify the account can no longer authenticate and its personal data/photo are gone; verify no deletion occurs without confirming, and that an expired or wrong-code confirmation is rejected.

### Tests for User Story 1 ⚠️

- [X] T011 [P] [US1] Unit spec: `AccountDeletionService.initiateSelfDelete` invalidates any prior active challenge, creates a new challenge with the correct TTL/attempts, and sends the confirmation email, in [src/modules/users/account-deletion.service.spec.ts](../../src/modules/users/account-deletion.service.spec.ts)
- [X] T012 [P] [US1] Unit spec: `AccountDeletionService.resendSelfDelete` enforces the `RESEND_INTERVAL_MS` cooldown (429/`HttpException` before it elapses) and rejects (400) when no active challenge exists, in [src/modules/users/account-deletion.service.spec.ts](../../src/modules/users/account-deletion.service.spec.ts)
- [X] T013 [P] [US1] Unit spec: `AccountDeletionService.confirmSelfDelete` — success atomically claims the row (`deletionStartedAt`), deletes the photo file, deletes the user (cascading challenges/roles), and records `SELF_DELETE_CONFIRMED`/`SUCCESS`; wrong code decrements `attemptsRemaining` and records `SELF_DELETE_FAILED`/`FAILURE`; rejects (400) when expired, when attempts exhausted, or when no active challenge exists; rejects (409) when the row is already claimed by a concurrent deletion, in [src/modules/users/account-deletion.service.spec.ts](../../src/modules/users/account-deletion.service.spec.ts)
- [X] T014 [P] [US1] E2E spec covering Scenarios 1–3 and 9–11 from [quickstart.md](./quickstart.md) (self-delete happy path: initiate → confirm → login fails, DB row gone, photo file gone, audit row has no PII; delete rejected without confirmation; expired confirmation rejected; resend cooldown 429; rate limit 429; wrong code exhausted after 5 attempts) in [test/account-deletion.e2e-spec.ts](../../test/account-deletion.e2e-spec.ts)

### Implementation for User Story 1

- [X] T015 [P] [US1] Create `ConfirmAccountDeletionDto` (`code: string`, required, validated with `class-validator`) in [src/modules/users/dto/confirm-account-deletion.dto.ts](../../src/modules/users/dto/confirm-account-deletion.dto.ts)
- [X] T016 [US1] Implement `AccountDeletionService` in [src/modules/users/account-deletion.service.ts](../../src/modules/users/account-deletion.service.ts) with `initiateSelfDelete(user)`, `resendSelfDelete(user)`, and `confirmSelfDelete(user, code)`, following `EmailChangeService`'s control flow (reuses `src/modules/auth/utils/confirmation-token.ts` for `generateConfirmationTokens`/`hashSecret`/`CONFIRMATION_TTL_MS`/`RESEND_INTERVAL_MS`); `confirmSelfDelete` is wrapped in `@Transactional()` and performs the shared claim-and-delete procedure from [contracts/account-deletion-api.md](./contracts/account-deletion-api.md) § "Shared deletion procedure" (atomic `UPDATE users SET deletion_started_at = now() WHERE id = :id AND deletion_started_at IS NULL`; 0 rows affected → conflict; else read `photoUrl`/`toRelativeAssetPath`, redact prior PII via `redactPriorAuditEmails` (T008a), delete the user row via `UsersService.deleteUser`, then best-effort delete the photo file after commit) (depends on T006, T007, T008, T008a, T015)
- [X] T017 [US1] Implement `POST /users/me/delete`, `POST /users/me/delete/resend`, `POST /users/me/delete/confirm` routes in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): target is always the caller (`request.user.id`); apply `@Throttle` per [research.md § 7](./research.md#7-rate-limiting) (`3/600000`, `1/60000`, `5/60000` respectively); `initiate`/`resend` return `202 Accepted` with `{ message }`, `confirm` returns `200 OK` with `{ message }` (depends on T016)
- [X] T018 [US1] Add Swagger decorators (`@ApiOperation`, `@ApiAcceptedResponse`/`@ApiOkResponse`, `@ApiBadRequestResponse`, `@ApiConflictResponse`, `@ApiUnauthorizedResponse`, `@ApiTooManyRequestsResponse`) to the three new controller methods in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T017)
- [X] T019 [US1] Wire `AccountDeletionAuditEvent` writes (`SELF_DELETE_INITIATED` on initiate, `SELF_DELETE_RESENT` on resend, `SELF_DELETE_CONFIRMED`/`SELF_DELETE_FAILED` on confirm, with `outcome` reflecting success/failure/conflict) via `AccountDeletionAuditService.record` inside [src/modules/users/account-deletion.service.ts](../../src/modules/users/account-deletion.service.ts) (depends on T008, T016)

**Checkpoint**: User Story 1 is fully functional and independently testable — self-deletion request, email confirmation, expiry, attempt limits, idempotency, and audit all work.

---

## Phase 4: User Story 2 - Admin deletes a user's account (Priority: P2)

**Goal**: An administrator holding the `users`/`delete` permission can delete another user's account immediately, with no confirmation step; retrying against an already-deleted account is reported as already removed rather than an error.

**Independent Test**: Sign in as an admin, `DELETE /users/{targetId}` for another user → target can no longer authenticate and their PII/photo are gone, no email sent; repeat the same call → still succeeds/idempotent, no error and no duplicate deletion side effects.

### Tests for User Story 2 ⚠️

- [X] T020 [P] [US2] Unit spec: `AccountDeletionService.adminDelete(targetId)` — success claims and deletes the target (photo file, user row, cascades), records `ADMIN_DELETE`/`SUCCESS`; a target id with no matching row (never existed or already deleted) returns idempotent success/"already removed" without a duplicate deletion and without error; target already mid-deletion (row exists, `deletionStartedAt` set) returns conflict, in [src/modules/users/account-deletion.service.spec.ts](../../src/modules/users/account-deletion.service.spec.ts)
- [X] T021 [P] [US2] E2E spec covering Scenarios 4–5 and 8 from [quickstart.md](./quickstart.md) (admin direct delete success, no email sent, target login fails, audit row `admin_delete`/`success` with admin as actor; repeat delete on same target is idempotent/no error; delete on a never-existed userId returns 200 idempotent "already removed") in [test/account-deletion.e2e-spec.ts](../../test/account-deletion.e2e-spec.ts)

### Implementation for User Story 2

- [X] T022 [US2] Add `adminDelete(targetId: string): Promise<{ message: string }>` to [src/modules/users/account-deletion.service.ts](../../src/modules/users/account-deletion.service.ts), reusing the same `@Transactional()` shared claim-and-delete procedure as `confirmSelfDelete` (no challenge/email involved): no matching row for `targetId` (never existed or already deleted) → idempotent success `{ message: 'already removed' }`; target mid-deletion → `ConflictException` (depends on T016)
- [X] T023 [US2] Implement `DELETE /users/:userId` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): guard requires `AccessConfigService.hasPermission(request.user.roles, 'users', 'delete')` AND `userId !== request.user.id` (403 if either fails — self-deletion always goes through `/me/delete*`), applies `@Throttle({ default: { limit: 5, ttl: 60000 } })`, returns `200 OK` `{ message: 'deleted' }` (depends on T022)
- [X] T024 [US2] Add Swagger decorators (`@ApiOperation`, `@ApiOkResponse`, `@ApiForbiddenResponse`, `@ApiConflictResponse`, `@ApiUnauthorizedResponse`, `@ApiTooManyRequestsResponse`) to the new controller method in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (depends on T023)
- [X] T025 [US2] Wire `AccountDeletionAuditEvent` write (`action=ADMIN_DELETE`, `outcome` reflecting success/already-removed/conflict/denied) via `AccountDeletionAuditService.record` around `DELETE /users/:userId` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts), including the permission/self-target guard's rejection path (`outcome=DENIED`) so every call to this route is audited from first release (depends on T008, T023)

**Checkpoint**: User Stories 1 AND 2 both work independently — self-service and admin-direct deletion paths are both complete and audited.

---

## Phase 5: User Story 3 - Deletion is blocked without the right permission (Priority: P2)

**Goal**: A non-admin caller attempting to delete another user's account is rejected (403) with the target account left untouched; a caller cannot bypass self-deletion's confirmation requirement through the admin route or any elevated permission they may separately hold.

**Independent Test**: Sign in as a user without the `users`/`delete` permission, `DELETE /users/{otherUserId}` → 403, target account still authenticates; confirm no route deletes the caller's own account without a valid confirmation code.

### Tests for User Story 3 ⚠️

- [X] T026 [P] [US3] E2E spec covering Scenarios 6–7 from [quickstart.md](./quickstart.md) (non-admin caller gets 403 on `DELETE /users/:userId` for another user, target remains active and can still sign in; admin caller targeting their own id via `DELETE /users/:userId` also gets 403, confirming self-deletion cannot bypass the confirmation flow regardless of held permissions) in [test/account-deletion.e2e-spec.ts](../../test/account-deletion.e2e-spec.ts)
- [X] T027 [P] [US3] Unit spec: the `DELETE /users/:userId` guard in `UsersController` denies when the caller lacks the `delete` action, and denies when `userId === request.user.id` even if the caller holds `delete`, recording `AccountDeletionAuditAction.ADMIN_DELETE`/`AccountDeletionAuditOutcome.DENIED` in both cases, in [src/modules/users/users.controller.spec.ts](../../src/modules/users/users.controller.spec.ts) (create this spec file if it does not already exist for `UsersController`)

### Implementation for User Story 3

- [X] T028 [US3] Add regression coverage confirming the permission-and-self-target guard from T023 (`hasPermission(..., 'users', 'delete')` AND `userId !== request.user.id`) rejects both failure branches and that each is audited as `DENIED` (wiring already present from T025) before any deletion side effect runs, in [src/modules/users/users.controller.spec.ts](../../src/modules/users/users.controller.spec.ts) (depends on T023, T025)

**Checkpoint**: All user stories are independently functional — self-deletion, admin-direct deletion, and the permission/self-target safeguard all work and are audited (FR-005, SC-002).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all stories

- [X] T029 [P] Update project README/API docs (if a manually-maintained endpoint list exists) to mention the four new routes (`POST /users/me/delete`, `POST /users/me/delete/resend`, `POST /users/me/delete/confirm`, `DELETE /users/:userId`) — N/A: no manually-maintained endpoint list exists in README.md (routes are documented via Swagger decorators only, consistent with the rest of the codebase)
- [X] T030 Run full [quickstart.md](./quickstart.md) validation end-to-end against local Postgres (all 11 scenarios, including the concurrent-deletion conflict race in Scenario 9)
- [X] T031 Run `npm run lint` and `npm run test` (unit) and `npm run test:e2e` to confirm no regressions across `users` and `auth` modules

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — no dependency on US2/US3
- **User Story 2 (Phase 4)**: Depends on Foundational and reuses the shared claim-and-delete procedure implemented in Phase 3 (T016) — implement Phase 3 first even though the two stories are conceptually independent
- **User Story 3 (Phase 5)**: Depends on Foundational and on the guard already added in Phase 4 (T023) — adds coverage and hardening, not new logic
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational, but its service method (T022) extends the same `AccountDeletionService` file/shared procedure built in US1 (T016) — sequence after US1 rather than parallelizing the two service-layer tasks
- **User Story 3 (P3)**: Can start after Foundational; its production code is already present from US2 (T023) — this phase is test-and-verify, independently schedulable once US2's guard exists

### Within Each User Story

- Tests written first, expected to fail before implementation
- DTOs before services
- Services before controller routes
- Controller routes before Swagger decorators and audit wiring
- Story complete before moving to next priority

### Parallel Opportunities

- Foundational tasks marked [P] (T002, T003, T004, T009) can run in parallel; T005 depends on T002/T003/T004; T010 depends on T003/T004/T008
- Within US1: T011–T014 in parallel (all read-only test-writing against not-yet-existing code); T015 standalone
- Within US2: T020, T021 in parallel
- Within US3: T026, T027 in parallel
- Different user stories can be worked on in parallel by different developers once Phase 3's T016 (shared procedure) lands, since US2/US3 only add a thin route/permission layer on top of it

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Unit spec: AccountDeletionService.initiateSelfDelete in src/modules/users/account-deletion.service.spec.ts"
Task: "Unit spec: AccountDeletionService.resendSelfDelete in src/modules/users/account-deletion.service.spec.ts"
Task: "Unit spec: AccountDeletionService.confirmSelfDelete in src/modules/users/account-deletion.service.spec.ts"
Task: "E2E spec covering Scenarios 1-3 and 9-11 in test/account-deletion.e2e-spec.ts"

# Launch the DTO alongside the tests above:
Task: "Create ConfirmAccountDeletionDto in src/modules/users/dto/confirm-account-deletion.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run quickstart.md Scenarios 1-3, 9-11 (self-delete happy path, no-confirmation rejection, expiry, rate limits, exhausted attempts)
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (schema, entities, mail method, audit service)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP — self-service deletion with email confirmation)
3. Add User Story 2 → Test independently → Deploy/Demo (admin-direct deletion, idempotent retries)
4. Add User Story 3 → Test independently → Deploy/Demo (permission/self-target safeguard hardened and verified)
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Developer A implements Phase 3 (US1, including the shared claim-and-delete procedure in T016)
3. Once T016 lands, Developer B implements Phase 4 (US2) and Developer C implements Phase 5 (US3) in parallel, both building on the shared procedure
4. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies (or read-only test-writing against code that doesn't exist yet)
- [Story] label maps task to specific user story for traceability
- Every new route MUST get Swagger decorators (Constitution Principle V) and an `AccountDeletionAuditEvent` write (FR-014) — both are explicit tasks in each story phase, not left implicit
- Audit writes are best-effort and must never throw or block the primary request (FR-014, matches existing `ProfileAuditService`/`UsersAuditService` convention)
- No PII (email, photo contents) may ever be written to `account_deletion_audit_events` — verify this explicitly in T009/T014/T021 unit and e2e assertions (FR-014, SC-005)
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence
