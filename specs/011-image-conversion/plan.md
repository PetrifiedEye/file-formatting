# Implementation Plan: Image Conversion

**Branch**: `011-image-conversion` | **Date**: 2026-09-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-image-conversion/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a new `ImageConversionModule` exposing `POST /api/images/convert`
(multipart: `file`, `targetFormat`, optional `store`) and
`GET /api/images/convert/formats`, both behind the existing `JwtAuthGuard`
cookie session.

The architectural core is a **capability model**. Each format is one
`ImageFormatHandler` that may implement `decode`, `encode`, or both, and
conversion is always `decode → RasterImage → encode`. The registry computes
directions as *decoders × encoders minus self-pairs*. PNG and JPEG implement
both; **SVG implements only `decode`** — which yields exactly the four
directions FR-002 requires and makes FR-003 structural rather than a rule:
`png→svg` is not forbidden, it is **unrepresentable**, so discovery cannot
advertise it and the pipeline cannot reach it. Both read the same capability
set, so they cannot diverge (FR-013, FR-034, SC-009, SC-010).

Safety is enforced at the boundary in a fixed order: per-source-format byte
budgets applied while the upload streams, content-based detection from magic
bytes, a reject-only SVG validator (DOCTYPE, scripts, event handlers, and
every external reference refused — the document is never rewritten), a
**header-only pixel-budget check** before any pixel buffer is allocated, an
output-dimension check before the renderer is constructed, a concurrency
bound, and a 30-second deadline. The result is encoded **completely into a
buffer before any response header is written**, so a caller receives either a
valid image or an error — never a truncated one.

The feature **adds no table and no column**. Image attempts are rows in
feature 010's `conversion_records`, and retained images are rows in its
`conversion_stored_files`; the only schema change is widening the
`conversion_format` enum. The format value itself distinguishes an image
attempt, so no discriminator column is introduced. The canonical hub is raw
pixels with **no metadata field**, which is how "no image content or embedded
metadata is stored or logged" (FR-026, SC-012) is enforced by shape rather
than by discipline.

Technical approach and the reasoning behind each choice are in
[research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 / Node.js ≥ 20.9 (NestJS 11)

**Primary Dependencies**: NestJS 11 (Fastify), `@fastify/multipart`, TypeORM,
`@nestjs/throttler`, `@nestjs/swagger`, `class-validator` /
`class-transformer`. **New runtime packages**: `sharp` (^0.35) for PNG/JPEG
decode and encode, `@resvg/resvg-js` (^2.6) for SVG rasterisation. Both ship
prebuilt native binaries for linux x64/arm64 (glibc and musl) and darwin.
`fast-xml-parser` is already present and is reused for the SVG safety walk.
sharp's built-in SVG path (libvips → librsvg) is deliberately **not** used
([research.md §3](./research.md)).

**Storage**: PostgreSQL via TypeORM — **no new tables**. One migration widens
the existing `conversion_format` enum to include `png`, `jpeg`, `svg` via a
transactional type swap. Retained images share
`CONVERSION_STORAGE_DIR` and its `<userId>/<id>.<ext>` layout, outside the
statically served `ASSETS_DIR`.

**Testing**: Jest unit (`*.spec.ts` colocated), Supertest e2e
(`test/image-conversion.e2e-spec.ts`, `test/image-conversion-perf.e2e-spec.ts`)
against the isolated e2e database, with fixtures generated into
`test/support/image-fixtures/` by a committed script.

**Target Platform**: Linux server (containerized NestJS/Fastify backend)

**Project Type**: Single backend project (existing NestJS repo; no frontend
or mobile counterpart in scope)

**Performance Goals**: a ≤2 MiB image converted in under 5 seconds at typical
load (SC-004); a conversion abandoned within its budget plus at most 5
seconds (SC-005); ten concurrent 2 MiB conversions without delaying an
unrelated request by more than 1 second (SC-013) — helped materially by
sharp's work running on the libuv threadpool rather than the event loop.

**Constraints**: administrator-configured maximum input size **per source
format**, enforced while streaming; maximum output width and height for
rasterisation, checked **before rendering**; a decoded pixel budget checked
from the container header, **before allocation**; no SVG active content, no
external references, no DOCTYPE, and no outbound network request of any kind
during processing; a 30-second conversion budget; a concurrency bound sized
so that `maxPixels × 4 bytes × maxConcurrent` stays bounded;
complete-or-error responses; no image content or metadata in any log line or
database column; rate limiting on the conversion route;
`POSTGRES_SYNCHRONIZE` remains `false`.

**Scale/Scope**: one new module; two endpoints; three format handlers plus a
registry, a byte-level detector, an SVG validator, and an intrinsic-size
resolver; one migration altering three columns; twelve new environment
settings; eight new error codes added to the existing shared table.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research and post-design (unchanged — PASS)

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | New `src/modules/image-conversion/` module. `ImageConversionController` is HTTP-only (multipart parts, DTO validation, status mapping, headers); `ImageConversionService` orchestrates the pipeline, deadline, and semaphore; `ImageFormatRegistryService`, `ImageFormatDetectorService`, and the SVG validator/sizer hold the rest. Format handlers are providers behind one interface. Dependencies are explicit module imports — `ConversionModule` (history, retention, upload reader, error vocabulary), `AuthModule` (the guard), `ConfigModule`, `StorageModule`. The edge is one-directional: `image-conversion → conversion`, never the reverse, so there is no cycle and no service-to-service reach-around. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | `JwtAuthGuard` before any file is read. Multipart fields validated through `ConvertImageRequestDto` + `class-validator`, invoked explicitly because the global `ValidationPipe` never sees a multipart body. Per-format byte budgets applied while streaming; pixel budget from the header before allocation; output-dimension cap before rendering; a reject-only SVG validator with two independent checks; DOCTYPE and entity declarations refused outright; no HTTP client in the module. `@Throttle` at 5/min on the conversion route — tighter than the text endpoint. CORS and the global multipart registration unchanged. | PASS |
| III. Database Performance & Integrity | **No new table, no new column, no new index.** One migration widens an enum via a transactional type swap; its `down` refuses (rather than deleting history) if image rows exist. All writes go through feature 010's services, which already write explicit column lists, hold the success/failure and retention invariants in `CHECK` constraints, write the history row outside any transaction so a rollback cannot erase it, and link a stored file under `@Transactional()`. `POSTGRES_SYNCHRONIZE` stays `false`. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Unit tests per handler (including greyscale, indexed, 16-bit, and EXIF-rotated input), for every SVG refusal and every branch of the intrinsic-size rule, for the registry's derived directions, the detector's conclusiveness, the pixel budget, the deadline, the semaphore, and history writing per error category. E2E covers all four directions, pixel-wise alpha compositing, every documented refusal with its own code, the no-egress assertion, the decompression bomb, retention on/off/failed, history for success/failure/timeout/disconnect, and the automated discovery-matches-reality check. | PASS (planned) |
| V. Observability & API Documentation | `@ApiTags('image-conversion')`, `@ApiConsumes('multipart/form-data')`, `@ApiProduces('image/png','image/jpeg')`, an `@ApiBody` schema, and a response decorator for every documented status and header. Each attempt logs user, formats, input size, outcome with error code, and duration — numbers and fixed codes only, never image content. Health endpoint unchanged. | PASS |

No violations. Complexity Tracking is intentionally empty.

Four items are worth naming explicitly even though none is an exception:

- **Two new native runtime dependencies.** The constitution's stack table
  does not enumerate codecs, and it requires conversion logic to be isolated
  behind clear contracts — which is where these sit, each behind one handler.
  Choosing resvg over sharp's librsvg path is a security decision, not a
  preference ([research.md §3](./research.md)).
- **This feature modifies an existing table's enum type.** Feature 010's plan
  could claim "no existing table changes"; this one cannot, because FR-024
  requires image attempts in the *same* history. The change is additive to
  the type, touches no row, and is the smaller of the two evils against a
  parallel table ([research.md §9](./research.md)).
- **It edits feature 010's shared code.** The two entities, the two shared
  services, the error-code table, and the exception parameter type widen;
  `ConversionModule` exports two more providers. Every edit is additive —
  no existing call site changes meaning, and no text-format handler, DTO,
  controller, or test is touched.
- **A cross-feature status-code consistency call.** `same_format` stays 400
  and an SVG target stays 415, matching `/api/convert`, with the reasoning
  written down in [research.md §10](./research.md) because the spec's wording
  admits a second reading.

## Project Structure

### Documentation (this feature)

```text
specs/011-image-conversion/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── image-conversion-api.md
│   └── image-rasterisation-rules.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── config/
│       ├── config.types.ts                          # MODIFY: IMAGE_* settings
│       └── config.validation.ts                     # MODIFY: Joi schema + defaults
├── modules/
│   ├── conversion/                                  # EXISTING — additive edits only
│   │   ├── conversion.enums.ts                      # MODIFY: + ImageFormat, RecordedFormat
│   │   ├── conversion.constants.ts                  # MODIFY: + image error codes
│   │   ├── conversion.exception.ts                  # MODIFY: + definitions, + numeric params
│   │   ├── conversion.module.ts                     # MODIFY: export history + retention
│   │   ├── conversion-history.service.ts            # MODIFY: widen to RecordedFormat
│   │   ├── conversion-retention.service.ts          # MODIFY: widen to RecordedFormat
│   │   ├── entities/conversion-record.entity.ts     # MODIFY: enum → RecordedFormat
│   │   ├── entities/conversion-stored-file.entity.ts# MODIFY: enum → RecordedFormat
│   │   └── upload-reader.ts                         # UNCHANGED — reused as-is
│   └── image-conversion/                            # NEW MODULE
│       ├── README.md                                # NEW: rules + "adding a format" (SC-014)
│       ├── image-conversion.module.ts               # NEW
│       ├── image-conversion.controller.ts           # NEW: the two routes
│       ├── image-conversion.controller.spec.ts      # NEW
│       ├── image-conversion.service.ts              # NEW: pipeline, deadline, semaphore
│       ├── image-conversion.service.spec.ts         # NEW
│       ├── image-conversion.constants.ts            # NEW: signatures, extension hints
│       ├── image-format-registry.service.ts         # NEW: capabilities in, directions out
│       ├── image-format-registry.service.spec.ts    # NEW
│       ├── image-format-detector.service.ts         # NEW: magic-byte detection
│       ├── image-format-detector.service.spec.ts    # NEW
│       ├── formats/
│       │   ├── raster-image.ts                      # NEW: canonical model + invariants
│       │   ├── raster-image.spec.ts                 # NEW
│       │   ├── image-format-handler.ts              # NEW: interface + DI tokens
│       │   ├── png.handler.ts                       # NEW: decode + encode
│       │   ├── png.handler.spec.ts                  # NEW
│       │   ├── jpeg.handler.ts                      # NEW: decode + encode
│       │   ├── jpeg.handler.spec.ts                 # NEW
│       │   ├── svg.handler.ts                       # NEW: decode ONLY
│       │   ├── svg.handler.spec.ts                  # NEW
│       │   ├── svg-security.ts                      # NEW: reject-only validator
│       │   ├── svg-security.spec.ts                 # NEW
│       │   ├── svg-intrinsic-size.ts                # NEW: the deterministic size rule
│       │   └── svg-intrinsic-size.spec.ts           # NEW
│       └── dto/
│           ├── convert-image-request.dto.ts         # NEW
│           └── supported-image-formats-response.dto.ts # NEW
├── core/app/app.module.ts                           # MODIFY: import ImageConversionModule
├── main.ts                                          # UNCHANGED (route-level multipart limits)
└── database/
    └── migrations/
        └── 1761300000000-ImageConversion.migration.ts   # NEW: widen conversion_format

test/
├── image-conversion.e2e-spec.ts                     # NEW
├── image-conversion-perf.e2e-spec.ts                # NEW
└── support/
    ├── image-fixtures/                              # NEW: rasters + SVG attack corpus
    └── generate-image-fixtures.ts                   # NEW: builds the raster fixtures
package.json                                         # MODIFY: sharp, @resvg/resvg-js
README.md                                            # MODIFY: link the image rules doc
.env.example                                         # MODIFY: IMAGE_* settings
```

**Structure Decision**: single existing backend project (`src/modules/`,
`src/core/`, `src/database/migrations/`, `test/`). Image conversion gets its
own Nest module rather than joining `ConversionModule`: the text hub is
`read → DocumentNode → write` over UTF-8 text with every pair supported,
while images are bytes with no document model and an allow-list of
directions. Merging them would reintroduce exactly the pairwise branching
both features are designed to avoid (Constitution I). `src/main.ts` is
deliberately untouched — the image route requests its own multipart limits
per call, so the global registration keeps its `PHOTO_MAX_SIZE_BYTES` ceiling
for the photo route.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
