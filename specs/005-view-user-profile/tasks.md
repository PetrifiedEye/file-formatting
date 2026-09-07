---

description: "Task list for feature 005-view-user-profile"
---

# Tasks: View User Profile

**Input**: Design documents from `/specs/005-view-user-profile/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/get-users-userId.md](./contracts/get-users-userId.md), [quickstart.md](./quickstart.md)

**Tests**: Included — plan.md and the constitution (Principle IV, NON-NEGOTIABLE) require unit + e2e coverage for this feature.

**Organization**: Tasks are grouped by user story (spec.md) to enable independent implementation and testing. All stories share one endpoint (`GET /users/:userId`) and one service method (`UsersService.getProfileFor`), so each story phase incrementally extends that method's branching rather than adding new files — [P] is only used where a task touches a file no other in-flight task touches.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Paths are relative to repository root (`/Users/yauheni/Projects/file-formatting/backend`)

---

## Phase 1: Setup

**Purpose**: Confirm the local environment is ready before adding a migration and new module files.

- [X] T001 Run `npm run migration:run` and `npm run lint` at repository root to confirm the baseline is clean before starting feature work (no code changes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema, entities, and audit plumbing every user story's branch of `getProfileFor` depends on.

**⚠️ CRITICAL**: No user story task may start until this phase is complete.

- [X] T002 [P] Create migration `src/database/migrations/1759900000000-UsersProfile.migration.ts` adding a nullable `photo_url varchar` column to `users` and seeding a `permissions` row `{ name: 'users', description: 'View user profiles', actions: ['read'] }` (follow `1756730200000-RbacSeedAdmin.migration.ts` conventions for `up`/`down`)
- [X] T003 [P] Add `photoUrl` column (`@Column({ name: 'photo_url', type: 'varchar', nullable: true })`, type `string | null`) to `User` in `src/modules/users/entities/user.entity.ts`
- [X] T004 [P] Create `UserProfileAuditEvent` entity (table `user_profile_audit_events`; columns `id` uuid PK, `viewerId` uuid (`viewer_id`, no FK — matches `LoginAuditEvent` precedent), `targetId` varchar (`target_id`, stored as-received/unresolved), `outcome` enum `SELF_VIEW | PRIVILEGED_VIEW | DENIED | NOT_FOUND`, `createdAt` `CreateDateColumn`) in `src/modules/users/entities/user-profile-audit-event.entity.ts`
- [X] T005 Create `UsersAuditService` with `record(viewerId: string, targetId: string, outcome: UserProfileAuditOutcome): Promise<void>` (fire-and-log, never throws — mirror `RbacAuditService.record` in `src/modules/rbac/rbac-audit.service.ts`) in `src/modules/users/users-audit.service.ts` (depends on T004)
- [X] T006 [P] Unit tests for `UsersAuditService.record` (creates and saves an audit row with the given viewer/target/outcome; a repository save failure is swallowed/logged, not rethrown) in `src/modules/users/users-audit.service.spec.ts` (depends on T005)
- [X] T007 Register `TypeOrmModule.forFeature([..., UserProfileAuditEvent])` and provide/export `UsersAuditService` in `src/modules/users/users.module.ts` (depends on T004, T005)
- [X] T008 [P] Create `UserProfileResponseDto` in `src/modules/users/dto/user-profile-response.dto.ts` with `id` (required), `photo` (`string | null`, required), `email` (`@ApiPropertyOptional`), `status` (`@ApiPropertyOptional`), `createdAt` (`@ApiPropertyOptional`) — optional fields are omitted (not `null`) when absent, per FR-006/FR-011 default-deny

**Checkpoint**: Migration, entities, audit service, and response DTO exist — user story implementation can begin.

---

## Phase 3: User Story 1 - View my own profile (Priority: P1) 🎯 MVP

**Goal**: An authenticated user requesting their own profile always gets the full self-profile, regardless of roles.

**Independent Test**: Log in as a user with no special permissions, `GET /users/<own-id>`, verify 200 with `id`, `email`, `photo`, `status`, `createdAt`.

### Tests for User Story 1

- [X] T009 [P] [US1] Unit test: `UsersService.getProfileFor(viewer, targetId)` returns `{ id, email, photo, status, createdAt }` when `targetId === viewer.id`, independent of `viewer.roles` content, in `src/modules/users/users.service.spec.ts`
- [X] T010 [P] [US1] E2E test: authenticated self request to `GET /users/:userId` (own id) returns 200 with full self-profile fields in `test/users-profile.e2e-spec.ts`

### Implementation for User Story 1

- [X] T011 [US1] Implement `UsersService.getProfileFor(viewer: RequestUser, targetId: string): Promise<UserProfileResponseDto>` self-branch: when `targetId === viewer.id`, look up by id and map to the full-field DTO shape (throw `NotFoundException` if somehow missing) in `src/modules/users/users.service.ts` (depends on T008; for now, any `targetId !== viewer.id` throws `ForbiddenException` as a placeholder, refined in US2/US3)
- [X] T012 [US1] Create `UsersController` with `@UseGuards(JwtAuthGuard)` `GET /users/:userId` (param via `ParseUUIDPipe`, malformed values must not leak a raw 400 — catch and re-throw as `NotFoundException`/`ForbiddenException` per the deny/not-found rules refined in later stories) calling `usersService.getProfileFor(request.user, userId)` in `src/modules/users/users.controller.ts` (depends on T011)
- [X] T013 [US1] Register `UsersController` as a controller in `src/modules/users/users.module.ts` (depends on T012)
- [X] T014 [US1] Add Swagger `@ApiTags('users')`, `@ApiOperation`, and `@ApiResponse({ status: 200, type: UserProfileResponseDto })` documentation to `UsersController.getProfile` in `src/modules/users/users.controller.ts` (depends on T012)

**Checkpoint**: Self view is fully functional and independently testable (`npm run test`, `npm run test:e2e -- users-profile`).

---

## Phase 4: User Story 2 - Privileged viewing of another user's profile (Priority: P1)

**Goal**: A viewer holding `users:read` can view another user's profile, restricted to `id` and `photo` only.

**Independent Test**: Log in as a user holding `users:read`, `GET /users/<other-user-id>`, verify 200 with only `id` and `photo` present.

### Tests for User Story 2

- [X] T015 [P] [US2] Unit test: `UsersService.getProfileFor` returns `{ id, photo }` only (no `email`/`status`/`createdAt`) when `targetId !== viewer.id`, the target exists, and `AccessConfigService.hasPermission(viewer.roles, 'users', 'read')` is `true`, in `src/modules/users/users.service.spec.ts`
- [X] T016 [P] [US2] E2E test: privileged viewer requests another existing user's profile and receives 200 with exactly `id` and `photo` fields in `test/users-profile.e2e-spec.ts`

### Implementation for User Story 2

- [X] T017 [US2] Inject `AccessConfigService` into `UsersService` and extend `getProfileFor`'s non-self branch: when `hasPermission(viewer.roles, 'users', 'read')` is `true` and the target exists, return the `{ id, photo }`-only DTO in `src/modules/users/users.service.ts` (depends on T011)

**Checkpoint**: Self view (US1) and privileged view (US2) both work independently.

---

## Phase 5: User Story 3 - Deny access without permission (Priority: P1)

**Goal**: A viewer without `users:read` requesting another user's profile is denied (403), with target existence never disclosed.

**Independent Test**: Log in as a user without `users:read`, `GET /users/<other-existing-id>` and `GET /users/<random-nonexistent-uuid>`, verify both return 403 with no profile fields.

### Tests for User Story 3

- [X] T018 [P] [US3] Unit test: `UsersService.getProfileFor` throws `ForbiddenException` (no lookup of the target's existence performed first) when `targetId !== viewer.id` and `hasPermission` is `false`, in `src/modules/users/users.service.spec.ts`
- [X] T019 [P] [US3] E2E test: non-privileged viewer gets 403 for both an existing other user's id and a random nonexistent uuid, with no profile fields in either response body, in `test/users-profile.e2e-spec.ts`

### Implementation for User Story 3

- [X] T020 [US3] Confirm/adjust `getProfileFor`'s non-self branch so the `hasPermission` check happens before any target-existence lookup, and `false` always throws `ForbiddenException` regardless of whether `targetId` corresponds to a real user, in `src/modules/users/users.service.ts` (depends on T017)

**Checkpoint**: US1–US3 (all P1 stories) work independently — this is the earliest safe deployment point for the endpoint's core access control.

---

## Phase 6: User Story 4 - Handle unauthenticated and not-found cases (Priority: P2)

**Goal**: No/invalid session → 401 before any lookup; authorized-but-missing target (self deleted mid-session, or privileged view of a nonexistent/malformed id) → 404, indistinguishable from each other.

**Independent Test**: Request with no access token → 401. Request as self or as a `users:read` holder for a nonexistent or malformed-uuid target → 404.

### Tests for User Story 4

- [X] T021 [P] [US4] E2E test: request with no/invalid `access_token` cookie returns 401 for any `userId`, in `test/users-profile.e2e-spec.ts`
- [X] T022 [P] [US4] E2E test: self request for a deleted/nonexistent own-id session and privileged request for a nonexistent uuid both return 404, in `test/users-profile.e2e-spec.ts`
- [X] T023 [P] [US4] E2E test: privileged viewer requesting a syntactically malformed `userId` (e.g. `not-a-uuid`) receives 404, not a raw 400, in `test/users-profile.e2e-spec.ts`
- [X] T024 [P] [US4] Unit test: `UsersService.getProfileFor` throws `NotFoundException` for the self-branch when the looked-up user is missing, and for the privileged branch when the target does not exist, in `src/modules/users/users.service.spec.ts`

### Implementation for User Story 4

- [X] T025 [US4] Finalize self-branch `NotFoundException` (deleted mid-session) and privileged-branch `NotFoundException` (target missing) in `UsersService.getProfileFor` in `src/modules/users/users.service.ts` (depends on T020)
- [X] T026 [US4] In `UsersController.getProfile`, catch `ParseUUIDPipe`'s `BadRequestException` for a malformed `userId` and re-dispatch through the same self/privileged/deny decision as if the id were syntactically valid but not found (never let a raw 400 escape) in `src/modules/users/users.controller.ts` (depends on T012, T025)

**Checkpoint**: All P1/P2 stories (US1–US4) complete — full contract from [contracts/get-users-userId.md](./contracts/get-users-userId.md) is satisfied.

---

## Phase 7: User Story 5 - Audit profile views (Priority: P3)

**Goal**: Every terminal outcome (self view, privileged view, denied, not-found) produces a best-effort audit record with viewer id, target id, and outcome — never field values.

**Independent Test**: Perform a self view, a privileged view, and a denied attempt; inspect `user_profile_audit_events` and verify one row per attempt with the correct outcome and no field-value columns.

### Tests for User Story 5

- [X] T027 [P] [US5] Unit test: `UsersService.getProfileFor` calls `UsersAuditService.record` exactly once per invocation with the correct `(viewerId, targetId, outcome)` for each of the four branches (`SELF_VIEW`, `PRIVILEGED_VIEW`, `DENIED`, `NOT_FOUND`), and a rejected `record()` call does not affect the returned/thrown result, in `src/modules/users/users.service.spec.ts`
- [X] T028 [P] [US5] E2E test: running one request per outcome (self, privileged, denied, not-found) results in matching rows in `user_profile_audit_events` with no `email`/`photo` values present, in `test/users-profile.e2e-spec.ts`

### Implementation for User Story 5

- [X] T029 [US5] Inject `UsersAuditService` into `UsersService` and call `record(viewer.id, targetId, outcome)` (best-effort — wrap in try/catch or rely on T005's internal swallow, never blocking the response) at each of the four terminal points in `getProfileFor` in `src/modules/users/users.service.ts` (depends on T025, T007)

**Checkpoint**: All 5 user stories complete and independently verifiable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation against the full contract and quickstart.

- [X] T030 [P] Add `@ApiResponse` entries for 401/403/404/429 to `UsersController.getProfile` in `src/modules/users/users.controller.ts`
- [X] T031 Run `npm run test` and `npm run test:e2e -- users-profile` and confirm all suites pass
- [X] T032 Manually walk through all 5 scenarios in [quickstart.md](./quickstart.md) against a local running instance and confirm responses/audit rows match expectations

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories (T002–T008 must all land before Phase 3).
- **User Story 1 (Phase 3)**: Depends on Foundational. No dependency on other stories.
- **User Story 2 (Phase 4)**: Depends on Foundational + US1's `getProfileFor`/`UsersController` skeleton (T011–T013) existing to extend.
- **User Story 3 (Phase 5)**: Depends on US2 (extends the same non-self branch T017 added).
- **User Story 4 (Phase 6)**: Depends on US3 (extends the same branches with not-found/malformed handling).
- **User Story 5 (Phase 7)**: Depends on US4 (audits every finalized branch, including not-found).
- **Polish (Phase 8)**: Depends on all user stories being complete.

Note: because every story edits `UsersService.getProfileFor` and (for US1/US4) `UsersController.getProfile`, stories 2–5 are **sequential**, not parallelizable across a team, despite being independently *testable* once each lands. This is a direct consequence of the single-endpoint, single-method design (see [research.md](./research.md) §1).

### Parallel Opportunities

- T002, T003, T004, T008 (Foundational) touch different files and can run in parallel.
- Within each story's "Tests" subsection, all `[P]`-marked test tasks run in parallel (different test files, or independent `it()` blocks appended to the same growing spec file by one contributor at a time in practice).
- T006 (audit service unit tests) can run in parallel with T007/T008 once T005 lands.

---

## Parallel Example: Foundational Phase

```bash
# Launch together once Setup is done:
Task: "Create migration 1759900000000-UsersProfile.migration.ts"
Task: "Add photoUrl column to User entity"
Task: "Create UserProfileAuditEvent entity"
Task: "Create UserProfileResponseDto"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (US1 — self view).
3. **STOP and VALIDATE**: self view works end-to-end (T009/T010 pass); every other-user request currently 403s (acceptable placeholder, refined next).
4. Deploy/demo if the self-view-only contract is sufficient for an initial release.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → self view works (MVP).
3. US2 → privileged field-filtered view added.
4. US3 → deny path hardened against existence disclosure.
5. US4 → 401/404/malformed-id edge cases closed; full contract met.
6. US5 → audit trail added (does not change response behavior).
7. Polish → full regression + quickstart walkthrough.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- All stories converge on one file (`users.service.ts`) by design (see research.md §1) — this is intentional, not an anti-pattern to fix.
- Verify unit/e2e tests fail (or don't yet exist as passing) before implementing each story's tasks.
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently before continuing.
