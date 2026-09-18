---

description: "Task list for Transformation History (feature 012)"
---

# Tasks: Transformation History

**Input**: Design documents from `/specs/012-transformation-history/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/transformation-history-api.md](./contracts/transformation-history-api.md), [quickstart.md](./quickstart.md)

**Tests**: Included. The plan's Constitution Check marks Test Coverage NON-NEGOTIABLE and names the exact unit/e2e coverage required (cursor cross-user/cross-filter rejection, permission/existence ordering, non-throwing audit, all six user stories, every invalid-input case, an audit row for every reachable outcome).

**Organization**: Tasks are grouped by user story (spec.md priorities P1/P1/P1/P2/P2/P3) so each story is independently testable per its own Acceptance Scenarios / Independent Test.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on another incomplete task in its batch)
- **[Story]**: US1–US6, mapped to spec.md's six user stories
- File paths are exact, relative to the repository root

## Path Conventions

Single existing NestJS backend project. New module: `src/modules/transformation-history/`. Edited existing modules: `src/modules/conversion/`, `src/modules/image-conversion/`, `src/core/app/app.module.ts`. New migration: `src/database/migrations/`. New e2e spec: `test/`.

---

## Phase 1: Setup

**Purpose**: Establish the new module's file skeleton per [plan.md](./plan.md)'s Project Structure, so Foundational and per-story tasks have files to fill in rather than create from scratch mid-logic.

- [X] T001 Create the `src/modules/transformation-history/` skeleton: `transformation-history.module.ts` (empty `@Module({})` shell), `transformation-history.controller.ts` (`@Controller('api/transformations') @ApiTags('transformation-history') @UseGuards(JwtAuthGuard)` class shell with a constructor but no route-handler methods yet), and `transformation-history.service.ts` (`@Injectable()` class shell with a constructor but no methods yet)

**Checkpoint**: New module directory exists with empty, correctly-decorated class shells.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Everything every one of the six user stories needs before it can be exercised at all: the `transformation_type` schema change to the shared `conversion_records` table (and the two writers that populate it), the RBAC permission/grant seed, the response/query DTOs, and the base keyset-cursor query service (self and admin routes are the *same* query parameterized by whose history is read — see [research.md §4](./research.md)).

**⚠️ CRITICAL**: No user story task should start before this phase is complete.

- [X] T002 [P] Add `TransformationType` enum (`FILE = 'file'`, `IMAGE = 'image'`) to `src/modules/conversion/conversion.enums.ts`, alongside the existing `ConversionOutcome`/`RecordedFormat`/`ConversionErrorCategory` enums
- [X] T003 [P] Create migration `src/database/migrations/1761400000000-TransformationHistory.migration.ts` (continues the existing timestamp sequence after `1761300000000-ImageConversion.migration.ts`). `up()`, in order: (1) `CREATE TYPE "transformation_type" AS ENUM ('file','image')` then `ALTER TABLE "conversion_records" ADD COLUMN "transformation_type" "transformation_type"` (nullable); (2) backfill `UPDATE "conversion_records" SET "transformation_type" = CASE WHEN "source_format" IN ('png','jpeg','svg') OR "target_format" IN ('png','jpeg','svg') THEN 'image' ELSE 'file' END`; (3) `ALTER TABLE "conversion_records" ALTER COLUMN "transformation_type" SET NOT NULL`; (4) `CREATE INDEX "idx_conversion_records_user_created" ON "conversion_records" ("user_id", "created_at" DESC)`; (5) seed the permission: `INSERT INTO "permissions" ("id","name","description","actions") VALUES (gen_random_uuid(), 'transformation-history', '...', ARRAY['read-any']) ON CONFLICT ("name") DO NOTHING`; (6) seed the grant: `INSERT INTO "grants" ("id","role_id","permission_id","actions") SELECT gen_random_uuid(), roles.id, permissions.id, ARRAY['read-any'] FROM "roles" roles, "permissions" permissions WHERE roles.name='admin' AND permissions.name='transformation-history' ON CONFLICT ("role_id","permission_id") DO NOTHING` (mirrors `1760600000000-SettingsPermissionAndAudit.migration.ts`'s permission+grant pattern); (7) `CREATE TYPE "transformation_history_audit_outcome" AS ENUM ('success','denied','not_found','unauthenticated','invalid','rate_limited')`; (8) `CREATE TABLE "transformation_history_audit_events"` with columns per [data-model.md](./data-model.md) (`id` uuid PK, `actor_user_id` uuid NOT NULL no FK, `target_user_id` uuid nullable no FK, `outcome` enum NOT NULL, `result_count` integer nullable, `type_filter_used`/`source_format_filter_used`/`target_format_filter_used`/`status_filter_used`/`date_range_filter_used` boolean NOT NULL DEFAULT false, `created_at` timestamptz DEFAULT now()); (9) two indexes: `idx_transformation_history_audit_actor_created (actor_user_id, created_at DESC)`, `idx_transformation_history_audit_target_created (target_user_id, created_at DESC)`. `down()` reverses in exact opposite order: drop both audit indexes, drop the audit table, drop the audit outcome enum, delete the grant row(s) (join on permission name, since `grants.permission_id` has `ON DELETE RESTRICT` — mirror `SettingsPermissionAndAudit`'s down()), delete the permission row, drop `idx_conversion_records_user_created`, `ALTER COLUMN` drop NOT NULL then drop the `transformation_type` column, drop the `transformation_type` enum type
- [X] T004 Add `transformationType: TransformationType` column to `src/modules/conversion/entities/conversion-record.entity.ts` (`@Column({ type: 'enum', enum: TransformationType, enumName: 'transformation_type' })`), plus `@Index('idx_conversion_records_user_created', ['userId', 'createdAt'])` at the class level alongside the two existing `@Index` decorators (depends on T002)
- [X] T005 Add a required `transformationType: TransformationType` field to the `ConversionAttempt` interface in `src/modules/conversion/conversion-history.service.ts` (depends on T002)
- [X] T006 [P] Update the `this.history.record({...})` call site in `src/modules/conversion/conversion.service.ts` (~line 156, inside the `finally` block) to pass `transformationType: TransformationType.FILE` (depends on T005)
- [X] T007 [P] Update the `this.history.record({...})` call site in `src/modules/image-conversion/image-conversion.service.ts` (~line 184, inside the `finally` block) to pass `transformationType: TransformationType.IMAGE` (depends on T005)
- [X] T008 [P] Update fixtures/expectations in `src/modules/conversion/conversion.service.spec.ts` and `src/modules/conversion/conversion-history.service.spec.ts` to include `transformationType` so the existing feature-010 suites keep passing with the new required field (depends on T006)
- [X] T009 [P] Update fixtures/expectations in `src/modules/image-conversion/image-conversion.service.spec.ts` to include `transformationType` (depends on T007)
- [X] T010 [P] Create `src/modules/transformation-history/transformation-history.enums.ts` with `TransformationHistoryStatus { SUCCESS = 'success', ERROR = 'error' }` (API-facing only, not persisted — translated to/from `ConversionOutcome` at the query boundary per [research.md §3](./research.md))
- [X] T011 [P] Create `src/modules/transformation-history/dto/transformation-history-item.dto.ts` — `TransformationHistoryItemDto` with exactly `id: string`, `type: TransformationType`, `sourceFormat: RecordedFormat | null`, `targetFormat: RecordedFormat | null`, `status: TransformationHistoryStatus`, `fileSize: number`, `durationMs: number`, `errorCode?: ConversionErrorCategory`, `createdAt: string`, each with `@ApiProperty()`/`@ApiPropertyOptional()` per [contracts/transformation-history-api.md](./contracts/transformation-history-api.md)'s example body — no other field (FR-013/FR-014)
- [X] T012 [P] Create `src/modules/transformation-history/dto/transformation-history-page.dto.ts` — `TransformationHistoryPageDto` with `items: TransformationHistoryItemDto[]` (`@ApiProperty({ type: [TransformationHistoryItemDto] })`) and `nextCursor: string | null` (`@ApiProperty({ nullable: true, type: String })`), matching `UserDirectoryPageDto`'s shape exactly
- [X] T013 [P] Create `src/modules/transformation-history/dto/transformation-history-query.dto.ts` with only `limit?: number` (`@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)`, default 20) and `cursor?: string` (`@IsOptional() @IsString()`) for now — filter fields are added in T027 (US4), matching `ListUsersQueryDto`'s validation style
- [X] T014 Implement `src/modules/transformation-history/transformation-history.service.ts` (fills the T001 shell): inject `@InjectRepository(ConversionRecord)` and `ConfigService`; copy `UserDirectoryService`'s keyset-cursor mechanics (`src/modules/users/user-directory.service.ts`) — `CURSOR_VERSION` const, `CursorPayload { v, fp, subjectUserId, id, createdAt }` (the one addition over the `/users` precedent: `subjectUserId` binds the cursor to whose history is being read, per [research.md §4](./research.md)), `computeFingerprint({ subjectUserId, limit })` (SHA-256 hex of the effective-options JSON), `encodeCursor`/`decodeCursor` (HMAC-SHA256 over `JWT_ACCESS_SECRET` via `ConfigService`, `timingSafeEqual` comparison, throws `BadRequestException` on any mismatch — bad signature, wrong version, or `fp` mismatch), `base64UrlEncode`/`base64UrlDecode` helpers, `applyKeyset` on `(created_at, id)` tuple comparison descending, and a public `async getHistory(subjectUserId: string, query: TransformationHistoryQueryDto): Promise<TransformationHistoryPageDto>` that: selects an explicit column list (no `SELECT *`) filtered to `user_id = subjectUserId`, fetches `limit + 1` rows ordered `created_at DESC, id DESC`, slices to page, sets `nextCursor` only when more rows exist, and translates `outcome` → `status` (`success`/`failure` → `success`/`error`) and `error_category` → `errorCode` (present only when `status === 'error'`) per [research.md §3](./research.md) (depends on T004, T010, T011, T012, T013, T001)
- [X] T015 [P] Unit tests in `src/modules/transformation-history/transformation-history.service.spec.ts`: cursor encode/decode round-trip, tampered-signature cursor rejected, wrong-version cursor rejected, a cursor minted for one `subjectUserId` rejected when decoded against a different `subjectUserId` (cross-user replay — the property `research.md §4` calls out as the one addition over `/users`), `hasMore`/`nextCursor` null-on-last-page, explicit column selection (assert no `originalFileName`/`failureReason`/`storedFileId`/other-user fields leak onto the returned item), and `outcome`/`error_category` → `status`/`errorCode` translation (depends on T014)
- [X] T016 [P] Fill `src/modules/transformation-history/transformation-history.module.ts` (the T001 shell): `imports: [TypeOrmModule.forFeature([ConversionRecord])]`, `providers: [TransformationHistoryService]` (depends on T014, T001)
- [X] T017 Register `TransformationHistoryModule` in the `imports` array of `src/core/app/app.module.ts`, after `ImageConversionModule` (depends on T016)

**Checkpoint**: Foundation ready — the app boots with the new module loaded (no routes exposed yet); `TransformationHistoryService.getHistory()` is independently unit-testable. User story implementation can now begin.

---

## Phase 3: User Story 1 - A user reviews their own transformation history (Priority: P1) 🎯 MVP

**Goal**: An authenticated user retrieves one page of their own file and image transformation history, most recent first, with no permission required beyond being signed in (FR-001).

**Independent Test**: Sign in as a user with several file and image transformations, request `GET /api/transformations/history` with no filters, and verify a bounded page of that user's own records is returned, newest first, with no other user's records.

- [X] T018 [US1] Add the self route to `src/modules/transformation-history/transformation-history.controller.ts` (fills the T001 shell): `@Get('history')`, `@Throttle({ default: { limit: 30, ttl: 60000 } })`, binds `@Query() query: TransformationHistoryQueryDto` through the global `ValidationPipe`, reads `request.user.id` (set by `JwtAuthGuard`), calls `transformationHistoryService.getHistory(request.user.id, query)`, returns `TransformationHistoryPageDto`; `@ApiOperation`, `@ApiOkResponse({ type: TransformationHistoryPageDto })`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiTooManyRequestsResponse` (depends on T014, T017, T001)
- [X] T019 [US1] Unit tests in `src/modules/transformation-history/transformation-history.controller.spec.ts`: self route calls `getHistory` with `request.user.id` (not any other id), returns the service's page DTO unchanged (depends on T018)
- [X] T020 [US1] Create `test/transformation-history.e2e-spec.ts`, structured like `test/users-directory.e2e-spec.ts` (boot `AppModule` on Fastify, real `app.listen(0, '127.0.0.1')`, pull `ConversionRecord`/`Role`/`Permission`/`Grant`/`UserRole`/`User` repositories plus `AccessConfigService`/`ThrottlerStorageService`, a `clearThrottler()` helper, seed a plain user + log in via `POST /auth/login` extracting the `access_token` cookie, a `seedHistoryRows(userId, ...)` helper inserting fixture rows directly via the `ConversionRecord` repository with varied `transformationType`/formats/`outcome`/`createdAt`). Add Scenario 1 (US1) tests: unfiltered self history returns only that user's file+image records newest-first; fewer-than-one-page history returns all records with `nextCursor: null`; a returned item has exactly `id, type, sourceFormat, targetFormat, status, fileSize, durationMs, createdAt` (+`errorCode` only when `status === 'error'`) via `Object.keys(item).sort()`; a user with no history gets `{ items: [], nextCursor: null }` with 200 (depends on T018)

**Checkpoint**: User Story 1 is fully functional and independently testable — self-service history read works end-to-end.

---

## Phase 4: User Story 2 - An administrator reviews a specific user's transformation history (Priority: P1)

**Goal**: A caller holding `transformation-history:read-any` retrieves a specific user's transformation history by account id, with the same paging/filtering contract as the self route (FR-002).

**Independent Test**: Sign in as an admin holding the permission, request the history of a known user by id, and verify the page contains only that user's records; requesting a non-existent id returns 404.

- [X] T021 [US2] Update `src/modules/transformation-history/transformation-history.module.ts` to also `import` `RbacModule` (for `AccessConfigService`) and `UsersModule` (for `UsersService.findById`) (depends on T017)
- [X] T022 [US2] Add the admin route to `src/modules/transformation-history/transformation-history.controller.ts`: `@Get('history/:userId')`, `@Param('userId', ParseUUIDPipe) userId: string`, `@Throttle({ default: { limit: 20, ttl: 60000 } })`; inject `AccessConfigService` and `UsersService`; handler first calls `accessConfigService.hasPermission(request.user.roles, 'transformation-history', 'read-any')` — throw `ForbiddenException` immediately if false (before any existence check, per User Story 3 Scenario 1 and [research.md §9](./research.md)'s ordering); then `usersService.findById(userId)` — throw `NotFoundException` if not found; else `transformationHistoryService.getHistory(userId, query)`; `@ApiOperation`, `@ApiOkResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiTooManyRequestsResponse` (depends on T018, T021)
- [X] T023 [US2] Unit tests in `src/modules/transformation-history/transformation-history.controller.spec.ts`: permission granted + user exists → calls `getHistory(userId, query)` and returns 200; permission granted + user missing → throws `NotFoundException` (depends on T022)
- [X] T024 [US2] E2E Scenario 2 in `test/transformation-history.e2e-spec.ts`: admin (seeded with the `admin` role + `transformation-history`/`read-any` grant, `accessConfigService.reload()` called after seeding) reads an existing user's history and gets only that user's records, formatted identically to Scenario 1; a well-formed but non-existent `userId` → 404; a malformed (non-UUID) `:userId` → 400 (depends on T022, T020)

**Checkpoint**: User Story 2 is fully functional and independently testable — admin oversight read works end-to-end.

---

## Phase 5: User Story 3 - Access to another user's history is denied without the oversight permission (Priority: P1)

**Goal**: A caller without `transformation-history:read-any` is refused with 403 when requesting another user's history, regardless of whether that account exists; unauthenticated requests get 401 on both routes; the self route never requires the permission (FR-003, FR-004).

**Independent Test**: Sign in as a user without the permission, request another user's history by id, and verify 403 with no records disclosed, for both an existing and a non-existing target id.

- [X] T025 [US3] Unit tests in `src/modules/transformation-history/transformation-history.controller.spec.ts`: a caller without the permission on the admin route → `ForbiddenException`, and `usersService.findById` is **not** called (permission check precedes existence check); the self route succeeds for a caller who holds no permissions at all (depends on T022)
- [X] T026 [US3] E2E Scenario 3 in `test/transformation-history.e2e-spec.ts`: a non-admin user requesting another user's history (both an existing target and a random UUID) → 403 in both cases, no `items` in the body; an unauthenticated request (no cookie) to both `GET /api/transformations/history` and `GET /api/transformations/history/:userId` → 401; a non-admin requesting their own history via the self route → 200 (depends on T024)

**Checkpoint**: All three P1 user stories (US1, US2, US3) are complete — this is the MVP. Self read, admin oversight read, and the authorization boundary between them all work and are independently tested.

---

## Phase 6: User Story 4 - Narrowing history with filters (Priority: P2)

**Goal**: Either route accepts `type`, `sourceFormat`, `targetFormat`, `status`, and an inclusive `createdAtFrom`/`createdAtTo` range, combinable with AND semantics (FR-010).

**Independent Test**: As a user with mixed file/image, success/error records, request history with each filter individually and combined, and verify only matching records return.

- [X] T027 [US4] Extend `src/modules/transformation-history/dto/transformation-history-query.dto.ts` with `type?: TransformationType` (`@IsOptional() @IsEnum(TransformationType)`), `sourceFormat?: RecordedFormat` and `targetFormat?: RecordedFormat` (`@IsOptional() @IsEnum(RecordedFormat)`), `status?: TransformationHistoryStatus` (`@IsOptional() @IsEnum(TransformationHistoryStatus)`), `createdAtFrom?: string` and `createdAtTo?: string` (`@IsOptional() @IsISO8601()`) (depends on T013)
- [X] T028 [US4] Extend `src/modules/transformation-history/transformation-history.service.ts`'s `getHistory` query builder to apply each supplied filter as an additional `AND` predicate (`type` → `transformation_type`; `status` → translated to `outcome = 'success'/'failure'`; `sourceFormat`/`targetFormat` direct; `createdAtFrom`/`createdAtTo` → inclusive `created_at BETWEEN`), and extend `computeFingerprint` to hash the full effective option set (`{ subjectUserId, type, sourceFormat, targetFormat, status, createdAtFrom, createdAtTo, limit }`) so a cursor minted under one filter combination is rejected under another (depends on T014, T027)
- [X] T029 [US4] Unit tests in `src/modules/transformation-history/transformation-history.service.spec.ts`: each filter applied individually and in combination returns only matching rows; changing any filter between two calls with the same cursor causes `decodeCursor` to reject it (fingerprint mismatch → `BadRequestException`) (depends on T028)
- [X] T030 [US4] E2E Scenario 4 in `test/transformation-history.e2e-spec.ts`: filter by `type`, by `sourceFormat`/`targetFormat`, by `status` (only `error`-status items carry `errorCode`), by `createdAtFrom`/`createdAtTo` (inclusive boundaries), combined filters (every returned record satisfies all of them), a combination matching nothing → 200 with `{ items: [], nextCursor: null }`, and the admin route filters identically to the self route (depends on T028, T026)

**Checkpoint**: User Story 4 is complete — filtering works on both routes and is independently tested.

---

## Phase 7: User Story 5 - Invalid history requests are rejected (Priority: P2)

**Goal**: Out-of-range page size, unrecognized enum values, a malformed/foreign/stale cursor, and an inverted date range are all rejected with 400, never guessed at (FR-011, FR-012).

**Independent Test**: Submit each invalid input in turn and verify each is rejected with no history payload.

- [X] T031 [US5] Add cross-field date-range validation to `src/modules/transformation-history/transformation-history.service.ts`'s `getHistory`: when both `createdAtFrom` and `createdAtTo` are supplied and `createdAtTo < createdAtFrom`, throw `BadRequestException` before building the query (service-level, matching `UserDirectoryService`'s own split between DTO-level and service-level validation) (depends on T028)
- [X] T032 [US5] Unit tests covering every FR-011/FR-012 case: `limit` below 1 or above 100 rejected (DTO-level, via `class-validator`'s `validate()`), an unrecognized `type`/`sourceFormat`/`targetFormat`/`status` value rejected (DTO-level `@IsEnum`), a malformed cursor rejected with 400 not 500 (service-level, already built in T014/T015 — assert it still holds with filters present), an inverted date range rejected (service-level, from T031) (depends on T031)
- [X] T033 [US5] E2E Scenario 5 in `test/transformation-history.e2e-spec.ts` (mirrors [quickstart.md](./quickstart.md) Scenario 5): `limit=500` → 400, `type=archive` → 400, `cursor=not-a-real-cursor` → 400, `createdAtFrom` after `createdAtTo` → 400. Also add Scenario 6 (idempotency, FR-009): request `limit=1`, take the returned `nextCursor`, repeat the same follow-up request twice, and assert both responses are byte-identical (depends on T031, T030)

**Checkpoint**: User Story 5 is complete — every invalid-input path is rejected and tested.

---

## Phase 8: User Story 6 - Every history request is audited (Priority: P3)

**Goal**: Every request to either route — success, denied, not-found, unauthenticated, invalid, or rate-limited — writes exactly one audit row capturing actor, target (admin path only), outcome, result count, and which filter *kinds* (never values) were used, without blocking the response (FR-017, FR-018).

**Independent Test**: Perform a successful self read, a successful admin read, a forbidden attempt, and a not-found attempt; verify each produces a matching audit record with no file/image content.

- [X] T034 [P] [US6] Create `src/modules/transformation-history/entities/transformation-history-audit-event.entity.ts`: `TransformationHistoryAuditEvent` (`@Entity('transformation_history_audit_events')`, matching the T003 migration's table) with `TransformationHistoryAuditOutcome` enum (`SUCCESS, DENIED, NOT_FOUND, UNAUTHENTICATED, INVALID, RATE_LIMITED`), columns `id` (uuid PK), `actorUserId` (uuid, no FK), `targetUserId` (uuid, nullable, no FK), `outcome` (enum), `resultCount` (int, nullable), `typeFilterUsed`/`sourceFormatFilterUsed`/`targetFormatFilterUsed`/`statusFilterUsed`/`dateRangeFilterUsed` (bool, default false), `createdAt` (`@CreateDateColumn`), and the two `@Index` decorators matching the migration's indexes
- [X] T035 [US6] Create `src/modules/transformation-history/transformation-history-audit.service.ts`: `TransformationHistoryAuditService` mirroring `UserDirectoryAuditService` (`src/modules/users/user-directory-audit.service.ts`) exactly — an `AuditInput` interface (`actorUserId, targetUserId?, outcome, resultCount?, typeFilterUsed?, sourceFormatFilterUsed?, targetFormatFilterUsed?, statusFilterUsed?, dateRangeFilterUsed?`) and `async record(input): Promise<void>` that wraps `create`+`save` in try/catch, logs via `this.logger.error(...)` on failure, and never rethrows (depends on T034)
- [X] T036 [P] [US6] Unit tests in `src/modules/transformation-history/transformation-history-audit.service.spec.ts`: `record()` never throws when the repository save rejects; persists only the boolean filter-used flags, never actual filter values (depends on T035)
- [X] T037 [US6] Create `src/modules/transformation-history/transformation-history-audit.filter.ts`: `TransformationHistoryAuditFilter extends BaseExceptionFilter`, mirroring `UserDirectoryAuditFilter` (`src/modules/users/user-directory-audit.filter.ts`) — `@Catch(UnauthorizedException, ThrottlerException, BadRequestException)`, injects `TransformationHistoryAuditService`, path-matches requests to `/api/transformations/history` and `/api/transformations/history/:userId` (stripping the query string), maps exception type → `UNAUTHENTICATED`/`INVALID`/`RATE_LIMITED`, fires `void this.auditService.record(...).catch(() => undefined)` (fire-and-forget, not awaited), then always calls `super.catch(exception, host)` (depends on T034)
- [X] T038 [P] [US6] Unit tests in `src/modules/transformation-history/transformation-history-audit.filter.spec.ts`: each caught exception type maps to the correct outcome; requests to unrelated paths are ignored; `super.catch` is always invoked regardless of the audit write's outcome (depends on T037)
- [X] T039 [US6] Update `src/modules/transformation-history/transformation-history.module.ts`: add `TransformationHistoryAuditEvent` to the `TypeOrmModule.forFeature` array, add `TransformationHistoryAuditService` to `providers`, and register `TransformationHistoryAuditFilter` as `{ provide: APP_FILTER, useClass: TransformationHistoryAuditFilter }` (mirroring `users.module.ts`'s registration of `UserDirectoryAuditFilter`) (depends on T034, T035, T037, T021)
- [X] T040 [US6] Update both routes in `src/modules/transformation-history/transformation-history.controller.ts` to `await` `transformationHistoryAuditService.record(...)` for every in-handler outcome — self route: `SUCCESS` with `resultCount` and the five filter-used booleans derived from which query fields were supplied; admin route: the same plus `targetUserId: userId`, and `DENIED` (403) / `NOT_FOUND` (404) before their respective throws (depends on T039, T022)
- [X] T041 [US6] Unit tests in `src/modules/transformation-history/transformation-history.controller.spec.ts`: each reachable in-handler outcome (self success, admin success, denied, not-found) calls `auditService.record` with the exact expected `actorUserId`/`targetUserId`/`outcome`/`resultCount`/filter-used flags (depends on T040)
- [X] T042 [US6] E2E Scenario 7 in `test/transformation-history.e2e-spec.ts`: after running the Scenario 1/2/3/5 requests, query `transformation_history_audit_events` directly (poll with a `waitForAuditRows` helper mirroring `users-directory.e2e-spec.ts`, since the exception-filter-driven rows are fire-and-forget) and assert one row per request with the correct `outcome`, `targetUserId` populated only for admin-path rows, `resultCount` populated only on success, and that no row's serialized JSON contains file/image content or another user's email (depends on T040, T033)

**Checkpoint**: All six user stories are complete and independently tested — the feature is functionally and behaviorally done per spec.md.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Verification and regression checks that span the whole feature rather than any one user story.

- [X] T043 [P] Add a rate-limit e2e test (SC-008) to `test/transformation-history.e2e-spec.ts`, mirroring `users-directory.e2e-spec.ts`'s rate-limiting scenario: exceeding 30 requests/minute on the self route and 20 requests/minute on the admin route both return 429 (clearing `ThrottlerStorage` before/after so this test doesn't interfere with others)
- [X] T044 [P] Start the app and inspect the generated OpenAPI document to confirm `GET /api/transformations/history` and `GET /api/transformations/history/:userId` list every status code from [contracts/transformation-history-api.md](./contracts/transformation-history-api.md) (200/400/401/403/404/429 as applicable to each route) — no code change, verification only
- [X] T045 Run `npm run migration:run && npm run start:dev` and walk through [quickstart.md](./quickstart.md) Scenarios 1–7 manually against the running instance to validate the full feature end-to-end
- [X] T046 [P] Run `npm test`, `npm run test:e2e`, and `npm run lint` to confirm the `transformationType` field addition introduces no regressions in feature 010/011's existing suites and the new suite is clean

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. Blocks every user story.
- **User Stories (Phase 3–8)**: All depend on Foundational. Given here in priority order (P1 → P1 → P1 → P2 → P2 → P3), but US1/US2/US3 have real code dependencies on each other (US2 adds a route to the file US1 created; US3 adds tests against US2's permission check), so they should be done in this order rather than in parallel by different people. US4/US5 both extend the same DTO/service files US1–US3 built, so they also proceed in sequence. US6 is the most independent — it adds new files (entity/service/filter) that only integrate with the controller at the end (T039–T040).
- **Polish (Phase 9)**: Depends on all six user stories being complete.

### Critical Path

T001 → T002/T003 → T004/T005 → T006/T007 → T008/T009 → T010–T013 → T014 → T015/T016 → T017 → T018 (US1) → T019/T020 → T021 → T022 (US2) → T023/T024 → T025/T026 (US3, **MVP complete**) → T027 → T028 (US4) → T029/T030 → T031 (US5) → T032/T033 → T034/T037 (US6) → T035/T038 → T036/T039 → T040 → T041/T042 → T043–T046 (Polish)

### Parallel Opportunities

- Within Foundational: T002 and T003 together; T006 and T007 together (after T005); T008 and T009 together; T010, T011, T012, T013 together; T015 and T016 together (after T014)
- Within US6: T034 unblocks both T035 and T037, which can proceed together, followed by their respective spec files (T036, T038) together
- Within Polish: T043, T044, and T046 can all run together; T045 is a manual walkthrough best done last, after the automated suite (T046) is green

---

## Parallel Example: Foundational Phase

```bash
# After T005 (ConversionAttempt.transformationType) lands, the two writer edits are independent:
Task: "Update src/modules/conversion/conversion.service.ts call site to pass transformationType: TransformationType.FILE"
Task: "Update src/modules/image-conversion/image-conversion.service.ts call site to pass transformationType: TransformationType.IMAGE"

# The three new DTOs have no dependency on each other:
Task: "Create src/modules/transformation-history/dto/transformation-history-item.dto.ts"
Task: "Create src/modules/transformation-history/dto/transformation-history-page.dto.ts"
Task: "Create src/modules/transformation-history/dto/transformation-history-query.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1–3 only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational) — schema change, RBAC seed, base cursor-pagination service.
2. Complete Phase 3 (US1: self read).
3. Complete Phase 4 (US2: admin read).
4. Complete Phase 5 (US3: authorization boundary).
5. **STOP and VALIDATE**: run `test/transformation-history.e2e-spec.ts` Scenarios 1–3 — this is the MVP (all three P1 stories, matching spec.md's own priority tier).

### Incremental Delivery

1. Setup + Foundational → module loads, cursor pagination is unit-tested in isolation.
2. + US1 → self-service history read ships (MVP core).
3. + US2 → admin oversight read ships.
4. + US3 → the security boundary between them is explicitly verified — MVP complete, deployable.
5. + US4 → filtering ships (P2).
6. + US5 → input validation hardening ships (P2).
7. + US6 → the audit trail ships (P3) — full feature, all spec.md requirements satisfied.
8. + Polish → rate-limit coverage, doc verification, manual quickstart pass, full-suite regression check.

---

## Notes

- `[P]` tasks touch different files and have no unresolved dependency on another incomplete task in the same batch.
- Every task that edits a file another phase also edits (`transformation-history.controller.ts`, `.service.ts`, `.module.ts`, and `test/transformation-history.e2e-spec.ts`) is deliberately **not** marked `[P]` relative to its sibling edits in other phases, even though those edits are far apart in the task list — they are sequential edits to the same file.
- The migration (T003) creates the `transformation_history_audit_events` table's schema; the ORM entity class mapping to it (T034) is deliberately deferred to US6, since nothing before US6 reads or writes that table — this keeps the schema change atomic (one migration) while still mapping entity creation to the story that needs it.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently before moving on.
