---

description: "Task list for Image Conversion (011-image-conversion)"
---

# Tasks: Image Conversion

**Input**: Design documents from `/specs/011-image-conversion/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: INCLUDED. Constitution IV is NON-NEGOTIABLE, and plan.md commits to
unit specs per handler plus an e2e suite. Test tasks are written before the
implementation they cover within each phase.

**Organization**: grouped by user story so each is implementable and testable
on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: the user story a task serves (US1…US6)
- Paths are relative to the repository root

## Path Conventions

Single existing NestJS backend: `src/core/`, `src/modules/`,
`src/database/migrations/`, `test/`. Imports use the `@/` alias
(Constitution, Technical Stack).

## A note on where the safety guards live

US3 is "unsafe uploads are refused". Two of its guards ship inside the
handlers they protect rather than in the US3 phase:

- the **header-only pixel budget** is built into the raster handlers in US1,
- the **SVG safety validator** is built into the SVG handler in US2.

A decoder without its guard must not ship at all (Constitution II,
NON-NEGOTIABLE), so those guards are written with the decoders. US3 owns the
service-level safety envelope — per-format byte budgets, the deadline, the
concurrency bound, the output ceiling — and the complete verification suite
that proves every refusal in [contracts/image-conversion-api.md](./contracts/image-conversion-api.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependencies and configuration the whole feature reads

- [X] T001 Add `sharp` (^0.35) and `@resvg/resvg-js` (^2.6) to `dependencies` in `package.json` and install them, confirming prebuilt binaries resolve on the local platform
- [X] T002 [P] Declare the twelve `IMAGE_*` settings (`IMAGE_MAX_BYTES_PNG`, `_JPEG`, `_SVG`, `IMAGE_MAX_OUTPUT_WIDTH`, `_HEIGHT`, `IMAGE_MAX_PIXELS`, `IMAGE_MAX_OUTPUT_BYTES`, `IMAGE_BACKGROUND_COLOR`, `IMAGE_JPEG_QUALITY`, `IMAGE_CONVERSION_TIMEOUT_MS`, `IMAGE_MAX_CONCURRENT`, `IMAGE_SVG_FONT_DIR`) in `src/core/config/config.types.ts`
- [X] T003 [P] Add the Joi schema entries and defaults for all `IMAGE_*` settings in `src/core/config/config.validation.ts` — every numeric value a positive integer, `IMAGE_BACKGROUND_COLOR` matched against `^#[0-9a-fA-F]{6}$`, `IMAGE_SVG_FONT_DIR` optional and defaulting to empty (research.md §14)
- [X] T004 [P] Document the `IMAGE_*` settings with their defaults in `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared vocabulary, the persisted enum, and the module's
structural core. Nothing in any user story can be built until this is done.

**⚠️ CRITICAL**: no user story work begins before this phase completes.

### Feature 010 shared vocabulary (additive edits only)

- [X] T005 Add the `ImageFormat` enum (`png`, `jpeg`, `svg`) and the `RecordedFormat = ConversionFormat | ImageFormat` union plus its value object in `src/modules/conversion/conversion.enums.ts`, leaving `ConversionFormat` untouched so the text handlers' exhaustive maps keep compiling
- [X] T006 Add the eight new error codes (`image_invalid`, `image_pixel_budget_exceeded`, `image_dimensions_exceeded`, `svg_no_intrinsic_size`, `svg_active_content`, `svg_external_reference`, `svg_render_failed`, `image_vectorisation_unsupported`) to `ConversionErrorCode` in `src/modules/conversion/conversion.constants.ts`
- [X] T007 Add a status/category/message definition for each new code to `CONVERSION_ERROR_DEFINITIONS` and widen `ConversionErrorParams` with the numeric `width`, `height`, `maxWidth`, `maxHeight`, `pixels` fields in `src/modules/conversion/conversion.exception.ts` (depends on T006; params stay numbers only, so no file content can reach a message — FR-026, SC-012)
- [X] T008 [P] Widen `sourceFormat` / `targetFormat` column types to `RecordedFormat` in `src/modules/conversion/entities/conversion-record.entity.ts`
- [X] T009 [P] Widen the `format` column type to `RecordedFormat` in `src/modules/conversion/entities/conversion-stored-file.entity.ts`
- [X] T010 [P] Widen the format fields of `ConversionAttempt` to `RecordedFormat` in `src/modules/conversion/conversion-history.service.ts`
- [X] T011 [P] Widen `RetentionRequest.format` and `StoredFile.format` to `RecordedFormat` in `src/modules/conversion/conversion-retention.service.ts`
- [X] T012 Export `ConversionHistoryService` and `ConversionRetentionService` from the `exports` array in `src/modules/conversion/conversion.module.ts` so the image module can inject them
- [X] T013 Create the migration `src/database/migrations/1761300000000-ImageConversion.migration.ts` widening the `conversion_format` PostgreSQL enum to seven values by transactional type swap across `conversion_records.source_format`, `conversion_records.target_format`, and `conversion_stored_files.format`, with a `down` that counts image-format rows and throws naming the count rather than deleting history (research.md §9)
- [X] T014 Extend `src/modules/conversion/conversion.exception.spec.ts` with status, category, and message assertions for the eight new codes, including that a message built with the new numeric params contains no free text

### Image module structural core

- [X] T015 [P] Create the canonical `RasterImage` model with its construction invariants (`data.length === width * height * channels`, `width/height ≥ 1`, `hasAlpha ⇒ channels === 4`, `width * height ≤ limits.maxPixels`, and no metadata field) in `src/modules/image-conversion/formats/raster-image.ts`
- [X] T016 [P] Create `src/modules/image-conversion/formats/raster-image.spec.ts` covering every invariant, including that the type exposes no field capable of carrying EXIF or a colour profile
- [X] T017 [P] Create the `ImageFormatHandler` interface with optional `decode` / `encode`, the `ImageConversionLimits` and `ImageConversionContext` types, and the `IMAGE_FORMAT_HANDLERS` / `IMAGE_CONVERSION_LIMITS` DI tokens in `src/modules/image-conversion/formats/image-format-handler.ts`
- [X] T018 [P] Create `src/modules/image-conversion/image-conversion.constants.ts` holding the PNG/JPEG/SVG magic-byte signatures, detection priorities, conclusiveness flags, media types, extension hints (`jpeg` → `jpg`), and the reuse of `DETECTION_PREFIX_BYTES`
- [X] T019 Create `ImageFormatRegistryService` in `src/modules/image-conversion/image-format-registry.service.ts`, computing directions as `{handlers with decode} × {handlers with encode}` minus self-pairs, with sources and targets sorted alphabetically (depends on T017)
- [X] T020 Create `src/modules/image-conversion/image-format-registry.service.spec.ts` asserting the four directions, that `svg` never appears as a target, and that the same computation answers both discovery and enforcement
- [X] T021 Create `ImageFormatDetectorService` in `src/modules/image-conversion/image-format-detector.service.ts`, sniffing a bounded `Buffer` prefix by priority, treating each signature as conclusive, and using the file-name extension only as a secondary hint (depends on T017, T018)
- [X] T022 Create `src/modules/image-conversion/image-format-detector.service.spec.ts` covering each signature, a `.png`-named file containing JPEG bytes detected as JPEG, an SVG behind a BOM and whitespace, and a file matching nothing
- [X] T023 Create `src/modules/image-conversion/image-conversion.module.ts` importing `ConversionModule`, `AuthModule`, `ConfigModule`, `StorageModule` and the `TypeOrmModule.forFeature` entities `JwtAuthGuard` needs, with the `IMAGE_CONVERSION_LIMITS` factory resolving every `IMAGE_*` setting from `ConfigService` once (depends on T002, T003, T012, T017)
- [X] T024 Register `ImageConversionModule` in the `imports` array of `src/core/app/app.module.ts`

**Checkpoint**: the module boots, the enum is widened, and the shared services
accept image formats. User story work can begin.

---

## Phase 3: User Story 1 - Raster ↔ raster conversion (Priority: P1) 🎯 MVP

**Goal**: a signed-in user uploads a PNG or JPEG, names the other raster
format, and downloads a valid image of that format with the same pixel
dimensions — transparency composited onto the configured background when the
target cannot hold alpha.

**Independent Test**: sign in; upload a PNG asking for JPEG and a JPEG asking
for PNG; verify each response is a valid image of the requested format with
the source's dimensions, carries `Content-Type` and
`Content-Disposition: attachment; filename="converted.<ext>"`, and that a
transparent PNG converted to JPEG comes back fully opaque on `#ffffff`.

### Tests for User Story 1 ⚠️

- [X] T025 [P] [US1] Create the committed fixture generator `test/support/generate-image-fixtures.ts` producing the raster fixtures (solid PNG/JPEG, transparent PNG, greyscale PNG, indexed PNG, 16-bit PNG, EXIF-rotated JPEG, truncated PNG, zero-byte file, non-image bytes) into `test/support/image-fixtures/`, and wire it into an npm script
- [X] T026 [P] [US1] Create `src/modules/image-conversion/formats/png.handler.spec.ts` covering decode of greyscale, indexed, and 16-bit PNGs normalised to 8-bit, EXIF orientation applied, alpha preserved on encode, and a truncated file surfacing `image_invalid`
- [X] T027 [P] [US1] Create `src/modules/image-conversion/formats/jpeg.handler.spec.ts` covering decode with orientation applied, that no alpha channel is invented, flattening onto `IMAGE_BACKGROUND_COLOR`, encoding at `IMAGE_JPEG_QUALITY`, and first-frame-only behaviour for multi-frame input
- [X] T028 [P] [US1] Create `test/image-conversion.e2e-spec.ts` with the PNG→JPEG and JPEG→PNG journeys asserting valid output, exact dimension preservation, the attachment headers, and pixel-wise background compositing for a transparent PNG → JPEG (SC-001, SC-002, SC-003)

### Implementation for User Story 1

- [X] T029 [P] [US1] Implement `PngHandler` with `decode` and `encode` in `src/modules/image-conversion/formats/png.handler.ts` — `sharp(buf).metadata()` header read, the pixel-budget refusal before `.raw()`, `limitInputPixels` on the decode, `.rotate()` for EXIF, sRGB conversion, and PNG encode preserving alpha (FR-008, FR-009, FR-019)
- [X] T030 [P] [US1] Implement `JpegHandler` with `decode` and `encode` in `src/modules/image-conversion/formats/jpeg.handler.ts` — the same header-first budget and orientation handling, `.flatten({ background })` before encode, and `IMAGE_JPEG_QUALITY` as a fixed non-caller-supplied quality
- [X] T031 [US1] Create `ConvertImageRequestDto` with `targetFormat` and optional `store` in `src/modules/image-conversion/dto/convert-image-request.dto.ts`, validated explicitly through `class-validator` because the global `ValidationPipe` never sees a multipart body
- [X] T032 [US1] Implement the `ImageConversionService` pipeline in `src/modules/image-conversion/image-conversion.service.ts` — read multipart parts, detect the source format, resolve the direction through the registry, `decode → RasterImage → encode`, and return a complete output buffer before any header is written (FR-012)
- [X] T033 [US1] Create `src/modules/image-conversion/image-conversion.service.spec.ts` covering the happy path for both raster directions, `image_invalid` on corrupt input, and that the encoded buffer is complete before the method resolves
- [X] T034 [US1] Implement `ImageConversionController` with `POST api/images/convert` in `src/modules/image-conversion/image-conversion.controller.ts` — `JwtAuthGuard`, `@Throttle({ default: { limit: 5, ttl: 60000 } })`, `Content-Type`, `Content-Disposition: attachment; filename="converted.<ext>"`, and the `@ApiTags`/`@ApiConsumes`/`@ApiProduces`/`@ApiBody` decorators with a response decorator per documented status
- [X] T035 [US1] Create `src/modules/image-conversion/image-conversion.controller.spec.ts` asserting header shaping, status mapping from `ConversionException`, and that the controller holds no conversion logic
- [X] T036 [US1] Register `PngHandler` and `JpegHandler` in `providers` and in the `IMAGE_FORMAT_HANDLERS` factory in `src/modules/image-conversion/image-conversion.module.ts`, and register the controller
- [X] T037 [US1] Write the `conversion_records` row from a `finally` block outside any transaction via `ConversionHistoryService`, and emit the FR-032 log line (`user`, `source`, `target`, `inputBytes`, `outcome`/`code`, `durationMs` — numbers and fixed codes only) in `src/modules/image-conversion/image-conversion.service.ts`
- [X] T038 [US1] Extend `src/modules/image-conversion/image-conversion.service.spec.ts` with history-write assertions for success and failure, and that neither the row nor the log line carries file name content or pixels (FR-024, FR-026, FR-027)

**Checkpoint**: PNG ↔ JPEG conversion works end to end, is recorded, and is the
deployable MVP.

---

## Phase 4: User Story 2 - SVG rasterised into PNG or JPEG (Priority: P1)

**Goal**: a signed-in user uploads an SVG and receives it rendered at the
drawing's own intrinsic size over the configured background, or a clear
refusal when the size cannot be determined or exceeds the configured maximum.

**Independent Test**: upload an SVG declaring `width`/`height` and request PNG,
then JPEG, verifying both come back at the declared size; upload a
`viewBox`-only SVG and verify the derived size; upload an SVG with no
determinable size and one declaring `99999×99999` and verify each is refused
with its own code.

### Tests for User Story 2 ⚠️

- [X] T039 [P] [US2] Create `src/modules/image-conversion/formats/svg-intrinsic-size.spec.ts` covering every branch of the rule — unitless, `px`/`pt`/`pc`/`mm`/`cm`/`in` at 96 dpi, `em`/`ex`/`%` not resolving, `viewBox` fallback per dimension, fractional values ceiled with a minimum of 1, zero and negative refused, and each worked example in [contracts/image-rasterisation-rules.md](./contracts/image-rasterisation-rules.md) §5
- [X] T040 [P] [US2] Create `src/modules/image-conversion/formats/svg-security.spec.ts` with one case per refusal in [contracts/image-rasterisation-rules.md](./contracts/image-rasterisation-rules.md) §6, plus the parse-differential cases the raw-text scan exists for, and assertions that fragment references and inline `data:` URIs pass and that the original bytes are returned unrewritten
- [X] T041 [P] [US2] Create `src/modules/image-conversion/formats/svg.handler.spec.ts` asserting validate → size → render ordering, that nothing is rendered when validation or sizing fails, `svg_render_failed` on a drawing resvg rejects, and that the handler exposes no `encode`
- [X] T042 [P] [US2] Add the valid SVG fixtures (declared size, `viewBox`-only, mixed width-only, no size, enormous) to `test/support/image-fixtures/` and extend `test/image-conversion.e2e-spec.ts` with SVG→PNG and SVG→JPEG success plus the `svg_no_intrinsic_size` and `image_dimensions_exceeded` refusals

### Implementation for User Story 2

- [X] T043 [P] [US2] Implement the deterministic intrinsic-size rule in `src/modules/image-conversion/formats/svg-intrinsic-size.ts` — independent width/height resolution, unit conversion at 96 dpi, `viewBox` fallback, ceiling to whole pixels, then the `IMAGE_MAX_OUTPUT_WIDTH`/`_HEIGHT`/`IMAGE_MAX_PIXELS` check naming the limit exceeded (FR-010, FR-018)
- [X] T044 [P] [US2] Implement the reject-only validator in `src/modules/image-conversion/formats/svg-security.ts` — UTF-8 validation and BOM strip, the case-insensitive raw-text scan (`<!DOCTYPE`, `<!ENTITY`, `<script`, `javascript:`, `@import`, `on<name>=`), then the `fast-xml-parser` walk with `processEntities: false` refusing active elements, `on*` attributes, and every non-fragment, non-`data:` URL reference; it refuses or passes the original bytes through and never rewrites (FR-020, FR-021)
- [X] T045 [US2] Implement `SvgHandler` with `decode` only — no `encode`, so vectorisation stays unrepresentable — in `src/modules/image-conversion/formats/svg.handler.ts`, calling the validator, then the sizer, then rendering with `@resvg/resvg-js` at `fitTo: { mode: 'original' }` over `IMAGE_BACKGROUND_COLOR` with `loadSystemFonts: false` and the optional `IMAGE_SVG_FONT_DIR`, preferring `renderAsync` (depends on T043, T044)
- [X] T046 [US2] Register `SvgHandler` in `providers` and in the `IMAGE_FORMAT_HANDLERS` factory in `src/modules/image-conversion/image-conversion.module.ts`
- [X] T047 [US2] Add the SVG-specific branches to `src/modules/image-conversion/image-conversion.service.spec.ts` — that the SVG path refuses before any renderer is constructed, and that both SVG directions produce a complete buffer

**Checkpoint**: all four directions in FR-002 work; US1 and US2 are each
independently testable.

---

## Phase 5: User Story 3 - Unsafe and abusive uploads refused before work (Priority: P1)

**Goal**: the service-level safety envelope — per-source-format byte budgets
applied while the upload streams, a conversion deadline, a concurrency bound,
and an output ceiling — together with proof that every refusal in the contract
fires with its own distinct outcome and that no outbound request is ever made.

**Independent Test**: with per-format limits configured, submit a scripted SVG,
an SVG with an external entity, an SVG referencing a remote image, an oversized
file of each format, and a sub-100 KiB PNG declaring enormous dimensions —
verifying each is refused with its own status and code, that network egress is
observed to be zero, and that unrelated requests keep being served.

### Tests for User Story 3 ⚠️

- [X] T048 [P] [US3] Add the SVG attack corpus (`scripted.svg`, `onload.svg`, `xxe.svg`, `remote-image.svg`, an `@import` stylesheet, a `javascript:` href, a billion-laughs entity document) to `test/support/image-fixtures/`
- [X] T049 [P] [US3] Add the safety suite to `test/image-conversion.e2e-spec.ts` — each corpus file refused with its own code (`svg_active_content`, `svg_external_reference`, `xml_doctype_forbidden`), asserted against a listening local socket that records zero connections for the duration (SC-006)
- [X] T050 [P] [US3] Add the limit suite to `test/image-conversion.e2e-spec.ts` — a sub-100 KiB PNG declaring dimensions over the budget refused as `image_pixel_budget_exceeded` with process memory sampled before and after (SC-007); an oversized upload per format refused as `413 input_too_large` before the whole body is consumed (SC-008); and the same byte count accepted under PNG's limit while refused under SVG's (US3.4)

### Implementation for User Story 3

- [X] T051 [US3] Set per-request multipart limits (`request.parts({ limits: { fileSize, files: 1 } })` at the largest configured image limit) and consume the file through feature 010's `UploadReader` under the **detected** source format's budget in `src/modules/image-conversion/image-conversion.service.ts`, leaving `src/main.ts` untouched (FR-017, SC-008)
- [X] T052 [US3] Implement the conversion deadline in `src/modules/image-conversion/image-conversion.service.ts` — an `AbortSignal` taken once the upload completes, carried in `ImageConversionContext`, checked at every `await` boundary, and reported as the shared `timeout` code (FR-022, SC-005)
- [X] T053 [US3] Implement the semaphore bounded by `IMAGE_MAX_CONCURRENT` in `src/modules/image-conversion/image-conversion.service.ts`, with a counter separate from the text pipeline's and waiters subject to the same deadline so queueing buys no extra time (FR-023)
- [X] T054 [US3] Enforce the `IMAGE_MAX_OUTPUT_BYTES` ceiling on the encoded buffer, refusing as `output_too_large` before any header is written, in `src/modules/image-conversion/image-conversion.service.ts`
- [X] T055 [US3] Handle caller disconnect in `src/modules/image-conversion/image-conversion.service.ts` — abandon the conversion and still write the history row from the `finally` block (FR-027)
- [X] T056 [US3] Extend `src/modules/image-conversion/image-conversion.service.spec.ts` with unit coverage for the per-format byte budget, the deadline firing between decode and encode, the semaphore admitting at most `maxConcurrent`, the output ceiling, and a history row written for each of those failures
- [X] T057 [US3] Add a unit assertion in `src/modules/image-conversion/image-conversion.service.spec.ts` that the module imports no HTTP client and reads no file named by an uploaded document — the FR-021 guarantee is the absence of a code path

**Checkpoint**: arbitrary user images can be accepted safely; all three P1
stories are complete.

---

## Phase 6: User Story 4 - Client discovers the available directions (Priority: P2)

**Goal**: a signed-in client reads the supported directions from the service
instead of hard-coding them, and the advertised set matches the accepted set
exactly.

**Independent Test**: sign in, request the directions, verify PNG offers JPEG,
JPEG offers PNG, SVG offers PNG and JPEG, no entry offers SVG as a target, and
that an unauthenticated caller is rejected.

### Tests for User Story 4 ⚠️

- [X] T058 [P] [US4] Add the discovery cases to `test/image-conversion.e2e-spec.ts` — the exact response shape including `mediaType`, `extension`, and `maxInputBytes` per source, stable alphabetical ordering, no `svg` in any `targets`, and `401` without a session
- [X] T059 [P] [US4] Add the SC-010 conformance test to `test/image-conversion.e2e-spec.ts` — read `GET api/images/convert/formats`, drive every advertised pair to success, and assert every unadvertised pair is refused
- [X] T060 [P] [US4] Extend `src/modules/image-conversion/image-format-registry.service.spec.ts` with the SC-014 case: registering a fake handler implementing both capabilities widens the direction set, with no existing handler consulted or changed

### Implementation for User Story 4

- [X] T061 [P] [US4] Create `SupportedImageFormatsResponseDto` with the `formats` array of `{ source, mediaType, extension, maxInputBytes, targets }` and its `@ApiProperty` decorators in `src/modules/image-conversion/dto/supported-image-formats-response.dto.ts`
- [X] T062 [US4] Add the `GET api/images/convert/formats` route behind `JwtAuthGuard` in `src/modules/image-conversion/image-conversion.controller.ts`, building the response from `ImageFormatRegistryService` and the resolved limits at request time, with its OpenAPI decorators
- [X] T063 [US4] Extend `src/modules/image-conversion/image-conversion.controller.spec.ts` asserting the discovery response is derived from the registry rather than from a literal, so discovery and enforcement cannot diverge (FR-013, FR-034)

**Checkpoint**: clients can build a format picker from the service.

---

## Phase 7: User Story 5 - Wrong parameters, formats, or no session refused distinctly (Priority: P2)

**Goal**: every malformed request variant receives its own correct,
distinguishable refusal, with no conversion work performed.

**Independent Test**: submit each variant — no session, no file, zero-byte
file, missing `targetFormat`, unrecognised `targetFormat`, raster source with
`targetFormat=svg`, target equal to the detected source, and a non-image file —
and verify each produces its own status and code.

### Tests for User Story 5 ⚠️

- [X] T064 [P] [US5] Add the full refusal matrix to `test/image-conversion.e2e-spec.ts`, one case per row of the contract's error table, each asserting both the HTTP status and the `code` in the body, and that `401` writes no history row
- [X] T065 [P] [US5] Add the ordering case to `test/image-conversion.e2e-spec.ts` — a request that is both oversized and missing `targetFormat` is answered `413`, not `400` (contract, "Order of refusals")

### Implementation for User Story 5

- [X] T066 [US5] Implement the field-level refusals in `src/modules/image-conversion/image-conversion.service.ts` — `missing_file`, `empty_file`, `unexpected_part` for an extra, duplicate, or misnamed part, `missing_target_format`, `invalid_store_flag`, and `unsupported_target_format` for a value outside the accepted set
- [X] T067 [US5] Implement the direction refusals in `src/modules/image-conversion/image-conversion.service.ts` — `image_vectorisation_unsupported` (415) when a raster source names `svg`, and `same_format` (400) when the target equals the detected source — both resolved from the registry's capability set, not from a literal list (FR-003, FR-005)
- [X] T068 [US5] Extend `src/modules/image-conversion/image-conversion.service.spec.ts` with a case per refusal asserting the fixed order of checks and that no decode or render is attempted in any of them

**Checkpoint**: the endpoint is diagnosable by a client and in support.

---

## Phase 8: User Story 6 - Optional retention of the converted image (Priority: P2)

**Goal**: a user may ask for the converted image to be kept in application
storage; the history row then points at the stored file, and a storage failure
is reported distinctly from a conversion failure.

**Independent Test**: run the same conversion twice, once with `store=true` and
once without, and verify a stored file exists and is referenced by history only
for the first while the downloaded bytes are identical in both.

### Tests for User Story 6 ⚠️

- [X] T069 [P] [US6] Add the retention cases to `test/image-conversion.e2e-spec.ts` — stored, not requested, a forced storage failure returning a valid image with `X-Image-Conversion-Retention: failed`, and a failed conversion leaving nothing on disk (SC-015, US6.1–US6.4)
- [X] T070 [P] [US6] Add a test to `test/image-conversion.e2e-spec.ts` asserting a retained image lands under `CONVERSION_STORAGE_DIR` at `<userId>/<id>.<ext>`, outside the statically served `ASSETS_DIR`, and is not reachable over HTTP (FR-030)

### Implementation for User Story 6

- [X] T071 [US6] Plumb the validated `store` flag from `ConvertImageRequestDto` through the pipeline in `src/modules/image-conversion/image-conversion.service.ts`, defaulting to `false` when unspecified (FR-028)
- [X] T072 [US6] Store the encoded result through `ConversionRetentionService` only on success, link it to the history row, and record `retention_outcome` as `not_requested` / `stored` / `failed` in `src/modules/image-conversion/image-conversion.service.ts` (FR-029, FR-031)
- [X] T073 [US6] Emit the `X-Image-Conversion-Retention` response header in `src/modules/image-conversion/image-conversion.controller.ts`, named distinctly from `/api/convert`'s `X-Conversion-Retention`, and document it in the OpenAPI response decorators
- [X] T074 [US6] Extend `src/modules/image-conversion/image-conversion.service.spec.ts` with the three retention outcomes, asserting a storage failure never changes the HTTP status and never records the image as retained

**Checkpoint**: all six user stories are independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T075 [P] Write `src/modules/image-conversion/README.md` covering the capability model, the four directions and why `png→svg` is unrepresentable, the SVG safety and intrinsic-size rules, the "no font directory ⇒ `<text>` renders as nothing" caveat, whether the installed `@resvg/resvg-js` exposes `renderAsync` (and if not, that the output-dimension cap is the operative bound), and the worked "adding WebP" example required by SC-014
- [X] T076 [P] Link the image rules document and the new module README from the root `README.md`
- [X] T077 [P] Create `test/image-conversion-perf.e2e-spec.ts` mirroring `test/conversion-perf.e2e-spec.ts` — a 2 MiB conversion under five seconds (SC-004), a timeout honoured within its budget plus five seconds (SC-005), and ten concurrent 2 MiB conversions with an unrelated `GET /health` delayed by under one second (SC-013)
- [X] T078 [P] Add the SC-012 inspection test to `test/image-conversion.e2e-spec.ts` — across every success and error path, assert no `conversion_records` column and no captured log line contains bytes from the uploaded or produced image
- [X] T079 Verify the round-trip of `src/database/migrations/1761300000000-ImageConversion.migration.ts` against the e2e database via `npm run migration:run` and `npm run migration:revert` — `up` widens the enum with existing text rows intact, `down` reverses cleanly with no image rows and throws naming the count when image rows exist
- [X] T080 Audit the OpenAPI output for both routes against [contracts/image-conversion-api.md](./contracts/image-conversion-api.md) — every documented status, the three multipart parts, and both response headers present in the published document
- [X] T081 Run `npm run format` and `npm run lint`, then `npm run test` and `npm run test:e2e`, and record coverage for the new module with `npm run test:cov`
- [X] T082 Walk every scenario in [quickstart.md](./quickstart.md) against a running instance and correct any drift between the document and the implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T002/T003/T004 are parallel, T001 is independent of them
- **Foundational (Phase 2)**: depends on Setup (T023 needs the config settings) — **blocks every user story**
- **User Stories (Phases 3–8)**: all depend on Phase 2
  - US1, US2, US3 are all P1 and form the deliverable feature
  - US4, US5, US6 are P2 and each depend only on Phase 2 plus at least one conversion path existing to exercise
- **Polish (Phase 9)**: depends on the stories being complete

### User Story Dependencies

- **US1 (P1)**: after Phase 2. No dependency on any other story — the MVP
- **US2 (P1)**: after Phase 2. Independent of US1; it adds two directions through the same pipeline
- **US3 (P1)**: after Phase 2. Its service-level guards are independent; its verification suite exercises the handlers US1 and US2 build, so run it after at least one of them
- **US4 (P2)**: after Phase 2. T059's conformance test needs US1 and US2 present to drive every advertised direction
- **US5 (P2)**: after US1 — the refusal matrix is asserted against the live conversion route
- **US6 (P2)**: after US1 — retention needs a successful conversion to retain

### Within Each User Story

- Tests are written first and must fail before the implementation lands
- Models and pure functions before handlers; handlers before the service; the service before the controller
- Module registration after the provider it registers exists

### Parallel Opportunities

- Phase 1: T002, T003, T004 together
- Phase 2: T008–T011 together (four different files); T015, T016, T017, T018 together
- US1: T025, T026, T027, T028 together; then T029 and T030 together
- US2: T039, T040, T041, T042 together; then T043 and T044 together
- US3: T048, T049, T050 together
- US4: T058, T059, T060 together; T061 alongside them
- US5: T064, T065 together
- US6: T069, T070 together
- Phase 9: T075, T076, T077, T078 together
- With multiple developers, US1, US2, and US3's service-level guards can proceed in parallel once Phase 2 is done

---

## Parallel Example: User Story 1

```bash
# Tests for User Story 1, together:
Task: "Create the fixture generator in test/support/generate-image-fixtures.ts"
Task: "Create src/modules/image-conversion/formats/png.handler.spec.ts"
Task: "Create src/modules/image-conversion/formats/jpeg.handler.spec.ts"
Task: "Create test/image-conversion.e2e-spec.ts with the two raster journeys"

# Then both raster handlers, together:
Task: "Implement PngHandler in src/modules/image-conversion/formats/png.handler.ts"
Task: "Implement JpegHandler in src/modules/image-conversion/formats/jpeg.handler.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup
2. Phase 2: Foundational — CRITICAL, blocks everything
3. Phase 3: User Story 1
4. **STOP and VALIDATE**: PNG ↔ JPEG converts, dimensions are preserved,
   transparency composites onto the background, every attempt is recorded
5. Deploy or demo

### Incremental Delivery

1. Setup + Foundational → the module boots and the enum is widened
2. + US1 → raster ↔ raster (MVP)
3. + US2 → all four directions in FR-002
4. + US3 → safe to accept arbitrary user images; the P1 feature is complete
5. + US4 → clients stop hard-coding directions
6. + US5 → every refusal is distinguishable
7. + US6 → optional retention, consistent with text conversion

### Parallel Team Strategy

1. Everyone completes Phase 1 and Phase 2
2. Then: Developer A takes US1; Developer B takes US2; Developer C takes US3's
   service-level guards (T051–T057) and the safety corpus
3. US4, US5, and US6 follow, each small enough for one developer

---

## Notes

- `[P]` means a different file with no dependency on incomplete work
- Every task touching `image-conversion.service.ts` or
  `image-conversion.controller.ts` is sequential with the others on that file
- The SVG handler must never gain an `encode` — FR-003 is structural, not a rule
- The validator refuses or passes the original bytes; it never rewrites
- The pixel budget is read from the container header, never from a decoded buffer
- Commit after each task or logical group; stop at any checkpoint to validate
