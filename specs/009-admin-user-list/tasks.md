---

description: "Task list for Admin User List feature"

---

# Tasks: Admin User List

**Input**: Design documents from `/specs/009-admin-user-list/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/user-directory.md](./contracts/user-directory.md), [quickstart.md](./quickstart.md)

**Tests**: Included — Constitution Principle IV (Test Coverage, NON-NEGOTIABLE) and [plan.md](./plan.md) require colocated unit specs for `UserDirectoryService` / `UserDirectoryAuditService` / `UserDirectoryAuditFilter` and e2e coverage in `test/users-directory.e2e-spec.ts` for US1–US5.

**Organization**: Tasks are grouped by user story (US1–US5) so each story can be implemented and tested independently. Shared schema, `last_login_at` denormalization, `users.list` seed, and audit plumbing live in Phase 2 because every story depends on them. US1 delivers the MVP listing operation; US2–US5 extend that same `GET /users` handler rather than adding new routes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

## Path Conventions

Single NestJS backend project. Source under `src/`, e2e tests under `test/`, unit specs colocated with source (`*.spec.ts`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the local environment is ready. No new runtime packages or env vars — HMAC cursors reuse `JWT_ACCESS_SECRET`; throttling, RBAC, and Swagger already exist.

- [ ] T001 Run `npm run migration:run` and `npm run lint:check` at repository root to confirm the baseline is clean before starting feature work (no code changes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, entities, `last_login_at` maintenance, `users.list` seed, and audit service that every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T002 [P] Add nullable `lastLoginAt` (`@Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })`, type `Date | null`) to `User` in [src/modules/users/entities/user.entity.ts](../../src/modules/users/entities/user.entity.ts)
- [ ] T003 [P] Create `UserDirectoryAuditEvent` entity (table `user_directory_audit_events`; **no FK** to `users`) in [src/modules/users/entities/user-directory-audit-event.entity.ts](../../src/modules/users/entities/user-directory-audit-event.entity.ts) with: `id` uuid PK `gen_random_uuid()`, `actorId` uuid **nullable**, enum `UserDirectoryAuditOutcome` (`SUCCESS='success'`, `DENIED='denied'`, `UNAUTHENTICATED='unauthenticated'`, `INVALID='invalid'`, `RATE_LIMITED='rate_limited'`), `resultCount` integer nullable, `searchUsed` boolean nullable, `statusFilterUsed` boolean nullable, `sortField` varchar nullable, `createdAt` `CreateDateColumn`; index `idx_user_directory_audit_actor_created` on `(actorId, createdAt)`. Mirror conventions in [src/modules/users/entities/account-deletion-audit-event.entity.ts](../../src/modules/users/entities/account-deletion-audit-event.entity.ts). Do **not** add columns for search text, emails, cursors, or item payloads
- [ ] T004 Create migration [src/database/migrations/1760300000000-AdminUserList.migration.ts](../../src/database/migrations/1760300000000-AdminUserList.migration.ts) combining, in one `up`/`down` pair (follow [src/database/migrations/1760200000000-AccountDeletion.migration.ts](../../src/database/migrations/1760200000000-AccountDeletion.migration.ts)): `ALTER TABLE users ADD COLUMN last_login_at timestamptz NULL`; backfill `last_login_at = MAX(created_at)` from `login_audit_events` where `outcome = 'success'` and `event_type IN ('login_attempt', 'login_verification_attempt')` grouped by `user_id`; create partial indexes `idx_users_directory_created` on `(created_at DESC, id DESC)`, `idx_users_directory_email` on `(email, id)`, `idx_users_directory_last_login` on `(last_login_at DESC, id DESC)` each `WHERE deletion_started_at IS NULL`; create Postgres enum `user_directory_audit_events_outcome_enum` (`success`, `denied`, `unauthenticated`, `invalid`, `rate_limited`) and table `user_directory_audit_events` matching T003; `UPDATE permissions SET actions = ARRAY['read','update','update-email','delete','list'] WHERE name = 'users'`; grant the same array to the `admin` role's `users` grant (no other role). `down` reverses grants to `['read','update','update-email','delete']`, drops indexes/table/enum/column. `POSTGRES_SYNCHRONIZE` stays `false` (depends on T002, T003)
- [ ] T005 Add `stampLastLoginAt(userId: string): Promise<void>` to [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts) as a single-row `UPDATE` setting `lastLoginAt` to `now()` — do **not** fold this into `recordSuccessfulLogin` (that runs on password-ok even when a verification challenge is still required) (depends on T002)
- [ ] T006 Call `usersService.stampLastLoginAt(user.id)` in [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts) only on paths that actually issue access/refresh tokens: after `issueTokens` in `login` when `signInConfirmationEnabled` is false, and after `issueTokens` in `finalizeLoginVerification`. Do **not** call it from `refresh` or from `recordSuccessfulLogin` (depends on T005)
- [ ] T007 [P] Unit specs: `stampLastLoginAt` updates only `lastLoginAt` in [src/modules/users/users.service.spec.ts](../../src/modules/users/users.service.spec.ts); `AuthService.login` stamps when tokens are issued and does not stamp when verification is required; `finalizeLoginVerification` stamps on success; `refresh` does not stamp — in [src/modules/auth/auth.service.spec.ts](../../src/modules/auth/auth.service.spec.ts) (depends on T005, T006)
- [ ] T008 Create `UserDirectoryAuditService.record(input: { actorId: string | null; outcome: UserDirectoryAuditOutcome; resultCount?: number | null; searchUsed?: boolean | null; statusFilterUsed?: boolean | null; sortField?: string | null }): Promise<void>` in [src/modules/users/user-directory-audit.service.ts](../../src/modules/users/user-directory-audit.service.ts) — best-effort try/catch, never throws, never logs search text or emails, mirrors [src/modules/users/account-deletion-audit.service.ts](../../src/modules/users/account-deletion-audit.service.ts) (depends on T003)
- [ ] T009 [P] Unit spec for `UserDirectoryAuditService` (persists actor/outcome/resultCount/option-kind flags with no PII fields; repository save failure is swallowed) in [src/modules/users/user-directory-audit.service.spec.ts](../../src/modules/users/user-directory-audit.service.spec.ts) (depends on T008)
- [ ] T010 Register `UserDirectoryAuditEvent` in `TypeOrmModule.forFeature([...])` and provide `UserDirectoryAuditService` (Phase 2) plus `UserDirectoryService` / `UserDirectoryAuditFilter` (added in later phases) in [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts) (depends on T003, T008)

**Checkpoint**: Foundation ready — migration, `last_login_at`, `users.list` Admin grant, and audit service exist; user story implementation can now begin

---

## Phase 3: User Story 1 - Administrator views a page of users (Priority: P1) 🎯 MVP

**Goal**: An administrator holding `users.list` can `GET /users` and receive one cursor-paginated page of allow-listed user summaries (`id`, `email`, `photo`, `createdAt`, `status`, `lastLoginAt`) with an opaque `nextCursor` when more listable accounts exist.

**Independent Test**: Sign in as Admin, `GET /users` with no search/filters → 200, at most `limit` (default 20) items, each with the allow-listed fields, `nextCursor` set when more rows exist; `GET /users?cursor=<token>` returns the next disjoint page; repeating the same URL returns the same ids.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T011 [P] [US1] Unit spec for `UserDirectoryService.list`: default sort `createdAt DESC, id DESC`; fetch `limit+1` and mint `nextCursor` from row `limit` when an extra row exists else `nextCursor: null`; omit rows with `deletionStartedAt` set; project only allow-listed fields (`photo` from `photoUrl`, never `passwordHash` / `failedLoginAttempts` / `lockedUntil` / `deletionStartedAt`); HMAC cursor round-trip is stable for the same options — in [src/modules/users/user-directory.service.spec.ts](../../src/modules/users/user-directory.service.spec.ts)
- [ ] T012 [P] [US1] E2E spec covering [quickstart.md](./quickstart.md) Scenario 1 (Admin first page of 20 with `nextCursor`, next page disjoint and idempotent, last page `nextCursor: null`, secrets absent) following [test/users-profile.e2e-spec.ts](../../test/users-profile.e2e-spec.ts) / [test/account-deletion.e2e-spec.ts](../../test/account-deletion.e2e-spec.ts) (real JWT cookies, seed Admin `users.list` grant, `AccessConfigService.reload()`) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)

### Implementation for User Story 1

- [ ] T013 [P] [US1] Create `ListUsersQueryDto` in [src/modules/users/dto/list-users-query.dto.ts](../../src/modules/users/dto/list-users-query.dto.ts): `limit` optional int `@Min(1)` `@Max(100)` default 20 (`@Type(() => Number)`); `cursor` optional string; `search` optional string with `@Transform` trim (blank/whitespace → `undefined`); `status` optional `@IsEnum(UserStatus)`; `sort` optional `@IsEnum` of `createdAt` \| `lastLoginAt` \| `email`; `direction` optional `@IsEnum` of `asc` \| `desc`. All fields `@IsOptional()` + `@ApiPropertyOptional`. Global `ValidationPipe` whitelist already applied
- [ ] T014 [P] [US1] Create `UserDirectoryItemDto` in [src/modules/users/dto/user-directory-item.dto.ts](../../src/modules/users/dto/user-directory-item.dto.ts) with required `id`, `email`, `createdAt`, `status` (`UserStatus`) and nullable `photo`, `lastLoginAt` (`@ApiProperty({ nullable: true, type: String })` / `Date`)
- [ ] T015 [P] [US1] Create `UserDirectoryPageDto` in [src/modules/users/dto/user-directory-page.dto.ts](../../src/modules/users/dto/user-directory-page.dto.ts) with `items: UserDirectoryItemDto[]` and `nextCursor: string | null`
- [ ] T016 [US1] Implement `UserDirectoryService` in [src/modules/users/user-directory.service.ts](../../src/modules/users/user-directory.service.ts): inject `Repository<User>` + `ConfigService`; HMAC key = `JWT_ACCESS_SECRET`; cursor format `base64url(json).base64url(hmac-sha256)` with payload `{ v: 1, sort, dir, fp, id, createdAt|email|lastLoginAt }`; `fp` = SHA-256 of `{ search, status, sort, direction, limit }`; query `deletion_started_at IS NULL`, default `ORDER BY created_at DESC, id DESC`, `take: limit+1`; map items by copying only the allow-list; do not `SELECT` secrets. For this story, applying `search` / `status` / non-default `sort` may still be stubs that ignore those fields — pagination + default sort MUST work. Malformed/tampered HMAC → `BadRequestException('Invalid cursor')` without echoing payload (depends on T002, T013, T014, T015)
- [ ] T017 [US1] Implement `GET /users` on [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): declare `@Get()` **above** `@Get(':userId')`; `@Throttle({ default: { limit: 30, ttl: 60000 } })`; `@Query() query: ListUsersQueryDto`; after class-level `JwtAuthGuard`, call `accessConfigService.hasPermission(request.user.roles, 'users', 'list')` (same pattern as `updateProfile` / `adminDeleteUser` — do **not** use `PermissionGuard`); on false, `UserDirectoryAuditService.record` outcome `DENIED` then `ForbiddenException('Insufficient permissions')` with no items; on true, call `UserDirectoryService.list` and `record` outcome `SUCCESS` with `resultCount: items.length` and option-kind flags (no search text). Return `UserDirectoryPageDto` (depends on T008, T013, T016)
- [ ] T018 [US1] Add Swagger decorators on the new handler in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts): `@ApiOperation`, `@ApiOkResponse({ type: UserDirectoryPageDto })`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiTooManyRequestsResponse` (depends on T017)
- [ ] T019 [US1] Provide `UserDirectoryService` in [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts) and inject it into `UsersController`; update [src/modules/users/users.controller.spec.ts](../../src/modules/users/users.controller.spec.ts) providers so existing DELETE-guard tests still compile (depends on T010, T016, T017)

**Checkpoint**: User Story 1 is fully functional and independently testable — Admin can page the directory with a stable cursor and allow-listed fields

---

## Phase 4: User Story 2 - Administrator searches and filters the directory (Priority: P1)

**Goal**: The same `GET /users` operation accepts combinable `search` (email `ILIKE` partial / exact UUID id), `status` (`active` \| `pending_confirmation`), `sort`, and `direction`, still paginated.

**Independent Test**: Seed users with known emails/statuses/`lastLoginAt` (including null); request with search and/or status and a chosen sort; only matching listable users appear, in the requested order, still bounded by `limit`.

### Tests for User Story 2 ⚠️

- [ ] T020 [P] [US2] Unit spec in [src/modules/users/user-directory.service.spec.ts](../../src/modules/users/user-directory.service.spec.ts): email `ILIKE` is case-insensitive and `%`/`_` are escaped; whitespace-only search ≡ omitted; UUID `search` matches `id` exactly (OR email); `status` equality; search AND status are conjunctive; sort `createdAt` / `email` / `lastLoginAt`; `lastLoginAt DESC` uses `NULLS LAST`, `ASC` uses `NULLS FIRST`; omitted options use defaults (no search, all listable statuses, `createdAt` desc)
- [ ] T021 [P] [US2] E2E spec covering [quickstart.md](./quickstart.md) Scenario 2 (email search, id search, status filter, combined search+status, `sort=email&direction=asc`, omitted options = Scenario 1 defaults) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)

### Implementation for User Story 2

- [ ] T022 [US2] Apply `search`, `status`, `sort`, and `direction` inside `UserDirectoryService.list` in [src/modules/users/user-directory.service.ts](../../src/modules/users/user-directory.service.ts): trim already done by DTO; escape `%`/`_` before `email ILIKE '%' || :term || '%'`; if `:term` is a UUID also `OR id = :term`; status equality when provided; keyset `WHERE`/`ORDER BY` on the active sort column plus `id` tie-breaker; cursor payload carries the active sort-key value (`lastLoginAt` may be JSON `null`). Keep `deletion_started_at IS NULL`. Do **not** add `pg_trgm` (depends on T016, T013)
- [ ] T023 [US2] Include option-kind flags on the success audit write in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (`searchUsed` = search present after trim, `statusFilterUsed` = status supplied, `sortField` = effective sort after defaults) with no search text or emails (depends on T017, T022)

**Checkpoint**: User Stories 1 AND 2 both work independently — default paging plus search/filter/sort compose with the same cursor

---

## Phase 5: User Story 3 - Listing is denied without administrator rights (Priority: P1)

**Goal**: Authenticated callers without `users.list` receive 403 and no items; unauthenticated callers receive 401 before any user lookup. Holding `users.read` (or any other `users.*` action) is not sufficient.

**Independent Test**: Sign in as a user granted only `users.read`, `GET /users` → 403 empty of items (that same caller can still `GET /users/:otherId`); no cookie → 401 empty of items.

### Tests for User Story 3 ⚠️

- [ ] T024 [P] [US3] Unit spec in [src/modules/users/users.controller.spec.ts](../../src/modules/users/users.controller.spec.ts): `GET /users` denies when `hasPermission(..., 'users', 'list')` is false (including when `users.read` would be true), records `DENIED`, and does not call `UserDirectoryService.list`
- [ ] T025 [P] [US3] E2E spec covering [quickstart.md](./quickstart.md) Scenario 3 (reader 403 no `items`; anonymous 401 no `items`; `users.read` can fetch a single profile but cannot list) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)

### Implementation for User Story 3

- [ ] T026 [US3] Confirm the T017 guard evaluates `users.list` at request time via `AccessConfigService.hasPermission` (roles from `JwtAuthGuard` / `user_roles`, grants from the in-memory snapshot — not JWT claims) and that 403/401 bodies never include `items`; add any missing deny-path assertions in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) / [src/modules/users/users.controller.spec.ts](../../src/modules/users/users.controller.spec.ts) (depends on T017, T024)

**Checkpoint**: User Stories 1–3 are independently functional — listing works for Admin and is denied without `users.list`

---

## Phase 6: User Story 4 - Invalid listing options are rejected (Priority: P2)

**Goal**: Out-of-range `limit`, unrecognized `status`/`sort`/`direction`, and malformed or fingerprint-mismatched `cursor` are rejected with 400 and no listing payload — never guessed into an unbounded query.

**Independent Test**: As Admin, submit each invalid option in turn (`limit=0`, `limit=101`, `status=blocked`, `sort=displayName`, `direction=up`, `cursor=not-a-token`, page-1 cursor reused with a different `search`) and verify 400 with no `items`.

### Tests for User Story 4 ⚠️

- [ ] T027 [P] [US4] Unit spec in [src/modules/users/user-directory.service.spec.ts](../../src/modules/users/user-directory.service.spec.ts): malformed cursor, failed HMAC, `v !== 1`, and fingerprint mismatch against current `{ search, status, sort, direction, limit }` each throw `BadRequestException` with generic `'Invalid cursor'` (no token/payload in the message) and do not query users
- [ ] T028 [P] [US4] E2E spec covering [quickstart.md](./quickstart.md) Scenario 4 (400 for limit/status/sort/direction/cursor/fingerprint mismatch; no listing payload) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)

### Implementation for User Story 4

- [ ] T029 [US4] Complete cursor verification in [src/modules/users/user-directory.service.ts](../../src/modules/users/user-directory.service.ts): HMAC verify, JSON parse, `v === 1`, fingerprint match; a previously listed account disappearing MUST NOT by itself invalidate the cursor (keyset compares sort keys, not “previous id still exists”) (depends on T016, T022)
- [ ] T030 [US4] Confirm `ListUsersQueryDto` in [src/modules/users/dto/list-users-query.dto.ts](../../src/modules/users/dto/list-users-query.dto.ts) rejects `limit` outside 1–100 and unrecognized `status`/`sort`/`direction` via `class-validator` (ValidationPipe 400 message array is fine; do not execute the directory query). Cursor failures in `UserDirectoryService.list` throw `BadRequestException('Invalid cursor')` and are **not** audited in the handler — `UserDirectoryAuditFilter` (T033) is the sole `invalid` writer (depends on T013, T017, T029)

**Checkpoint**: Invalid options never run a directory query; Stories 1–4 remain independently testable

---

## Phase 7: User Story 5 - Directory access is audited (Priority: P3)

**Goal**: Every `GET /users` attempt writes `user_directory_audit_events` with actor (when known), outcome, result count on success, and option-kind flags — never search text, emails, cursors, or item payloads. 401 and 429 are recorded by a path-gated `APP_FILTER` because those exceptions fire in guards before the handler.

**Independent Test**: Perform a successful list, a 403, a 401, a 400, and overflow the throttle; inspect `user_directory_audit_events` for matching outcomes/`result_count` and zero email/search-phrase columns.

### Tests for User Story 5 ⚠️

- [ ] T031 [P] [US5] Unit spec for `UserDirectoryAuditFilter` in [src/modules/users/user-directory-audit.filter.spec.ts](../../src/modules/users/user-directory-audit.filter.spec.ts): on `GET` with collection path `/users` (no extra segments), `UnauthorizedException` → `UNAUTHENTICATED`, `ThrottlerException` → `RATE_LIMITED`, `BadRequestException` → `INVALID`; ignore other methods/paths (e.g. `GET /users/:userId`); audit save failure does not change the HTTP exception
- [ ] T032 [P] [US5] E2E spec covering [quickstart.md](./quickstart.md) Scenarios 5–6 (one audit row per attempt; success has `result_count = items.length`; reader → `denied`; anonymous → `unauthenticated`; invalid → `invalid`; overflow of the per-route `@Throttle` / global `ThrottlerGuard` → `rate_limited` + HTTP 429 with a matching audit row; columns never contain emails or the search phrase) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)

### Implementation for User Story 5

- [ ] T033 [US5] Create `UserDirectoryAuditFilter` in [src/modules/users/user-directory-audit.filter.ts](../../src/modules/users/user-directory-audit.filter.ts): `@Catch(UnauthorizedException, ThrottlerException, BadRequestException)`; gate to `GET` + collection `/users` (no extra segments); map 401 → `unauthenticated` (`actorId` null), 429 → `rate_limited` (actor id from `request.user` when present), 400 → `invalid` (ValidationPipe and cursor failures). Set option-kind flags from query-key presence only; never persist values. Do **not** catch `ForbiddenException`. Do **not** record `invalid` anywhere else. Best-effort; rethrow/delegate so the original status is unchanged (depends on T008)
- [ ] T034 [US5] Register `UserDirectoryAuditFilter` as `{ provide: APP_FILTER, useClass: UserDirectoryAuditFilter }` in [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts) (Nest feature-module `APP_FILTER` is process-global; the filter’s path gate keeps it from auditing other routes). Provide the class so DI injects `UserDirectoryAuditService`. Do **not** also add `@UseFilters(UserDirectoryAuditFilter)` on [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) (would double-write). (depends on T010, T033)
- [ ] T035 [US5] Verify handler-path audits in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) cover `SUCCESS` (with `resultCount` + option kinds) and `DENIED` only; no `record()` on 400. Confirm no PII is passed into `record()`; a failed audit write must not fail the 200 (depends on T008, T017, T023, T026, T034)

**Checkpoint**: All user stories are independently functional — listing, search, denial, validation, and a complete PII-free audit trail (including 401/429)

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story hardening, deletion-while-paging, and quality gates

- [ ] T036 [P] E2E spec covering [quickstart.md](./quickstart.md) Scenario 7 (delete or start deleting a page-1 account, then request page 2 with the saved cursor → 200, deleted/mid-deletion id absent, no duplicates from page 1) in [test/users-directory.e2e-spec.ts](../../test/users-directory.e2e-spec.ts)
- [ ] T037 [P] Confirm `GET /users` is declared above `@Get(':userId')` in [src/modules/users/users.controller.ts](../../src/modules/users/users.controller.ts) so Fastify never treats the collection as a missing `userId` param
- [ ] T038 Run [quickstart.md](./quickstart.md) validation against local Postgres (Scenarios 1–7) after `npm run migration:run` and `npm run start:dev`
- [ ] T039 Run `npm run format` if Prettier would change files, then `npm run verify` and `npm run test:e2e -- users-directory` — all must pass with zero ESLint warnings in `src/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — no dependency on US2–US5
- **User Story 2 (Phase 4)**: Depends on Foundational and extends `UserDirectoryService.list` from US1 (T016) — sequence after US1 rather than parallelizing the same service file
- **User Story 3 (Phase 5)**: Depends on Foundational and on the `users.list` guard already added in US1 (T017) — primarily tests plus deny-path confirmation
- **User Story 4 (Phase 6)**: Depends on US1 cursor + US2 fingerprint inputs — validation hardening on the same operation
- **User Story 5 (Phase 7)**: Depends on Foundational audit service; filter can be built in parallel with US2–US4 once T008/T010 exist, but e2e Scenario 5 expects Stories 1–4 outcomes to already occur
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational, but T022 edits the same `user-directory.service.ts` as T016 — implement after US1
- **User Story 3 (P1)**: Can start after US1's handler exists (T017); independently testable as a permission matrix
- **User Story 4 (P2)**: Can start after US1 cursor encode/decode exists; fingerprint-mismatch tests need US2 option fields in `fp`
- **User Story 5 (P3)**: Filter (T033) only needs T008; full audit e2e needs US1–US4 HTTP outcomes

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- DTOs before services
- Services before endpoints
- Controller routes before Swagger and remaining audit wiring
- Story complete before moving to next priority (except US3 tests, which can overlap US2)

### Parallel Opportunities

- Foundational [P]: T002, T003 in parallel; T007, T009 after their implementation tasks
- US1 [P]: T011, T012, T013, T014, T015 in parallel (tests + DTOs)
- US2 [P]: T020, T021 in parallel
- US3 [P]: T024, T025 in parallel
- US4 [P]: T027, T028 in parallel
- US5 [P]: T031, T032 in parallel
- Polish [P]: T036, T037 in parallel
- Different developers can split US3 tests vs US2 service work after T017 lands, because they touch `users.controller.spec.ts` / e2e vs `user-directory.service.ts`

---

## Parallel Example: User Story 1

```bash
# Launch all tests and DTOs for User Story 1 together:
Task: "Unit spec for UserDirectoryService.list in src/modules/users/user-directory.service.spec.ts"
Task: "E2E spec Scenario 1 in test/users-directory.e2e-spec.ts"
Task: "Create ListUsersQueryDto in src/modules/users/dto/list-users-query.dto.ts"
Task: "Create UserDirectoryItemDto in src/modules/users/dto/user-directory-item.dto.ts"
Task: "Create UserDirectoryPageDto in src/modules/users/dto/user-directory-page.dto.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Unit spec for search/filter/sort in src/modules/users/user-directory.service.spec.ts"
Task: "E2E spec Scenario 2 in test/users-directory.e2e-spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Admin `GET /users` paginates with a stable cursor and allow-listed fields ([quickstart.md](./quickstart.md) Scenario 1)
5. Deploy/demo if ready — search, extra validation, and full 401/429 audit can follow

### Incremental Delivery

1. Complete Setup + Foundational → schema, `users.list`, `last_login_at` ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP)
3. Add User Story 2 → Search/filter/sort → Deploy/Demo
4. Add User Story 3 → Deny-path coverage (guard already in US1)
5. Add User Story 4 → Invalid options → Deploy/Demo
6. Add User Story 5 → Complete audit including 401/429 → Deploy/Demo
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (then US2 on the same service)
   - Developer B: User Story 3 tests after T017
   - Developer C: User Story 5 filter after T008
3. Stories complete and integrate on the single `GET /users` handler

---

## Notes

- [P] tasks = different files, no dependencies on incomplete work
- [Story] label maps task to US1–US5 from [spec.md](./spec.md)
- Do not use `@RequirePermission` / `PermissionGuard` on this route — match existing `UsersController` explicit `hasPermission` checks ([research.md](./research.md) §2)
- Rate limit is `@Throttle({ default: { limit: 30, ttl: 60000 } })` on `GET /users` only ([research.md](./research.md) §10)
- Audit writes are best-effort and MUST NOT contain search phrases or emails (FR-018)
- `UserDirectoryAuditFilter` is the sole writer for `invalid` / `unauthenticated` / `rate_limited`; register it as `APP_FILTER` in `UsersModule`, not `@UseFilters` on the controller ([research.md](./research.md) §11)
- Commit after each task or logical group
- Stop at any checkpoint to validate the story independently
- Avoid: offset pagination, `SELECT *`, granting `list` because the caller has `users.read`, updating `last_login_at` on password-ok or token refresh
