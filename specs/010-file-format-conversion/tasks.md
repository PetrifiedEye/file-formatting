---
description: "Task list for File Format Conversion implementation"
---

# Tasks: File Format Conversion

**Input**: Design documents from `/specs/010-file-format-conversion/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/conversion-api.md](./contracts/conversion-api.md),
[contracts/conversion-mapping-rules.md](./contracts/conversion-mapping-rules.md)

**Tests**: INCLUDED. Constitution IV makes unit and e2e coverage
non-negotiable, and SC-010 / SC-011 require specific automated checks, so
test tasks are first-class here rather than optional.

**Organization**: Tasks are grouped by user story so each story can be
implemented, tested, and demoed independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: The user story the task serves (US1–US5)
- Every task names the exact file it touches

## Path Conventions

Single existing NestJS backend at the repository root: `src/core/`,
`src/modules/`, `src/database/migrations/`, `test/`. Imports use the `@/`
path alias (Constitution).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and configuration the whole feature rests on

- [X] T001 Add runtime dependencies `csv-parse`, `csv-stringify`, `fast-xml-parser`, and `yaml@^2` (plus any needed `@types/*`) to `package.json` and install; do **not** add `js-yaml` — it is YAML 1.1 and has no alias cap ([research.md §3](./research.md))
- [X] T002 [P] Add the ten `CONVERSION_*` settings to the typed config surface in `src/core/config/config.types.ts`: `CONVERSION_MAX_BYTES_CSV|JSON|XML|YAML`, `CONVERSION_MAX_OUTPUT_BYTES`, `CONVERSION_MAX_DEPTH`, `CONVERSION_MAX_NODES`, `CONVERSION_MAX_CSV_COLUMNS`, `CONVERSION_TIMEOUT_MS`, `CONVERSION_STORAGE_DIR`
- [X] T003 [P] Document the same ten settings with their defaults in `.env.example` (defaults per [research.md §4](./research.md); `CONVERSION_STORAGE_DIR=./storage/conversions`)
- [X] T004 Extend the Joi schema in `src/core/config/config.validation.ts` with the ten `CONVERSION_*` keys, each with its documented default, positive-integer bounds on the numeric limits, and a non-empty string for the storage dir (depends on T002)
- [X] T005 Extend `src/core/config/config.validation.spec.ts` to cover the new keys: defaults applied when absent, rejection of zero/negative/non-numeric limits (depends on T004)
- [X] T006 [P] Create the fixture directory `test/support/conversion-fixtures/` with a `README.md` naming each fixture's purpose (fixtures themselves are added by the stories that assert on them)

**Checkpoint**: Configuration validated at startup; libraries available

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The hub model, the handler contract, persistence, and the
boundary reader — everything every user story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T007 [P] Create `src/modules/conversion/conversion.enums.ts` with `ConversionFormat`, `ConversionOutcome`, `ConversionErrorCategory`, and `ConversionRetentionOutcome` exactly as specified in [data-model.md](./data-model.md) — this is the only place the format set is enumerated for persistence
- [X] T008 [P] Create `src/modules/conversion/conversion.constants.ts` with the fixed error codes from [contracts/conversion-api.md](./contracts/conversion-api.md) (`missing_file`, `empty_file`, `unexpected_part`, `missing_target_format`, `same_format`, `invalid_store_flag`, `invalid_encoding`, `parse_error`, `csv_duplicate_header`, `xml_doctype_forbidden`, `xml_name_collision`, `structure_limit_exceeded`, `csv_too_many_columns`, `output_too_large`, `timeout`, `input_too_large`, `unsupported_source_format`, `unsupported_target_format`, `internal_error`), `DETECTION_PREFIX_BYTES = 65536`, and the per-format media types and extensions
- [X] T009 Create `src/modules/conversion/formats/document-node.ts` with the `DocumentNode` type and a single shared `guardStructure(node, limits)` walk enforcing `maxDepth` and `maxNodes`, throwing the `structure_limit_exceeded` error (depends on T007, T008)
- [X] T010 [P] Write `src/modules/conversion/formats/document-node.spec.ts` covering depth at and over the limit, node count at/over the limit, and that scalars, empty arrays, and empty objects pass (depends on T009)
- [X] T011 Create `src/modules/conversion/formats/format-handler.ts` with the `FormatHandler` interface (`format`, `mediaType`, `extension`, `sniff`, `read`, `write`), the `ConversionLimits` interface from [data-model.md](./data-model.md), and the `FORMAT_HANDLERS` and `CONVERSION_LIMITS` DI tokens (depends on T007)
- [X] T012 Create `src/modules/conversion/conversion.exception.ts` with a `ConversionException` carrying a fixed error `code`, an `ConversionErrorCategory`, and an HTTP status, plus the code→status mapping table from [contracts/conversion-api.md](./contracts/conversion-api.md); library parser messages MUST never be carried through it (FR-023) (depends on T008)
- [X] T013 [P] Write `src/modules/conversion/conversion.exception.spec.ts` asserting every error code maps to its documented status and category, and that a constructed exception exposes no caller-supplied message text
- [X] T014 [P] Create `src/modules/conversion/entities/conversion-record.entity.ts` mapping every column in [data-model.md](./data-model.md) (`user_id` FK to `users` `ON DELETE CASCADE`, nullable `source_format`/`target_format`, `bigint` `input_size_bytes`, retention fields, `timestamptz(3)` timestamps) with both documented indexes (depends on T007)
- [X] T015 [P] Create `src/modules/conversion/entities/conversion-stored-file.entity.ts` per [data-model.md](./data-model.md), with the unique `conversion_record_id` FK and the `(user_id, created_at DESC)` index (depends on T007)
- [X] T016 Create `src/database/migrations/1761200000000-FileFormatConversion.migration.ts` creating the four enum types, both tables, both indexes, the FKs, and the five `CHECK` constraints encoding the success/failure and retention invariants from [data-model.md](./data-model.md); include a working `down()` and no changes to existing tables (depends on T014, T015)
- [X] T017 Create `src/modules/conversion/upload-reader.ts`: a budgeted multipart consumer that buffers up to `DETECTION_PREFIX_BYTES`, then continues under a caller-supplied byte budget, destroying the stream and throwing `input_too_large` the moment the budget is exceeded — the whole file is never read (SC-006) (depends on T011, T012)
- [X] T018 Write `src/modules/conversion/upload-reader.spec.ts` covering: under-budget read, exactly-at-budget read, over-budget destroying the stream without consuming the remainder, a file smaller than the detection prefix, and a zero-byte file (depends on T017)
- [X] T019 Create `src/modules/conversion/format-registry.service.ts` collecting the injected `FORMAT_HANDLERS` and deriving supported directions as every ordered pair of **distinct** registered formats, plus `maxConfiguredInputBytes()` and handler lookup by format (FR-030) (depends on T011)
- [X] T020 Write `src/modules/conversion/format-registry.service.spec.ts` proving directions are derived, never hard-coded: with two stub handlers it yields exactly two directions, with three it yields six, and no direction ever has `source === target` (depends on T019)
- [X] T021 Create `src/modules/conversion/conversion.module.ts` importing `AuthModule`, `StorageModule`, `ConfigModule`, and `TypeOrmModule.forFeature([...])`, and providing `CONVERSION_LIMITS` as a factory that resolves the whole `ConversionLimits` set once from `ConfigService` so handlers never read configuration themselves (depends on T014, T015, T019)
- [X] T022 Import `ConversionModule` in `src/core/app/app.module.ts` (depends on T021)

**Checkpoint**: Hub contract, registry, persistence, and the safe reader exist — user stories can start

---

## Phase 3: User Story 1 - Signed-in user converts a file between text formats (Priority: P1) 🎯 MVP

**Goal**: `POST /api/convert` accepts a file plus a target format and returns
an equivalent document in that format, for all twelve directions, as a
complete-or-error attachment.

**Independent Test**: Sign in, upload one well-formed file in each of CSV,
JSON, XML, and YAML, request each of the other three formats, and verify
twelve downloadable files come back carrying the same data, with the
documented attachment name and media type.

### Handlers and mapping rules

- [X] T023 [P] [US1] Create `src/modules/conversion/formats/flatten.ts` implementing path flatten/expand per [mapping rules §2](./contracts/conversion-mapping-rules.md): `.<key>` for object steps, `.<index>` for array steps, `\.` escaping for literal dots, reversible in both directions
- [X] T024 [P] [US1] Write `src/modules/conversion/formats/flatten.spec.ts` pinning nesting, array indexing, dot escaping, and flatten→expand round-trip equality (depends on T023)
- [X] T025 [P] [US1] Create `src/modules/conversion/formats/json.handler.ts`: native `JSON.parse`/`JSON.stringify`, two-space indent with trailing newline, `sniff` on a leading `{`/`[`, parser messages mapped to `parse_error` with location only (mapping rules §5) (depends on T011)
- [X] T026 [P] [US1] Write `src/modules/conversion/formats/json.handler.spec.ts`: identity both ways, last-wins duplicate keys, output formatting, and that a malformed-input error carries no fragment of the input (SC-005, SC-011) (depends on T025)
- [X] T027 [P] [US1] Create `src/modules/conversion/formats/csv.handler.ts` using `csv-parse`/`csv-stringify` per [mapping rules §1–§2](./contracts/conversion-mapping-rules.md): header-as-first-record, all values strings, short rows filled with `""`, long rows into `_extra_N`, header-only → `[]`, row selection by root shape, union header in first-appearance order, CRLF records, RFC 4180 quoting, `csv_duplicate_header` and `csv_too_many_columns` refusals (depends on T023)
- [X] T028 [US1] Write `src/modules/conversion/formats/csv.handler.spec.ts` with one test per documented CSV rule (SC-011), including the ragged-row example from the contract, the header-only `[]` case, the `value` single-column shapes, and null-vs-empty cell behaviour (depends on T027)
- [X] T029 [P] [US1] Create `src/modules/conversion/formats/xml.handler.ts` using `fast-xml-parser` with `processEntities: false` per [mapping rules §3–§4](./contracts/conversion-mapping-rules.md): attributes as `@_name`, text as `#text`, repeated siblings as arrays, empty elements as `""`, document-element selection, `<item>` wrapping for root arrays, escaping, XML-Name sanitization and the `xml_name_collision` refusal (depends on T011)
- [X] T030 [US1] Write `src/modules/conversion/formats/xml.handler.spec.ts` with one test per documented XML rule (SC-011), including the single-vs-repeated asymmetry asserted in both directions and the sanitization collision refusal (depends on T029)
- [X] T031 [P] [US1] Create `src/modules/conversion/formats/yaml.handler.ts` using `yaml` v2 restricted to the **1.2 core schema** with custom tags disabled and `maxAliasCount` capped, per [mapping rules §6](./contracts/conversion-mapping-rules.md): block style, two-space indent, no anchors emitted, non-core tags and second documents → `parse_error` (depends on T011)
- [X] T032 [US1] Write `src/modules/conversion/formats/yaml.handler.spec.ts` pinning YAML 1.2 semantics (`yes`/`no`/`on`/`off` are strings, `017` is seventeen, `0o17` is octal), non-core tag refusal, multi-document refusal, and no anchors in output (SC-011) (depends on T031)

### Detection and pipeline

- [X] T033 [US1] Create `src/modules/conversion/format-detector.service.ts` implementing the fixed order from [research.md §5](./research.md): UTF-8 validation with BOM stripping, zero-byte rejection, XML, JSON, YAML, CSV, else `unsupported_source_format`; the file-name extension runs its own format's check first as a tie-breaker only (depends on T025, T027, T029, T031)
- [X] T034 [US1] Write `src/modules/conversion/format-detector.service.spec.ts` covering each ordered branch, the CSV-vs-YAML extension tie-breaker, a BOM-prefixed file, invalid UTF-8 → `invalid_encoding`, content disagreeing with the extension (content wins), and a binary blob → `unsupported_source_format` (depends on T033)
- [X] T035 [P] [US1] Create `src/modules/conversion/dto/convert-request.dto.ts` with `class-validator` rules for `targetFormat` (required, one of the registered formats) and `store` (optional `"true"`/`"false"`, default `false`) (depends on T007)
- [X] T036 [P] [US1] Create `src/modules/conversion/dto/conversion-error-response.dto.ts` matching the single documented error envelope (`statusCode`, `error`, `message`, `code`) for Swagger (depends on T008)
- [X] T037 [US1] Create `src/modules/conversion/conversion.service.ts` running the contract's processing order: read → detect → per-format budget → same-format check → parse → `guardStructure` → serialize **completely into a buffer** capped by `maxOutputBytes` → return; take a deadline when the upload completes and check it at every `await` boundary, passing the `AbortSignal` to `csv-parse` (FR-008, FR-019) (depends on T017, T019, T033, T009)
- [X] T038 [US1] Write `src/modules/conversion/conversion.service.spec.ts` covering each of the twelve directions through stub-free handlers, the same-format refusal, a structure-limit refusal, an output-ceiling refusal, deadline expiry → `timeout`, and that no partial buffer is ever returned alongside an error (depends on T037)
- [X] T039 [US1] Create `src/modules/conversion/conversion.controller.ts` with `POST /api/convert` behind `JwtAuthGuard`: iterate `request.parts()` with per-call multipart limits (`fileSize: registry.maxConfiguredInputBytes()`, `files: 1`), validate fields via `plainToInstance` + `validate`, then set `Content-Type`, `Content-Disposition: attachment; filename="converted.<ext>"` and send the buffer — headers written only after serialization succeeds (depends on T035, T037)
- [X] T040 [US1] Write `src/modules/conversion/conversion.controller.spec.ts` asserting the guard is applied, parts are collected correctly, the response headers match the contract exactly, and a service failure produces a JSON error body with no `Content-Disposition` set (depends on T039)
- [X] T041 [US1] Register the four handlers as `FORMAT_HANDLERS` multi-providers in `src/modules/conversion/conversion.module.ts` and declare `ConversionService`, `FormatDetectorService`, and the controller (depends on T021, T025, T027, T029, T031, T037, T039)
- [X] T042 [US1] Create `src/modules/conversion/README.md` mirroring [conversion-mapping-rules.md](./contracts/conversion-mapping-rules.md) in full, including the worked "adding a fifth format" example required by SC-009 (FR-009)

### End-to-end

- [X] T043 [P] [US1] Add equivalent-content fixtures `sample.csv`, `sample.json`, `sample.xml`, `sample.yaml`, plus `bom.csv`, a Unicode/emoji file, a header-only CSV, and an empty JSON array to `test/support/conversion-fixtures/`
- [X] T044 [US1] Create `test/file-conversion.e2e-spec.ts` covering all twelve directions returning `200` with the documented headers, the `CSV→JSON→CSV` / `CSV→YAML→CSV` / `JSON→YAML→JSON` round-trip equivalence of SC-001, BOM consumption, Unicode survival, the empty-but-valid cases, and the `same_format` refusal (depends on T041, T043)

**Checkpoint**: All twelve conversions work end to end — this is the MVP

---

## Phase 4: User Story 2 - Client discovers which conversions are available (Priority: P1)

**Goal**: `GET /api/convert/formats` advertises exactly the directions the
service accepts, derived from the handler registry.

**Independent Test**: Sign in, request the list, verify four sources each
with three targets excluding themselves, each carrying its media type,
extension, and configured limit — and that every advertised direction
actually succeeds.

- [X] T045 [P] [US2] Create `src/modules/conversion/dto/supported-formats-response.dto.ts` matching the contract response (`formats[]` with `source`, `mediaType`, `extension`, `maxInputBytes`, `targets[]`), with Swagger decorators (depends on T007)
- [X] T046 [US2] Add `GET /api/convert/formats` to `src/modules/conversion/conversion.controller.ts`, building the response from `FormatRegistryService` and the resolved limits, sources sorted alphabetically and targets sorted alphabetically — never from a constant (FR-030) (depends on T019, T045)
- [X] T047 [US2] Extend `src/modules/conversion/conversion.controller.spec.ts` to assert the list is registry-derived: adding a stub handler adds its source and widens every other source's targets, with no edit to the controller (depends on T046)
- [X] T048 [US2] Extend `test/file-conversion.e2e-spec.ts` with the SC-010 check: read `GET /api/convert/formats`, drive **every** advertised pair through `POST /api/convert` expecting success, and assert every unadvertised pair (including each self-direction) is refused; plus `401` for an unauthenticated discovery request (depends on T046, T044)

**Checkpoint**: Discovery is provably consistent with conversion

---

## Phase 5: User Story 3 - Every conversion attempt is recorded against its user (Priority: P1)

**Goal**: Every authenticated attempt, successful or failed, writes a
`conversion_records` row holding process metadata only.

**Independent Test**: Run one successful and one failing conversion as a
known user, then query `conversion_records` and verify exactly two rows with
correct formats, sizes, outcomes, and durations — and no file content in any
column.

- [X] T049 [US3] Create `src/modules/conversion/conversion-history.service.ts` writing one row per attempt with an explicit column list, mapping each `ConversionErrorCategory` onto the row and storing `failureReason` as a fixed code plus optional line/column — never a library message (FR-022, FR-023) (depends on T014, T012)
- [X] T050 [US3] Write `src/modules/conversion/conversion-history.service.spec.ts` covering a success row, one row per error category, the `CHECK`-constraint invariants held at the call site, and an assertion that no written field contains input bytes (SC-005) (depends on T049)
- [X] T051 [US3] Wire history into `src/modules/conversion/conversion.service.ts` from a `finally` block, **outside** any transaction, so the record survives every failure path including a client disconnect (FR-024); records are written for every attempt that reaches field validation (depends on T037, T049)
- [X] T052 [US3] Add the FR-031 log line to `src/modules/conversion/conversion.service.ts`: user id, source format, target format, input size, outcome with error code, and duration — and nothing else (depends on T051)
- [X] T053 [US3] Extend `test/file-conversion.e2e-spec.ts` with history assertions: a success and a failure each produce exactly one correctly attributed row, the failure row carries an `error_category`, a timed-out attempt is recorded, and no row holds content from the fixtures (SC-004, SC-005) (depends on T051, T044)

**Checkpoint**: Every attempt is durably attributed; nothing leaks content

---

## Phase 6: User Story 4 - User optionally keeps the converted file in application storage (Priority: P2)

**Goal**: `store=true` retains the result under `CONVERSION_STORAGE_DIR` and
links it to the history record; a storage failure never turns a good
conversion into an error.

**Independent Test**: Run the same conversion twice, once with `store=true`
and once without, and verify a stored file and its history link exist only
for the first while the downloaded bytes are identical in both.

- [X] T054 [P] [US4] Create `src/core/storage/conversion-file-storage.service.ts` writing under `CONVERSION_STORAGE_DIR` at `<userId>/<id>.<ext>` — deliberately **not** `ASSETS_DIR`, which `@fastify/static` serves unauthenticated (FR-027) (depends on T004)
- [X] T055 [US4] Write `src/core/storage/conversion-file-storage.service.spec.ts` covering directory creation, the path layout, a write failure surfacing as a distinct storage error, and that the resolved root is never inside `ASSETS_DIR` (depends on T054)
- [X] T056 [US4] Provide and export `ConversionFileStorageService` from `src/core/storage/storage.module.ts` (depends on T054)
- [X] T057 [US4] Create `src/modules/conversion/conversion-retention.service.ts` writing the `conversion_stored_files` row and the history link together under `@Transactional()` on success, and reporting `ConversionRetentionOutcome.FAILED` without throwing when storage fails (FR-026, FR-028) (depends on T015, T054)
- [X] T058 [US4] Write `src/modules/conversion/conversion-retention.service.spec.ts` covering retention requested and stored, not requested, storage failure → `failed` with no row and no exception, and that nothing is stored for a failed conversion (depends on T057)
- [X] T059 [US4] Wire retention into `src/modules/conversion/conversion.service.ts` and emit the `X-Conversion-Retention: not-requested|stored|failed` header from `src/modules/conversion/conversion.controller.ts` (depends on T051, T057, T039)
- [X] T060 [US4] Extend `test/file-conversion.e2e-spec.ts` with retention coverage: `store=true` stores the file and links it, `store` absent stores nothing with byte-identical output, a failed conversion with `store=true` stores nothing, a simulated storage failure still returns `200` with `X-Conversion-Retention: failed`, and the retained path is not reachable under `/assets/` (FR-027) (depends on T059)

**Checkpoint**: Optional retention works and is private to its owner

---

## Phase 7: User Story 5 - Oversized, unsupported, and unauthenticated requests are refused safely (Priority: P1)

**Goal**: Each refusal path produces its own distinct, correct status before
any conversion work happens.

**Independent Test**: With a small CSV limit configured, submit an oversized
file per format, an unsupported blob, an empty file, a missing/invalid
target format, and an unauthenticated request — and verify six distinct
refusals with no conversion performed.

- [X] T061 [US5] Enforce the distinct field refusals in `src/modules/conversion/conversion.controller.ts`: `missing_file`, `empty_file`, `unexpected_part` (extra, duplicate, or misnamed part), `missing_target_format`, `invalid_store_flag`, and `unsupported_target_format` → 415 (depends on T039, T035)
- [X] T062 [US5] Apply the **detected** format's budget in `src/modules/conversion/conversion.service.ts` so the limit differs per source format, with the 413 message naming the applicable limit and the remainder of the upload never read (FR-016, SC-006) (depends on T037, T017, T033)
- [X] T063 [US5] Add `@Throttle({ default: { limit: 10, ttl: 60000 } })` to the `POST /api/convert` handler in `src/modules/conversion/conversion.controller.ts` (FR-015) (depends on T039)
- [X] T064 [P] [US5] Add refusal fixtures to `test/support/conversion-fixtures/`: `empty.csv` (zero bytes), a non-UTF-8 file, `blob.png`, `xxe.xml` with a `<!DOCTYPE` entity declaration, `deep.json` (200 levels), a YAML alias bomb, and an oversized CSV
- [X] T065 [US5] Extend `test/file-conversion.e2e-spec.ts` with the refusal matrix: 401 unauthenticated, 400 for zero-byte / same-format / invalid `store` / invalid UTF-8 / malformed input, 413 over the CSV limit with the limit named, 200 for the same byte count as JSON (US5 scenario 3), 415 for the blob and for `targetFormat=toml`, and 429 past the rate limit (depends on T061, T062, T063, T064)
- [X] T066 [US5] Extend `test/file-conversion.e2e-spec.ts` with the safety refusals: `xxe.xml` → `400 xml_doctype_forbidden` with no fragment of the referenced file in the body (SC-007), `deep.json` → `400 structure_limit_exceeded`, and the alias bomb refused promptly (depends on T064, T044)

**Checkpoint**: Every documented refusal is distinct, correct, and cheap

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T067 Add the full Swagger surface to `src/modules/conversion/conversion.controller.ts`: `@ApiTags('conversion')`, `@ApiConsumes('multipart/form-data')`, an `@ApiBody` schema for the three parts, and a response decorator for every documented status (Constitution V)
- [X] T068 [P] Add `CONVERSION_MAX_CONCURRENT` (default 4) to `src/core/config/config.types.ts`, `src/core/config/config.validation.ts`, and `.env.example`, and apply it as a semaphore around the pipeline in `src/modules/conversion/conversion.service.ts` with waiters subject to the same deadline ([research.md §11](./research.md))
- [X] T069 [P] Link the mapping-rules document from the root `README.md` and note the `CONVERSION_*` settings and the storage root
- [X] T070 Measure SC-002 (≤1 MiB under 5s) and SC-008 (ten concurrent 1 MiB conversions, no unrelated request delayed over 1s); if SC-008 fails, apply the stated contingency — move `read`/`write` into a `worker_threads` pool behind the unchanged `FormatHandler` interface ([research.md §11](./research.md))
- [X] T071 Audit every log statement and every persisted field across all error and success paths for file content (SC-005), including the library-message mapping boundary in each handler
- [X] T072 Run `npm run verify` and `npm run test:e2e` and fix anything they surface
- [X] T073 Walk [quickstart.md](./quickstart.md) scenarios 1–10 against a locally running server and reconcile any discrepancy between the document and the implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: Depends on Foundational. No dependency on other stories
- **US2 (Phase 4)**: Depends on Foundational only. Can run fully parallel to US1 — it needs the registry, not the handlers (though its SC-010 e2e check in T048 needs US1's conversion route)
- **US3 (Phase 5)**: Depends on Foundational; T051 wires into US1's service, so it lands after T037
- **US4 (Phase 6)**: Depends on Foundational; T059 wires into US1's service and US3's history record
- **US5 (Phase 7)**: Depends on Foundational; wires into US1's controller and service
- **Polish (Phase 8)**: After the stories you intend to ship

### Story Dependencies

US1, US2, US3, and US5 are all P1 and all independently *testable*, but
US3, US4, and US5 each attach behaviour to the pipeline US1 builds. Building
US1 first is therefore the cheapest order; the alternative is stubbing the
service, which costs more than it saves.

### Within Each Story

Models and pure functions → handlers → services → controller → e2e. Handler
unit tests are written against the mapping-rules contract, so they can be
written before or alongside their handler.

### Parallel Opportunities

- T002/T003 in Setup; T006 any time
- T007/T008 then T010, T013, T014, T015 in Foundational
- All four handlers (T025, T027, T029, T031) are separate files with no
  dependency on one another — the widest parallel window in the feature
- US2 (T045–T047) runs alongside US1 entirely
- T054 (core storage) can be built during US1 if a second developer is free

---

## Parallel Example: User Story 1 handlers

```bash
# Four handlers, four files, no shared state:
Task: "Create JSON handler in src/modules/conversion/formats/json.handler.ts"
Task: "Create CSV handler in src/modules/conversion/formats/csv.handler.ts"
Task: "Create XML handler in src/modules/conversion/formats/xml.handler.ts"
Task: "Create YAML handler in src/modules/conversion/formats/yaml.handler.ts"

# Their specs, likewise:
Task: "Write src/modules/conversion/formats/json.handler.spec.ts"
Task: "Write src/modules/conversion/formats/csv.handler.spec.ts"
Task: "Write src/modules/conversion/formats/xml.handler.spec.ts"
Task: "Write src/modules/conversion/formats/yaml.handler.spec.ts"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1
4. **STOP and VALIDATE**: twelve directions, round trips, headers
5. Demo — a signed-in user can convert files

### Incremental Delivery

1. Setup + Foundational → hub and contract in place
2. + US1 → conversions work (MVP)
3. + US2 → clients stop hard-coding the direction list
4. + US3 → every attempt is attributable (required before any real traffic)
5. + US5 → refusals are distinct and the service is defensible
6. + US4 → optional retention

US3 and US5 are P1 alongside US1 and should ship in the same release; US4 is
the only genuinely deferrable slice.

### Parallel Team Strategy

After Foundational: Developer A takes US1 (the handlers parallelize further
inside it), Developer B takes US2 then US3, Developer C takes the storage
service and US4. US5 lands last because it touches the controller and
service that US1 owns.

---

## Notes

- `[P]` means a different file with no incomplete dependency
- The mapping-rules contract is the specification for the handler unit
  tests — SC-011 requires one test per documented rule
- Never propagate a library parser message into an HTTP body, a log line, or
  `failure_reason`: those messages quote input (FR-023, SC-005)
- `POSTGRES_SYNCHRONIZE` stays `false`; schema changes go through T016 only
- Commit per task or per logical group; run `npm run format` and
  `npm run lint` before committing (Constitution workflow)
