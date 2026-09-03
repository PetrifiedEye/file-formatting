---

description: "Task list for feature implementation"
---

# Tasks: Role-Based Access Control (RBAC)

**Input**: Design documents from `/specs/002-rbac/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/rbac-api.md](./contracts/rbac-api.md),
[quickstart.md](./quickstart.md)

**Tests**: Included — constitution Principle IV ("Test Coverage — NON-NEGOTIABLE") requires unit
tests for all services/controllers/guards and e2e coverage of HTTP contracts and critical flows.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing
of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single NestJS backend project (see [plan.md](./plan.md#project-structure)):
`src/modules/rbac/`, `src/database/migrations/`, `test/*.e2e-spec.ts`.

## Ordering note (US1 vs US2)

Spec lists User Story 1 (access check) before User Story 2 (startup load), both P1. This plan
implements **US2 first**: the access-check guard (US1) mechanically depends on
`AccessConfigService` already holding a loaded snapshot (US2's deliverable) — there is no way to
build or test "allow/deny on a protected action" before the configuration it reads exists. Both
remain P1 / MVP-scope; only the build order within that tier is adjusted, per
[research.md](./research.md#decision-access-configuration-caching-strategy).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project scaffolding for the new module. No new npm dependencies are required — RBAC
reuses `@nestjs/common`, `@nestjs/typeorm`, `class-validator`, `@nestjs/swagger`, and
`typeorm-transactional`, already in `package.json`.

- [X] T001 Create the `src/modules/rbac/` directory tree (`entities/`, `dto/`, `guards/`,
  `decorators/`) per [plan.md](./plan.md#project-structure)
- [X] T002 Create an empty `RbacModule` in `src/modules/rbac/rbac.module.ts` and register it in
  the `imports` array of `src/core/app/app.module.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Entities, migration, and the shared audit service that every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Create `Role` entity (`id`, `name` unique citext, `description`, timestamps) in
  `src/modules/rbac/entities/role.entity.ts` per [data-model.md](./data-model.md#role)
- [X] T004 [P] Create `Permission` entity (`id`, `name` unique citext, `description`,
  `actions: string[]`, timestamps) in `src/modules/rbac/entities/permission.entity.ts` per
  [data-model.md](./data-model.md#permission)
- [X] T005 [P] Create `Grant` entity (`id`, `roleId`/`role` FK, `permissionId`/`permission` FK,
  nullable `actions: string[]`, unique `(role_id, permission_id)`, timestamps) in
  `src/modules/rbac/entities/grant.entity.ts` per [data-model.md](./data-model.md#grant)
- [X] T006 [P] Create `UserRole` entity (composite PK `user_id`+`role_id`, FKs to `users`/`roles`
  with cascade delete) in `src/modules/rbac/entities/user-role.entity.ts` per
  [data-model.md](./data-model.md#userrole--membership--no-dedicated-crud-api-per-spec-assumptions)
- [X] T007 [P] Create `RbacAuditEvent` entity (`eventType`/`outcome` enums, `actorUserId`,
  `entityType`, `entityId`, `reason`, `metadata` jsonb, `createdAt`) in
  `src/modules/rbac/entities/rbac-audit-event.entity.ts` per
  [data-model.md](./data-model.md#auditevent-rbac-specific)
- [X] T008 Create migration `src/database/migrations/<timestamp>-Rbac.migration.ts` creating
  `roles`, `permissions`, `grants`, `user_roles`, `rbac_audit_events` tables with all indexes and
  FK constraints (`ON DELETE RESTRICT` on grants' role/permission FKs, `ON DELETE CASCADE` on
  user_roles, `ON DELETE SET NULL` on audit's actor FK) per [data-model.md](./data-model.md)
  (depends on T003–T007)
- [X] T009 Register all five entities via `TypeOrmModule.forFeature([...])` in
  `src/modules/rbac/rbac.module.ts` (depends on T003–T008)
- [X] T010 [P] Implement `RbacAuditService` (`record(eventType, outcome, context)` following the
  `RegistrationAuditService` pattern in `src/modules/auth/registration-audit.service.ts`) in
  `src/modules/rbac/rbac-audit.service.ts` and register it as a provider in
  `src/modules/rbac/rbac.module.ts` (depends on T007, T009)

**Checkpoint**: Schema and audit logging exist — user story implementation can now begin.

---

## Phase 3: User Story 2 - Load access configuration at startup (Priority: P1)

**Goal**: An in-memory `AccessConfigService` loads the full roles/permissions/grants graph from
the database on startup and exposes `hasPermission(roleNames, permission, action)` for O(1)
in-memory evaluation, with no per-request DB query.

**Independent Test**: Seed roles/permissions/grants directly via repositories, bootstrap the
module, and verify `hasPermission()` results match the seeded data; verify an empty database
yields deny-all.

### Tests for User Story 2

- [X] T011 [P] [US2] Unit tests for `AccessConfigService.buildSnapshot()` and `hasPermission()` —
  full-permission grants, action-scoped grants, union across multiple roles, unknown
  role/permission → deny, empty config → deny-all — in
  `src/modules/rbac/access-config.service.spec.ts` (write first; must fail against a stub)

### Implementation for User Story 2

- [X] T012 [US2] Implement `AccessConfigService` — `onModuleInit()` builds the `AccessSnapshot`
  (roles/permissions maps + `grantsByRole`) from the `Role`/`Permission`/`Grant` repositories per
  [data-model.md](./data-model.md#in-memory-access-configuration-not-persisted), and
  `hasPermission()` evaluates it — in `src/modules/rbac/access-config.service.ts` (depends on
  T009, T011)
- [X] T013 [US2] Add `reload()` to `AccessConfigService`: build the new snapshot from a fresh DB
  read, swap the snapshot reference only on success (readers never see a partial rebuild), keep
  the previous snapshot and log `config_reload_failed` via `RbacAuditService` on DB error, and log
  `config_reloaded` on success, in `src/modules/rbac/access-config.service.ts` (depends on T010,
  T012)
- [X] T014 [US2] Export `AccessConfigService` as a provider of `RbacModule` in
  `src/modules/rbac/rbac.module.ts` (depends on T012)
- [X] T015 [US2] Integration test: seed roles/permissions/grants via repositories before module
  bootstrap, assert the loaded snapshot's `hasPermission()` results match the seed data exactly;
  separately assert an empty database produces deny-all for every check — in
  `src/modules/rbac/access-config.service.spec.ts` (depends on T014)

**Checkpoint**: Configuration loads correctly at startup and is queryable in-memory — independently
verifiable without any HTTP layer.

---

## Phase 4: User Story 1 - Access check for protected actions (Priority: P1) 🎯 MVP

**Goal**: A `PermissionGuard` + `@RequirePermission()` decorator pair that any controller route can
use to enforce `hasPermission()`, returning 401 when unauthenticated and 403 when the user's roles
don't grant the required permission+action.

**Independent Test**: Apply `@RequirePermission()` to a test route; call it as an unauthenticated
request (401), as a user without the grant (403), and as a user with the grant (200); verify a
user with two roles where only one grants access still gets 200.

### Tests for User Story 1

- [X] T016 [P] [US1] Unit tests for `PermissionGuard` — no `request.user` → 401/deny, user with
  non-matching roles → 403/deny, user with a matching grant → allow, user with multiple roles
  where only one grants access → allow (FR-022) — in
  `src/modules/rbac/guards/permission.guard.spec.ts` (write first; must fail against a stub)

### Implementation for User Story 1

- [X] T017 [P] [US1] Create `@RequirePermission(permission: string, action: string)`
  method/class decorator (sets route metadata) in
  `src/modules/rbac/decorators/require-permission.decorator.ts`
- [X] T018 [US1] Implement `PermissionGuard` — reads `@RequirePermission` metadata via
  `Reflector`, denies with `UnauthorizedException` if `request.user` is absent, denies with
  `ForbiddenException` if `AccessConfigService.hasPermission()` returns false, otherwise allows —
  in `src/modules/rbac/guards/permission.guard.ts` (depends on T012, T016, T017)
- [X] T019 [US1] Export `PermissionGuard` and `RequirePermission` from `RbacModule` in
  `src/modules/rbac/rbac.module.ts` so other modules can consume them (depends on T018)
- [X] T020 [P] [US1] e2e test: add a throwaway `@RequirePermission`-guarded test route (or reuse
  an existing one once available in later phases), seed a grant, and verify 200 allow / 403 deny /
  401 unauthenticated / multi-role union via HTTP in `test/rbac-access-check.e2e-spec.ts` (depends
  on T019)

**Checkpoint**: US1 + US2 together deliver the full enforcement mechanism — this is the MVP.

---

## Phase 5: User Story 3 - Dynamic configuration update without restart (Priority: P2)

**Goal**: Prove `AccessConfigService.reload()` (built in Phase 3) gives up-to-date, consistent
access decisions immediately after underlying data changes, with no application restart, and
degrades safely when storage is temporarily unavailable.

**Independent Test**: Mutate a grant directly via its repository while the app is running, call
`reload()`, and confirm `hasPermission()` reflects the change immediately; confirm a reload that
hits a storage error keeps the previous configuration and logs a failure.

### Tests for User Story 3

- [X] T021 [P] [US3] Integration test: insert/update/delete a grant row via `Repository<Grant>`
  while the module is running, call `accessConfigService.reload()`, and verify `hasPermission()`
  reflects the new state on the very next call (no restart) — in
  `src/modules/rbac/access-config.service.spec.ts` (depends on T013)
- [X] T022 [P] [US3] Integration test: mock the repository to throw during a `reload()` call,
  verify the previous snapshot is retained (`hasPermission()` results unchanged) and a
  `config_reload_failed` audit record is written — in
  `src/modules/rbac/access-config.service.spec.ts` (depends on T013)
- [X] T023 [P] [US3] Integration test: verify a `config_reloaded` audit record is written on a
  successful reload, and that readers calling `hasPermission()` mid-rebuild never observe a mix of
  old and new rules (snapshot-reference swap, not in-place mutation) — in
  `src/modules/rbac/access-config.service.spec.ts` (depends on T013)

**Checkpoint**: Reload mechanism is proven correct in isolation — ready for Phase 6–8 CRUD services
to call `reload()` after their own mutations.

---

## Phase 6: User Story 4 - Admin manages roles (Priority: P2)

**Goal**: Full CRUD for roles (`/rbac/roles`), restricted to callers whose roles grant `rbac`
permission with action `manage`, with unique-name enforcement, delete blocked while grants
reference the role, a `reload()` call after every mutation, and an audit record per operation.

**Independent Test**: Create a role, list roles, update its description, attempt a duplicate-name
create (409), attempt delete with and without a dependent grant.

### Tests for User Story 4

- [X] T024 [P] [US4] Unit tests for `RolesService` — create/list/update/delete happy paths,
  duplicate-name conflict, delete blocked when a grant references the role — in
  `src/modules/rbac/roles.service.spec.ts` (write first; must fail against a stub)
- [X] T025 [P] [US4] Unit tests for `RolesController` — routes call the service correctly and are
  decorated with `PermissionGuard`/`@RequirePermission('rbac', 'manage')` — in
  `src/modules/rbac/roles.controller.spec.ts` (write first; must fail against a stub)

### Implementation for User Story 4

- [X] T026 [P] [US4] Create `CreateRoleDto`, `UpdateRoleDto`, `RoleResponseDto` (class-validator
  decorators; `name` required unique 1–100 chars, `description` optional ≤500 chars) in
  `src/modules/rbac/dto/create-role.dto.ts`, `src/modules/rbac/dto/update-role.dto.ts`,
  `src/modules/rbac/dto/role-response.dto.ts`
- [X] T027 [US4] Implement `RolesService` (list/create/update/delete; unique-name check → 409;
  delete blocked by dependent grants → 409; calls `accessConfigService.reload()` and
  `rbacAuditService.record()` after each successful mutation) in
  `src/modules/rbac/roles.service.ts` (depends on T013, T010, T024, T026)
- [X] T028 [US4] Implement `RolesController` (`GET/POST/PATCH/DELETE /rbac/roles`, guarded by
  `PermissionGuard` + `@RequirePermission('rbac', 'manage')`, Swagger
  `@Api...Response`/`@ApiTags('RBAC')` decorators per
  [contracts/rbac-api.md](./contracts/rbac-api.md#roles--rbacroles)) in
  `src/modules/rbac/roles.controller.ts` (depends on T018, T025, T027)
- [X] T029 [US4] Register `RolesController`/`RolesService` in `src/modules/rbac/rbac.module.ts`
  (depends on T028)
- [X] T030 [P] [US4] e2e test covering role CRUD, duplicate-name 409, delete-blocked-by-grant 409,
  and non-admin 403, per [quickstart.md](./quickstart.md#scenario-4--admin-crud--conflict-handling-user-stories-46)
  in `test/rbac-roles.e2e-spec.ts` (depends on T029)

**Checkpoint**: Role management is functional; reload-on-change verified end-to-end for roles.

---

## Phase 7: User Story 5 - Admin manages permissions (Priority: P2)

**Goal**: Full CRUD for permissions (`/rbac/permissions`), each with a required non-empty
`actions` list, unique-name enforcement, delete blocked while grants reference the permission.

**Independent Test**: Create a permission with defined actions, update its action list, attempt a
duplicate-name create (409), attempt delete with and without a dependent grant.

### Tests for User Story 5

- [X] T031 [P] [US5] Unit tests for `PermissionsService` — create/list/update/delete happy paths,
  duplicate-name conflict, empty-actions rejection, delete blocked when a grant references the
  permission — in `src/modules/rbac/permissions.service.spec.ts` (write first; must fail against a
  stub)
- [X] T032 [P] [US5] Unit tests for `PermissionsController` — routes and guard wiring — in
  `src/modules/rbac/permissions.controller.spec.ts` (write first; must fail against a stub)

### Implementation for User Story 5

- [X] T033 [P] [US5] Create `CreatePermissionDto`, `UpdatePermissionDto`,
  `PermissionResponseDto` (`name` required unique, `actions` required non-empty array of unique
  1–50 char strings, `description` optional) in
  `src/modules/rbac/dto/create-permission.dto.ts`,
  `src/modules/rbac/dto/update-permission.dto.ts`,
  `src/modules/rbac/dto/permission-response.dto.ts`
- [X] T034 [US5] Implement `PermissionsService` (list/create/update/delete; unique-name check →
  409; empty-actions → 422; delete blocked by dependent grants → 409; calls
  `accessConfigService.reload()` and `rbacAuditService.record()` after each successful mutation)
  in `src/modules/rbac/permissions.service.ts` (depends on T013, T010, T031, T033)
- [X] T035 [US5] Implement `PermissionsController` (`GET/POST/PATCH/DELETE /rbac/permissions`,
  guarded by `PermissionGuard` + `@RequirePermission('rbac', 'manage')`, Swagger decorators per
  [contracts/rbac-api.md](./contracts/rbac-api.md#permissions--rbacpermissions)) in
  `src/modules/rbac/permissions.controller.ts` (depends on T018, T032, T034)
- [X] T036 [US5] Register `PermissionsController`/`PermissionsService` in
  `src/modules/rbac/rbac.module.ts` (depends on T035)
- [X] T037 [P] [US5] e2e test covering permission CRUD, duplicate-name 409, empty-actions 422,
  delete-blocked-by-grant 409, and non-admin 403, per
  [quickstart.md](./quickstart.md#scenario-4--admin-crud--conflict-handling-user-stories-46) in
  `test/rbac-permissions.e2e-spec.ts` (depends on T036)

**Checkpoint**: Permission management is functional; actions validated end-to-end.

---

## Phase 8: User Story 6 - Admin manages grants (assignments) (Priority: P2)

**Goal**: Full CRUD for grants (`/rbac/grants`) linking a role to a permission, optionally scoped
to a subset of the permission's actions, rejecting duplicate role-permission pairs and
out-of-range actions.

**Independent Test**: Create a grant with full and partial actions, list grants, update action
scope, reject a duplicate role-permission grant, delete a grant.

### Tests for User Story 6

- [X] T038 [P] [US6] Unit tests for `GrantsService` — create with full actions (omitted/empty),
  create with a partial action subset, duplicate role-permission pair → 409, actions outside the
  permission's actions → 422, role/permission not found → 404, update, delete — in
  `src/modules/rbac/grants.service.spec.ts` (write first; must fail against a stub)
- [X] T039 [P] [US6] Unit tests for `GrantsController` — routes, `?roleId=`/`?permissionId=`
  filtering, and guard wiring — in `src/modules/rbac/grants.controller.spec.ts` (write first; must
  fail against a stub)

### Implementation for User Story 6

- [X] T040 [P] [US6] Create `CreateGrantDto`, `UpdateGrantDto`, `GrantResponseDto` (`roleId`,
  `permissionId` required UUIDs on create; `actions` optional array on create/update) in
  `src/modules/rbac/dto/create-grant.dto.ts`, `src/modules/rbac/dto/update-grant.dto.ts`,
  `src/modules/rbac/dto/grant-response.dto.ts`
- [X] T041 [US6] Implement `GrantsService` — wrap the "load permission, validate actions subset,
  upsert grant" sequence in `@Transactional()`; unique `(role_id, permission_id)` → 409;
  actions-not-subset → 422; missing role/permission → 404; calls
  `accessConfigService.reload()` and `rbacAuditService.record()` after each successful mutation —
  in `src/modules/rbac/grants.service.ts` (depends on T013, T010, T038, T040)
- [X] T042 [US6] Implement `GrantsController` (`GET/POST/PATCH/DELETE /rbac/grants`, optional
  `roleId`/`permissionId` query filters, guarded by `PermissionGuard` +
  `@RequirePermission('rbac', 'manage')`, Swagger decorators per
  [contracts/rbac-api.md](./contracts/rbac-api.md#grants--rbacgrants)) in
  `src/modules/rbac/grants.controller.ts` (depends on T018, T039, T041)
- [X] T043 [US6] Register `GrantsController`/`GrantsService` in `src/modules/rbac/rbac.module.ts`
  (depends on T042)
- [X] T044 [P] [US6] e2e test covering grant CRUD, duplicate-pair 409, out-of-range-actions 422,
  and — chaining into the reload mechanism from Phase 5 — an immediate access-check flip
  (`POST` a grant → protected route now allows; `DELETE` it → protected route now denies) per
  [quickstart.md](./quickstart.md#scenario-3--dynamic-update-without-restart-user-story-3) in
  `test/rbac-grants.e2e-spec.ts` (depends on T043, T020)

**Checkpoint**: Grant management is functional; the full "admin changes a grant → access check
outcome flips immediately" loop is verified end-to-end for the first time.

---

## Phase 9: User Story 7 - Audit RBAC changes and access reloads (Priority: P3)

**Goal**: Every management operation, every reload, and every denied management attempt is
captured in `rbac_audit_events` with actor, operation, entity type, and outcome.

**Independent Test**: Perform create/update/delete on roles, permissions, and grants; trigger a
reload; attempt a denied management call; verify each produces the expected audit row.

### Tests for User Story 7

- [X] T045 [P] [US7] Unit test: `PermissionGuard` records a `management_access_denied` audit event
  (actor, attempted operation, denial reason) via `RbacAuditService` when a
  `@RequirePermission('rbac', 'manage')` check fails — in
  `src/modules/rbac/guards/permission.guard.spec.ts` (depends on T018, T010)

### Implementation for User Story 7

- [X] T046 [US7] Extend `PermissionGuard` to call `rbacAuditService.record(...)` with
  `management_access_denied` immediately before throwing `ForbiddenException`, scoped to routes
  guarding the `rbac` permission (avoid audit noise for ordinary application permission checks) —
  in `src/modules/rbac/guards/permission.guard.ts` (depends on T018, T010, T045)
- [X] T047 [P] [US7] e2e test: perform one create/update/delete across roles, permissions, and
  grants; trigger a reload; attempt a denied management call as a non-admin; query
  `rbac_audit_events` and verify each row's `actor_user_id`, `event_type`, `entity_type`,
  `entity_id`, and `outcome` per
  [quickstart.md](./quickstart.md#scenario-5--audit-trail-user-story-7) in
  `test/rbac-audit.e2e-spec.ts` (depends on T029, T036, T043, T046)

**Checkpoint**: Full audit trail is verified across every RBAC operation and reload event.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Consistency, documentation, and final validation across all stories.

- [X] T048 [P] Add `@ApiTags('RBAC')` and consistent Swagger response decorators across
  `RolesController`, `PermissionsController`, `GrantsController` so the generated OpenAPI doc
  matches [contracts/rbac-api.md](./contracts/rbac-api.md)
- [X] T049 Create a bootstrap-admin migration `src/database/migrations/<timestamp>-RbacSeedAdmin.migration.ts`
  that inserts a seed `admin` role, an `rbac` permission with action `manage`, a grant linking
  them, so the first administrator can manage RBAC without a manual SQL step (per
  [data-model.md](./data-model.md#userrole--membership--no-dedicated-crud-api-per-spec-assumptions)
  and the spec's bootstrap assumption)
- [X] T050 Run `npm run lint` and `npm run format` across all new/changed files in
  `src/modules/rbac/` and `src/database/migrations/`
- [X] T051 Run `npm run test` and `npm run test:e2e`; fix any failures across the RBAC unit and
  e2e suites
- [X] T052 Execute every scenario in [quickstart.md](./quickstart.md) against a running local
  stack and confirm actual behavior matches the documented expectations

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **US2 (Phase 3)**: Depends on Foundational only.
- **US1 (Phase 4)**: Depends on Foundational **and** US2 (`PermissionGuard` calls
  `AccessConfigService.hasPermission()`, built in Phase 3).
- **US3 (Phase 5)**: Depends on Foundational and US2 (`reload()` is built in Phase 3; Phase 5 only
  adds tests/hardening around it). Independent of US1 and of US4–6.
- **US4 (Phase 6)**, **US5 (Phase 7)**, **US6 (Phase 8)**: Each depends on Foundational, US1
  (guard/decorator), and US3 (reload semantics they call into). Independent of each other — may be
  built in any order or in parallel by different developers.
- **US7 (Phase 9)**: Depends on US1 (guard to extend) and benefits from US4–6 existing (its e2e
  test exercises all three), though its guard-level unit test (T045) only needs US1.
- **Polish (Phase 10)**: Depends on all desired stories being complete.

### User Story Dependencies (deviating from "mostly independent" only where mechanically required)

- **US2**: No dependency on other stories.
- **US1**: Depends on US2 (see Ordering note above).
- **US3**: Depends on US2 only (tests the `reload()` method US2 builds; does not need any CRUD
  endpoint to exist).
- **US4, US5, US6**: Each depends on US1 (the guard/decorator they apply to their controllers) and
  US3 (the `reload()` behavior they call after mutations). Independent of one another.
- **US7**: Depends on US1 (extends `PermissionGuard`); its e2e test additionally exercises US4–6.

### Within Each User Story

- Tests are written first and must fail before implementation.
- DTOs/entities before services.
- Services before controllers.
- Core implementation before the module-registration task.
- Story complete (checkpoint) before moving to the next phase.

### Parallel Opportunities

- T003–T007 (all five entities) can run in parallel — different files.
- T011 and (once Phase 3 starts) any other Phase-3 test task can run in parallel with Phase-4 test
  authoring (T016), since both only need Foundational — but Phase 4 *implementation* tasks
  (T018+) block on T012 from Phase 3.
- T021, T022, T023 (Phase 5) can run in parallel — independent test scenarios against the same
  already-built `reload()`.
- Once US1 + US3 are done, **US4, US5, and US6 can be built fully in parallel** by different
  developers (T026–T030, T033–T037, T040–T044 touch disjoint files).
- Within each CRUD story, the DTO task and the two `*.spec.ts` test-authoring tasks can run in
  parallel with each other (before the service/controller implementation tasks that depend on
  them).

---

## Parallel Example: Phase 6–8 (once Foundational, US1, US3 are done)

```bash
# Three developers, three user stories, fully in parallel:
Task: "Implement RolesService in src/modules/rbac/roles.service.ts"        # US4 (T027)
Task: "Implement PermissionsService in src/modules/rbac/permissions.service.ts"  # US5 (T034)
Task: "Implement GrantsService in src/modules/rbac/grants.service.ts"      # US6 (T041)
```

## Parallel Example: Phase 2 (Foundational)

```bash
Task: "Create Role entity in src/modules/rbac/entities/role.entity.ts"
Task: "Create Permission entity in src/modules/rbac/entities/permission.entity.ts"
Task: "Create Grant entity in src/modules/rbac/entities/grant.entity.ts"
Task: "Create UserRole entity in src/modules/rbac/entities/user-role.entity.ts"
Task: "Create RbacAuditEvent entity in src/modules/rbac/entities/rbac-audit-event.entity.ts"
```

---

## Implementation Strategy

### MVP First (US2 + US1 only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (schema + audit service).
3. Complete Phase 3: US2 (startup load).
4. Complete Phase 4: US1 (enforcement guard).
5. **STOP and VALIDATE**: seed a role/permission/grant directly in the DB, protect a route with
   `@RequirePermission`, verify allow/deny/401 behavior. This is the enforceable core of RBAC —
   deployable even before any admin UI/API exists (data managed via migration/SQL in the interim).

### Incremental Delivery

1. Setup + Foundational → schema ready.
2. US2 → configuration loads at startup (independently testable).
3. US1 → enforcement works end-to-end (MVP demo: protect one real route with `@RequirePermission`).
4. US3 → reload-without-restart proven (still no admin API yet, but the mechanism is solid).
5. US4 → roles CRUD live (first admin-manageable piece).
6. US5 → permissions CRUD live.
7. US6 → grants CRUD live — now the full "admin changes access, users see it immediately" loop
   works end-to-end via HTTP.
8. US7 → audit trail complete.
9. Polish → seed bootstrap admin, docs, lint, full test run, quickstart validation.

### Parallel Team Strategy

1. Team completes Setup + Foundational + US2 + US1 + US3 together (these are sequential/coupled).
2. Once US3 is done, split: Developer A → US4, Developer B → US5, Developer C → US6 (disjoint
   files, no shared state beyond `AccessConfigService.reload()` which is already stable).
3. Any one developer picks up US7 once US1 is done (doesn't need to wait for US4–6, only its e2e
   test does).

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- US1/US2 build order is swapped relative to the spec's listing for mechanical-dependency reasons
  only (see "Ordering note" above); both remain P1/MVP.
- Verify tests fail before implementing (T011, T016, T024/T025, T031/T032, T038/T039, T045).
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently.
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence beyond
  the mechanically-required ones documented above.
