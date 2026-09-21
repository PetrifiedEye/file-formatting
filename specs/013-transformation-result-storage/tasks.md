---

description: "Task list for Transformation Result Storage & Download (feature 013)"

---

# Tasks: Transformation Result Storage & Download

**Input**: Design documents from `/specs/013-transformation-result-storage/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/transformation-result-download-api.md](./contracts/transformation-result-download-api.md), [contracts/transformation-retention-settings-api.md](./contracts/transformation-retention-settings-api.md), [quickstart.md](./quickstart.md)

**Tests**: Included. The project constitution makes service/controller unit tests and HTTP/database e2e coverage non-negotiable, and the plan explicitly requires coverage for both conversion families, authorization ordering, IDOR, expiry, cleanup, storage drift, streaming failures, and auditing.

**Organization**: Tasks are grouped by the six user stories in `spec.md` (P1/P1/P1/P2/P2/P3). Tests appear before implementation in each story and should fail for the intended reason before production code is added.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and has no dependency on another incomplete task in the same batch
- **[Story]**: US1–US6, mapped to the six user stories in `spec.md`
- File paths are exact and relative to the repository root

## Path Conventions

This is one existing NestJS/Fastify backend. Cross-family result lifecycle code belongs in `src/modules/transformation-result-storage/`; shared local-file primitives remain in `src/core/storage/`; schema changes remain in `src/database/migrations/`; e2e suites remain in `test/`.

---

## Phase 1: Setup

**Purpose**: Establish the cross-family module skeleton using the repository's NestJS conventions.

- [X] T001 Scaffold `TransformationResultStorageModule`, self/admin download controllers, download/cleanup/policy/audit services, audit filter, enums, and entity shells with Nest CLI where applicable in `src/modules/transformation-result-storage/transformation-result-storage.module.ts`, `src/modules/transformation-result-storage/self-result-download.controller.ts`, `src/modules/transformation-result-storage/admin-result-download.controller.ts`, `src/modules/transformation-result-storage/transformation-result-download.service.ts`, `src/modules/transformation-result-storage/transformation-result-cleanup.service.ts`, `src/modules/transformation-result-storage/transformation-retention-policy.service.ts`, `src/modules/transformation-result-storage/transformation-result-audit.service.ts`, `src/modules/transformation-result-storage/transformation-result-audit.filter.ts`, `src/modules/transformation-result-storage/transformation-result.enums.ts`, and `src/modules/transformation-result-storage/entities/transformation-result-audit-event.entity.ts`

**Checkpoint**: The new directory contains compilable class shells but no user-facing route behavior.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the schema, immutable policy, expiry write path, configuration, and module boundaries required by every story.

**⚠️ CRITICAL**: Complete this phase before starting any user story.

- [X] T002 [P] Create reversible migration `src/database/migrations/1761500000000-TransformationResultStorage.migration.ts` that adds/backfills/constrains `conversion_records.expires_at` as `created_at + 90 days`, creates `idx_conversion_records_expires_at`, adds `system_settings.transformation_history_retention_days smallint NOT NULL DEFAULT 90` with a 1–3650 check, extends the settings-audit event enum with `transformation_retention_updated`, appends `download-any` to the existing `transformation-history` permission and default admin grant without widening other grants, creates the result-audit action/outcome enums and `transformation_result_audit_events` table/indexes exactly as specified in `specs/013-transformation-result-storage/data-model.md`, and reverses only feature-013 changes in `down()`
- [X] T003 [P] Add immutable `expiresAt: Date` mapping and `idx_conversion_records_expires_at` to `src/modules/conversion/entities/conversion-record.entity.ts`
- [X] T004 [P] Add `transformationHistoryRetentionDays` to `src/modules/settings/entities/system-settings.entity.ts` and add `TRANSFORMATION_RETENTION_UPDATED` to `SettingsAuditEventType` in `src/modules/settings/entities/settings-audit-event.entity.ts`
- [X] T005 [P] Create validated Swagger request/response DTOs with integer range 1–3650 in `src/modules/settings/dto/transformation-retention-policy.dto.ts`
- [X] T006 Implement `getTransformationRetentionPolicy()` and audited `updateTransformationRetentionPolicy()` with immutable-existing-deadline semantics in `src/modules/settings/settings.service.ts`
- [X] T007 Add unit tests for retention-policy reads, valid/idempotent updates, settings audit changes, and persistence/audit failures in `src/modules/settings/settings.service.spec.ts`
- [X] T008 Add guarded, documented `GET /admin/settings/transformation-retention` and `PATCH /admin/settings/transformation-retention` handlers in `src/modules/settings/settings.controller.ts`
- [X] T009 Add controller tests for response shaping, DTO forwarding, actor metadata, and `AdminGuard`-compatible behavior in `src/modules/settings/settings.controller.spec.ts`
- [X] T010 Implement a read-only adapter that returns the active retention days and computes a deadline from a supplied creation time in `src/modules/transformation-result-storage/transformation-retention-policy.service.ts`
- [X] T011 Add unit tests for default/current policy reads and exact deadline calculation in `src/modules/transformation-result-storage/transformation-retention-policy.service.spec.ts`
- [X] T012 [P] Add `TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS` typing, Joi integer validation/default of 3600000 with `0` allowed to disable scheduling, and example configuration in `src/core/config/config.types.ts`, `src/core/config/config.validation.ts`, and `.env.example`
- [X] T013 Wire the policy service through explicit acyclic imports/exports in `src/modules/transformation-result-storage/transformation-result-storage.module.ts`, import the new module from `src/modules/conversion/conversion.module.ts`, and register it in `src/core/app/app.module.ts`

**Checkpoint**: The database and settings API can supply a frozen expiry to new history records; the app loads the new module without a `TransformationResultStorageModule → ConversionModule` dependency.

---

## Phase 3: User Story 1 - Save a transformation result for later retrieval (Priority: P1) 🎯

**Goal**: Both conversion families use one save finalization path, preserve their existing `store` contract and response, and link a private saved file to a history row carrying a frozen expiry.

**Independent Test**: Convert one document and one image with `store=true`; each original conversion response remains unchanged, while its new history row has `retention_outcome=stored`, a linked stored file, and a future immutable `expires_at`. Omitted/false/invalid `store` behavior remains unchanged.

### Tests for User Story 1

- [X] T014 [P] [US1] Add failing unit tests proving each inserted history row receives `expiresAt` from the active policy and later policy changes do not mutate it in `src/modules/conversion/conversion-history.service.spec.ts`
- [X] T015 [P] [US1] Add failing unit tests for shared save finalization order (history id required, private write, transactional attach, orphan discard, final retention outcome) in `src/modules/conversion/conversion-retention.service.spec.ts`
- [X] T016 [P] [US1] Add failing document-conversion tests for `store=true`, omitted/false `store`, failed conversion, unchanged result bytes/status metadata, and final retention header outcome in `src/modules/conversion/conversion.service.spec.ts`
- [X] T017 [P] [US1] Add equivalent failing image-conversion tests using the same shared retention collaborator in `src/modules/image-conversion/image-conversion.service.spec.ts`

### Implementation for User Story 1

- [X] T018 [US1] Inject `TransformationRetentionPolicyService`, calculate one frozen `expiresAt`, and include it in every inserted row without making history failures replace conversion responses in `src/modules/conversion/conversion-history.service.ts`
- [X] T019 [US1] Consolidate save/write/transactional-attach/discard compensation into one non-throwing finalization operation that runs after history insertion in `src/modules/conversion/conversion-retention.service.ts`
- [X] T020 [P] [US1] Refactor the document pipeline to record history first and invoke shared finalization while preserving result bytes, status, content headers, and `X-Conversion-Retention` semantics in `src/modules/conversion/conversion.service.ts`
- [X] T021 [P] [US1] Refactor the image pipeline onto the same history-first finalization while preserving result bytes, status, content headers, and `X-Image-Conversion-Retention` semantics in `src/modules/image-conversion/image-conversion.service.ts`
- [X] T022 [US1] Extend document and image e2e coverage for `store=true`, omitted/false/invalid values, conversion failure, linked metadata, private file bytes, and immutable expiry in `test/file-conversion.e2e-spec.ts` and `test/image-conversion.e2e-spec.ts`

**Checkpoint**: US1 is independently functional for both conversion families; immediately after a successful stored conversion, metadata and backing bytes are durably linked.

---

## Phase 4: User Story 2 - Download my own saved result (Priority: P1)

**Goal**: An authenticated owner streams an unexpired saved result through the self route with exact bytes and trusted response metadata, while unknown, unsaved, cross-owner, and expired ids share one unavailable response.

**Independent Test**: The owner downloads the same saved result repeatedly and concurrently with byte-identical output, correct filename/media type/length, and private no-store headers; another user, an unknown id, and an unsaved id all receive the same 404, while no session receives 401 before lookup.

### Tests for User Story 2

- [X] T023 [P] [US2] Add failing filesystem tests for contained pre-open/stat streaming, descriptor-backed repeat reads, traversal rejection, and missing-file classification in `src/core/storage/conversion-file-storage.service.spec.ts`
- [X] T024 [P] [US2] Add failing service tests for owner-scoped explicit-column queries, eligibility checks, uniform unavailable outcomes, trusted filename/media mapping for document and image formats, and independent repeated opens in `src/modules/transformation-result-storage/transformation-result-download.service.spec.ts`
- [X] T025 [P] [US2] Add failing controller tests for deriving the owner only from `request.user.id`, UUID validation, exact binary headers, stream return, and route throttling metadata in `src/modules/transformation-result-storage/self-result-download.controller.spec.ts`

### Implementation for User Story 2

- [X] T026 [US2] Add path-contained `openForRead()` returning a pre-opened file-handle-backed stream and exact stat size, with typed missing/unexpected failures and no full-file buffering, in `src/core/storage/conversion-file-storage.service.ts`
- [X] T027 [US2] Implement owner-scoped download preflight, expiry/outcome/link checks, document/image media type and deterministic filename mapping, and uniform unavailable exceptions in `src/modules/transformation-result-storage/transformation-result-download.service.ts`
- [X] T028 [US2] Implement documented `GET /api/transformations/history/:itemId/download` with `JwtAuthGuard`, `ParseUUIDPipe`, 30/minute throttle, preflight-before-headers, exact download headers, and Fastify stream sending in `src/modules/transformation-result-storage/self-result-download.controller.ts`
- [X] T029 [US2] Register `ConversionRecord`, `ConversionStoredFile`, auth guard dependencies, storage dependencies, `TransformationResultDownloadService`, and `SelfResultDownloadController` in `src/modules/transformation-result-storage/transformation-result-storage.module.ts`
- [X] T030 [US2] Create self-download e2e scenarios for exact bytes/headers, unknown/unsaved/cross-owner uniform 404, unauthenticated 401, malformed UUID 400, and repeat/concurrent downloads in `test/transformation-result-storage.e2e-spec.ts`

**Checkpoint**: US2 is independently functional and IDOR-safe; saved bytes are available only through an authenticated owner-scoped stream.

---

## Phase 5: User Story 3 - Administrator downloads a saved result on behalf of a user (Priority: P1)

**Goal**: A caller with `transformation-history:download-any` can use the exact admin route, while permission is checked before target-user or history lookup.

**Independent Test**: An authorized admin downloads a known user's result; a caller without the permission gets 403 for both real and random targets before any existence lookup, and wrong-user/nonexistent targets produce uniform 404 after authorization.

### Tests and Implementation for User Story 3

- [X] T031 [US3] Add failing tests for permission-first ordering, no lookup when denied, owner-scoped target matching, and successful stream/header parity with the self route in `src/modules/transformation-result-storage/admin-result-download.controller.spec.ts`
- [X] T032 [US3] Implement documented `GET /admin/users/:userId/transformations/history/:itemId/download` with `JwtAuthGuard`, UUID validation, 20/minute throttle, `download-any` authorization before `UsersService.findById()` or result lookup, and shared streaming behavior in `src/modules/transformation-result-storage/admin-result-download.controller.ts`
- [X] T033 [US3] Register admin controller/RBAC/users dependencies and add e2e scenarios for authorized download, denied real/random targets, nonexistent user, owner mismatch, malformed ids, and permission revocation in `src/modules/transformation-result-storage/transformation-result-storage.module.ts` and `test/transformation-result-storage.e2e-spec.ts`

**Checkpoint**: All P1 stories are complete: users can save and retrieve their own results, and explicitly authorized administrators can retrieve a specified user's result without weakening IDOR defenses.

---

## Phase 6: User Story 4 - Saved results and their history expire automatically (Priority: P2)

**Goal**: Every history row becomes unavailable at its frozen deadline and a lifecycle-managed bounded cleanup removes expired history plus linked files, isolating per-item failures.

**Independent Test**: Backdate saved and unsaved records, verify download is already unavailable before cleanup, run one cleanup cycle, and verify rows/files are removed; inject one unlink failure and verify later items are still processed while the failed item remains for retry.

### Tests for User Story 4

- [X] T034 [P] [US4] Add failing unit tests for lifecycle timer start/stop/disable, indexed ordered bounded batches, unlink-before-row-delete, missing-file idempotency, per-item isolation, continued batching, and retry retention in `src/modules/transformation-result-storage/transformation-result-cleanup.service.spec.ts`
- [X] T035 [P] [US4] Add failing e2e retention-settings scenarios for GET/PATCH authorization, integer range validation, settings auditing, immutable existing deadlines, and changed deadlines for later records in `test/admin-settings.e2e-spec.ts`

### Implementation for User Story 4

- [X] T036 [US4] Implement `OnModuleInit`/`OnModuleDestroy` recurring cleanup with an unref'ed configurable interval, overlap prevention, explicit minimal selects ordered by indexed `expires_at`, bounded batches, unlink-before-delete, and per-item logging/isolation in `src/modules/transformation-result-storage/transformation-result-cleanup.service.ts`
- [X] T037 [US4] Register the cleanup provider and its repositories/config/storage dependencies in `src/modules/transformation-result-storage/transformation-result-storage.module.ts`
- [X] T038 [US4] Add e2e coverage for expiry-before-cleanup, deletion of saved and unsaved history, cascade metadata deletion, physical unlink, missing-file idempotency, per-item failure continuation, and later retry in `test/transformation-result-storage.e2e-spec.ts`
- [X] T039 [US4] Complete retention-settings HTTP/database coverage and assert existing `expires_at` values stay unchanged after PATCH in `test/admin-settings.e2e-spec.ts`

**Checkpoint**: US4 is independently testable; no expired result is downloadable, and cleanup bounds storage/history growth without one bad item blocking a cycle.

---

## Phase 7: User Story 5 - Handle save and download failures gracefully (Priority: P2)

**Goal**: Oversized saves, storage/attach/history failures, metadata drift, and open/read errors produce safe outcomes without changing successful conversion responses or validating partial downloads.

**Independent Test**: Force each save failure and verify conversion still succeeds with no dangling link/file; force missing backing storage and unexpected open/read failures and verify uniform 404 or safe failed transfer semantics with no valid partial response.

### Tests for User Story 5

- [X] T040 [P] [US5] Add failing tests for output-limit recheck, storage failure, missing history id, transactional attach failure, discard failure containment, no dangling metadata, and unchanged caller result in `src/modules/conversion/conversion-retention.service.spec.ts`
- [X] T041 [P] [US5] Add failing tests distinguishing idempotent cleanup removal from strict removal/open failures, path traversal, unexpected stat/open errors, and mid-stream read errors in `src/core/storage/conversion-file-storage.service.spec.ts`
- [X] T042 [P] [US5] Add failing tests for metadata/backing-file drift mapping to uniform unavailable, unexpected pre-header storage errors mapping to 500, and no path/internal-detail disclosure in `src/modules/transformation-result-storage/transformation-result-download.service.spec.ts`
- [X] T043 [P] [US5] Add failing controller tests for pre-header failure responses, advertised `Content-Length`, socket/stream abort on premature close or read error, and never treating an incomplete stream as successful in `src/modules/transformation-result-storage/self-result-download.controller.spec.ts` and `src/modules/transformation-result-storage/admin-result-download.controller.spec.ts`

### Implementation for User Story 5

- [X] T044 [US5] Enforce the applicable document/image maximum at the shared retention boundary and make every storage/history/attach/compensation failure return a non-throwing structured save outcome in `src/modules/conversion/conversion-retention.service.ts`
- [X] T045 [US5] Harden open/delete error classification and stream ownership/closure in `src/core/storage/conversion-file-storage.service.ts`, then map missing drift to uniform 404, unexpected preflight failures to 500, and post-header read failures to an aborted incomplete transfer in `src/modules/transformation-result-storage/transformation-result-download.service.ts`, `src/modules/transformation-result-storage/self-result-download.controller.ts`, and `src/modules/transformation-result-storage/admin-result-download.controller.ts`
- [X] T046 [US5] Add e2e failure scenarios for unwritable save storage, oversized retention-boundary input, attach compensation, missing backing file, unexpected open failure, and incomplete read failure in `test/file-conversion.e2e-spec.ts`, `test/image-conversion.e2e-spec.ts`, and `test/transformation-result-storage.e2e-spec.ts`

**Checkpoint**: US5 is complete; save side effects never replace conversion outcomes, and callers never receive a valid-looking corrupt or unauthorized download.

---

## Phase 8: User Story 6 - Save and download actions are audited (Priority: P3)

**Goal**: Exactly one best-effort structured audit row records every recognized save attempt and every download attempt, including pre-controller refusals and final stream completion, with no file content/path.

**Independent Test**: Exercise successful/failed saves, successful/refused self/admin downloads, unauthenticated/invalid/rate-limited requests, storage drift, and read failure; verify one correctly attributed event per attempt and zero payload/path fields.

### Tests and Entity/Service Implementation for User Story 6

- [X] T047 [P] [US6] Define save/download actions and all outcomes from `specs/013-transformation-result-storage/data-model.md`, and map the audit table/indexes without foreign keys or free-form payload/path columns in `src/modules/transformation-result-storage/transformation-result.enums.ts` and `src/modules/transformation-result-storage/entities/transformation-result-audit-event.entity.ts`
- [X] T048 [US6] Implement a best-effort non-throwing audit writer accepting actor/target/record/file ids, action, outcome, optional size, non-negative duration, and no raw content/path fields in `src/modules/transformation-result-storage/transformation-result-audit.service.ts`
- [X] T049 [P] [US6] Add unit tests that all fields/outcomes persist correctly, audit repository failures never escape, durations are non-negative, and serialized entities cannot contain bytes, filenames, or storage paths in `src/modules/transformation-result-storage/transformation-result-audit.service.spec.ts`
- [X] T050 [US6] Implement a route-scoped exception filter that records unauthenticated, invalid UUID, and rate-limited download attempts that never reach a handler, delegates every response to Nest's base filter, and ignores unrelated routes in `src/modules/transformation-result-storage/transformation-result-audit.filter.ts`
- [X] T051 [P] [US6] Add filter tests for route matching, self/admin target extraction, exception-to-outcome mapping, unrelated-route exclusion, and guaranteed base-filter delegation in `src/modules/transformation-result-storage/transformation-result-audit.filter.spec.ts`

### Audit Integration for User Story 6

- [X] T052 [US6] Integrate exactly one save audit into shared finalization for success, conversion failure, size exceeded, storage failure, attach failure, and missing-history outcomes without affecting conversion responses in `src/modules/conversion/conversion-retention.service.ts`, `src/modules/conversion/conversion.service.ts`, and `src/modules/image-conversion/image-conversion.service.ts`
- [X] T053 [US6] Integrate exactly-once download audit finalization for denied/not-found/expired/unavailable/storage-failed outcomes before streaming, success only on response finish, and `read_failed` on stream error or premature close in `src/modules/transformation-result-storage/transformation-result-download.service.ts`, `src/modules/transformation-result-storage/self-result-download.controller.ts`, and `src/modules/transformation-result-storage/admin-result-download.controller.ts`
- [X] T054 [US6] Register `TransformationResultAuditEvent`, audit service, and route-scoped `APP_FILTER` provider, and export the audit service to conversion code in `src/modules/transformation-result-storage/transformation-result-storage.module.ts`
- [X] T055 [US6] Extend save and controller unit suites to assert one exact audit event for every reachable outcome and no primary-response changes when auditing fails in `src/modules/conversion/conversion-retention.service.spec.ts`, `src/modules/conversion/conversion.service.spec.ts`, `src/modules/image-conversion/image-conversion.service.spec.ts`, `src/modules/transformation-result-storage/self-result-download.controller.spec.ts`, and `src/modules/transformation-result-storage/admin-result-download.controller.spec.ts`
- [X] T056 [US6] Query `transformation_result_audit_events` in e2e tests and assert exactly one correctly attributed content-free event for successful/failed saves, self/admin success/refusal, unauthenticated/invalid/rate-limited requests, expiry, drift, storage failure, and read failure in `test/file-conversion.e2e-spec.ts`, `test/image-conversion.e2e-spec.ts`, and `test/transformation-result-storage.e2e-spec.ts`

**Checkpoint**: All six stories are independently testable and the complete feature satisfies the save/download audit contract without creating a new failure mode.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Synchronize documentation/OpenAPI and run repository-wide quality gates.

- [X] T057 [P] Document `store`, both download routes, admin retention policy, cleanup interval, private-storage requirements, migration steps, and operational failure semantics in `README.md`
- [X] T058 [P] Add/verify direct-static-path denial and absence of `storagePath`/stored-file ids in all API responses in `test/transformation-result-storage.e2e-spec.ts`
- [X] T059 Inspect the generated OpenAPI document and correct decorators so both binary download routes and retention-settings routes expose every response/status/header from `specs/013-transformation-result-storage/contracts/transformation-result-download-api.md` and `specs/013-transformation-result-storage/contracts/transformation-retention-settings-api.md`
- [X] T060 Run Prettier and the mandatory TypeScript/ESLint/unit-test gate using `npm run format` and `npm run verify` from `package.json`, fixing every failure in `src/` and `test/`
- [X] T061 Run `npm run test:e2e` and validate all scenarios in `specs/013-transformation-result-storage/quickstart.md`, fixing any HTTP, database, RBAC, filesystem, cleanup, or audit regression in `src/` and `test/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependency.
- **Foundational (Phase 2)**: Depends on Setup and blocks every story.
- **US1 (Phase 3)**: Depends on Foundational; establishes saved results and the shared history-first finalizer.
- **US2 (Phase 4)**: Depends on US1 for a downloadable saved result.
- **US3 (Phase 5)**: Depends on US2's shared download service/streaming behavior.
- **US4 (Phase 6)**: Depends on Foundational and US1's stored-file lifecycle; it may be developed alongside US2/US3 after US1.
- **US5 (Phase 7)**: Depends on US1 and US2 because it hardens both save and download failure paths.
- **US6 (Phase 8)**: Depends on US1–US5 outcomes so each can be audited exactly once.
- **Polish (Phase 9)**: Depends on all stories selected for release.

### User Story Dependency Graph

```text
Setup → Foundational → US1 ─┬→ US2 → US3 ─┐
                            ├→ US4        ├→ US6 → Polish
                            └→ US5 ← US2 ─┘
```

US4 can proceed in parallel with US2/US3 after US1. US5 requires both save and self-download foundations. US6 is deliberately last because its outcome model spans every earlier path.

### Critical Path

T001 → T002–T013 → T014–T019 → T020/T021 → T022 → T023–T027 → T028–T030 → T031–T033 → T040–T046 → T047–T054 → T055/T056 → T057–T061

### Within Each Story

- Write the listed tests first and confirm they fail for the missing behavior.
- Complete entity/storage primitives before services.
- Complete services before controllers and module wiring.
- Complete unit tests before adding the corresponding e2e scenarios.
- Stop at each checkpoint and validate that story independently.

---

## Parallel Execution Examples

### User Story 1

After Foundational, T014–T017 can run together because they edit four different unit suites. After T019, T020 and T021 can run together because the document and image pipelines are separate files.

### User Story 2

T023–T025 can run together as storage, service, and controller test-first tasks. Production work then follows T026 → T027 → T028/T029 → T030.

### User Story 3

T031 defines the authorization-order contract first. T032 implements it; T033 performs module/e2e integration. These tasks are sequential because they share the admin controller/module path.

### User Story 4

T034 and T035 can run together because cleanup unit tests and settings e2e tests are independent. After T036, T037 and preparation for T039 can proceed while T038 builds cleanup e2e fixtures.

### User Story 5

T040–T043 can run together across retention, storage, download service, and controller suites. T044 and the storage portion of T045 can then run in parallel before T046.

### User Story 6

T047 unblocks T048 and T050, which can proceed in parallel; T049 and T051 can then run together. After integration tasks T052–T054, T055 unit coverage and T056 e2e coverage can run in parallel.

---

## Implementation Strategy

### Recommended MVP: Complete the P1 Tier

1. Complete Setup and Foundational.
2. Complete US1 so document and image results can be saved.
3. Complete US2 so owners can retrieve saved results securely.
4. Complete US3 so the required oversight route has its explicit permission boundary.
5. Run the relevant unit suites plus `test/file-conversion.e2e-spec.ts`, `test/image-conversion.e2e-spec.ts`, and the P1 scenarios in `test/transformation-result-storage.e2e-spec.ts`.

Save-only US1 is technically independently testable, but it is not a useful release by itself because no retrieval operation exists. The smallest deployable feature is therefore all three P1 stories.

### Incremental Delivery

1. Setup + Foundational → schema, policy, immutable expiry, module boundary.
2. US1 → opt-in storage works for both conversion families.
3. US2 → owners can securely stream saved results.
4. US3 → permission-gated administrator retrieval completes the P1 MVP.
5. US4 → automated expiry and cleanup bounds retention.
6. US5 → failure and drift paths are hardened.
7. US6 → complete structured audit coverage.
8. Polish → docs, OpenAPI, formatting, `npm run verify`, e2e, and quickstart validation.

---

## Notes

- Every `[P]` task edits different files or can be isolated without relying on an incomplete sibling task.
- `store` remains the external multipart field name; introducing a new `save` field is out of scope and would break the existing contract.
- `expires_at` is written once for every history row and is never recalculated after policy updates.
- The database and local filesystem cannot share one transaction; cleanup therefore uses expiry gating, unlink-before-delete, idempotency, per-item isolation, and retry.
- Download success is not auditable until the stream finishes; premature close/read failure must never be recorded as success.
- Commit after each task or coherent task group, and run the mandatory gates before declaring implementation complete.
