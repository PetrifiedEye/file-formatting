# Implementation Plan: File Format Conversion

**Branch**: `010-file-format-conversion` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-file-format-conversion/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a new `ConversionModule` exposing `POST /api/convert` (multipart:
`file`, `targetFormat`, optional `store`) and `GET /api/convert/formats`,
both behind the existing `JwtAuthGuard` cookie session.

The architectural core is a **hub model**: every format is one
`FormatHandler` that reads its wire form into a canonical JSON-shaped
`DocumentNode` and writes that model back out. Conversion is always
`read → model → write`, so four handlers produce all twelve directions, and
the discovery endpoint derives its list from the handler registry rather
than from a constant. Adding a fifth format is one new file plus one
provider entry, with no edit to any existing handler, DTO, or controller —
which is what makes FR-029, FR-030, and SC-009 true rather than aspirational.

Safety is enforced at the boundary, in a fixed order: per-source-format byte
budgets applied while the upload streams (so an oversized file is never read
whole), UTF-8 and BOM handling, content-based format detection, outright
refusal of any XML `<!DOCTYPE`, shared depth/node-count guards on the model,
and a conversion deadline. The result is serialized **completely into a
buffer before any response header is written**, so a caller receives either
a valid file or an error — never a truncated one.

Every authenticated attempt writes a `conversion_records` row from a
`finally` block, carrying process metadata only; the schema has no column
capable of holding file content, and library parser messages (which quote
input) are mapped to fixed error codes before they reach history or the
response. Opting into retention writes the result under a new
`CONVERSION_STORAGE_DIR` — deliberately **not** `ASSETS_DIR`, which
`@fastify/static` serves unauthenticated.

Technical approach and the reasoning behind each choice are in
[research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 / Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (Fastify), `@fastify/multipart`,
TypeORM, `@nestjs/throttler`, `@nestjs/swagger`, `class-validator` /
`class-transformer`. **New runtime packages**: `csv-parse`, `csv-stringify`,
`fast-xml-parser`, `yaml` (v2), `@types/` as needed. JSON uses the native
parser. `js-yaml` is present transitively and is deliberately not used —
it is YAML 1.1 and has no alias-expansion cap
([research.md §3](./research.md)).

**Storage**: PostgreSQL via TypeORM — two new tables (`conversion_records`,
`conversion_stored_files`) plus four new enum types; no existing table
changes. Retained result files on the local filesystem under a new
`CONVERSION_STORAGE_DIR`, outside the statically served `ASSETS_DIR`.

**Testing**: Jest unit (`*.spec.ts` colocated), Supertest e2e
(`test/file-conversion.e2e-spec.ts`) against the isolated e2e database, with
fixtures in `test/support/conversion-fixtures/`.

**Target Platform**: Linux server (containerized NestJS/Fastify backend)

**Project Type**: Single backend project (existing NestJS repo; no frontend
or mobile counterpart in scope)

**Performance Goals**: ≤1 MiB converted in under 5 seconds at typical load
(SC-002); a conversion abandoned within its budget plus at most 5 seconds
(SC-003); ten concurrent 1 MiB conversions without delaying an unrelated
request by more than 1 second (SC-008).

**Constraints**: Administrator-configured maximum input size **per source
format**, applied to the detected format and enforced while streaming;
structural depth and node-count caps; conversion time budget; no XML
external entities and no DTD processing; valid UTF-8 only, BOM consumed,
UTF-8 out; complete-or-error responses (no partial file); no file content in
any log line or database column; rate limit on the conversion route;
`POSTGRES_SYNCHRONIZE` remains `false`.

**Scale/Scope**: One new module; two endpoints; four format handlers plus a
registry, detector, history service, and storage service; two tables and one
migration; ten new environment settings.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research and post-design (unchanged — PASS)

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | New `src/modules/conversion/` module. `ConversionController` is HTTP-only (parts, DTO validation, status mapping, headers); `ConversionService` orchestrates; `FormatRegistryService`, `FormatDetectorService`, `ConversionHistoryService` hold the rest. Format handlers are providers behind one interface. Storage infrastructure (`ConversionFileStorageService`) goes to `src/core/storage/` alongside `LocalFileStorageService`. Dependencies are explicit module imports (`AuthModule` for the guard, `StorageModule`, `ConfigModule`); no circular imports, no cross-module service reach-around. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | `JwtAuthGuard` before any file is read. Multipart fields validated through `ConvertRequestDto` + `class-validator` (the global `ValidationPipe` cannot see multipart, so validation is invoked explicitly — [research.md §12](./research.md)). Per-format size budgets, depth/node caps, output ceiling, and a time budget. XML `<!DOCTYPE` refused outright and no network client exists in the module. YAML restricted to the 1.2 core schema with a capped alias count. `@Throttle` on `POST /api/convert`. CORS and the existing global multipart registration unchanged. | PASS |
| III. Database Performance & Integrity | Two new tables, both written with an explicit column list; no unbounded entity loads (this feature only inserts). Indexes on `(user_id, started_at DESC)` and `(outcome, started_at DESC)` for history reads, and `(user_id, created_at DESC)` on stored files, with rationale in [data-model.md](./data-model.md). `CHECK` constraints encode the success/failure and retention invariants. The success path writes the stored-file row and the history row together under `@Transactional()`; the failure path writes history alone, outside any transaction, so a rollback cannot erase the record of the attempt (FR-024). Versioned migration; synchronize stays off. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Unit tests per handler against the documented mapping rules (SC-011), plus the structure guard, detector ordering, registry-derived directions, budgeted stream consumer, and history writing for every error category. E2E covers all twelve directions, round-trip equivalence, 400/401/413/415/429, the DOCTYPE refusal, retention on/off/failed, and the automated discovery-matches-reality check (SC-010). | PASS (planned) |
| V. Observability & API Documentation | `@ApiTags('conversion')`, `@ApiConsumes('multipart/form-data')`, an `@ApiBody` schema, and response decorators for every documented status. Each attempt logs user, formats, input size, outcome with error code, and duration — and never file content. Health endpoint unchanged. | PASS |

No violations. Complexity Tracking is intentionally empty.

Two items are worth naming explicitly even though neither is an exception:

- **Four new runtime dependencies.** The constitution's stack table does not
  enumerate parsing libraries, and it requires conversion logic to be
  isolated behind clear contracts — which is where these sit, each behind
  one handler. The YAML choice is a correctness decision, not a preference
  ([research.md §3](./research.md)).
- **A new storage root.** `CONVERSION_STORAGE_DIR` exists because
  `ASSETS_DIR` is served without authentication by `@fastify/static`; using
  the existing assets root would violate FR-027
  ([research.md §8](./research.md)).

## Project Structure

### Documentation (this feature)

```text
specs/010-file-format-conversion/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── conversion-api.md
│   └── conversion-mapping-rules.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── config/
│   │   ├── config.types.ts                       # MODIFY: CONVERSION_* settings
│   │   └── config.validation.ts                  # MODIFY: Joi schema + defaults
│   └── storage/
│       ├── conversion-file-storage.service.ts    # NEW: writes under CONVERSION_STORAGE_DIR
│       ├── conversion-file-storage.service.spec.ts  # NEW
│       └── storage.module.ts                     # MODIFY: provide + export it
├── modules/
│   └── conversion/                               # NEW MODULE
│       ├── README.md                             # NEW: mapping rules (FR-009)
│       ├── conversion.module.ts                  # NEW
│       ├── conversion.controller.ts              # NEW: POST /api/convert, GET /api/convert/formats
│       ├── conversion.controller.spec.ts         # NEW
│       ├── conversion.service.ts                 # NEW: pipeline, deadline, atomicity
│       ├── conversion.service.spec.ts            # NEW
│       ├── conversion.constants.ts               # NEW: error codes, prefix size
│       ├── conversion-history.service.ts         # NEW
│       ├── conversion-history.service.spec.ts    # NEW
│       ├── conversion-retention.service.ts       # NEW: optional result retention
│       ├── conversion-retention.service.spec.ts  # NEW
│       ├── format-registry.service.ts            # NEW: handlers in, directions out
│       ├── format-registry.service.spec.ts       # NEW
│       ├── format-detector.service.ts            # NEW: content-first detection
│       ├── format-detector.service.spec.ts       # NEW
│       ├── upload-reader.ts                      # NEW: budgeted multipart stream consumer
│       ├── upload-reader.spec.ts                 # NEW
│       ├── formats/
│       │   ├── document-node.ts                  # NEW: canonical model + structure guard
│       │   ├── document-node.spec.ts             # NEW
│       │   ├── format-handler.ts                 # NEW: interface + FORMAT_HANDLERS token
│       │   ├── flatten.ts                        # NEW: path flatten/expand for CSV
│       │   ├── flatten.spec.ts                   # NEW
│       │   ├── csv.handler.ts                    # NEW
│       │   ├── csv.handler.spec.ts               # NEW
│       │   ├── json.handler.ts                   # NEW
│       │   ├── json.handler.spec.ts              # NEW
│       │   ├── xml.handler.ts                    # NEW
│       │   ├── xml.handler.spec.ts               # NEW
│       │   ├── yaml.handler.ts                   # NEW
│       │   └── yaml.handler.spec.ts              # NEW
│       ├── dto/
│       │   ├── convert-request.dto.ts            # NEW
│       │   ├── supported-formats-response.dto.ts # NEW
│       │   └── conversion-error-response.dto.ts  # NEW
│       └── entities/
│           ├── conversion-record.entity.ts       # NEW
│           └── conversion-stored-file.entity.ts  # NEW
├── core/app/app.module.ts                        # MODIFY: import ConversionModule
├── main.ts                                       # UNCHANGED (route-level multipart limits)
└── database/
    └── migrations/
        └── 1761200000000-FileFormatConversion.migration.ts   # NEW

test/
├── file-conversion.e2e-spec.ts                   # NEW
└── support/conversion-fixtures/                  # NEW: BOM, Unicode, ragged CSV,
                                                  #      header-only CSV, deep nesting,
                                                  #      DOCTYPE XML, alias bomb
README.md                                         # MODIFY: link the mapping-rules doc
.env.example                                      # MODIFY: CONVERSION_* settings
```

**Structure Decision**: Single existing backend project (`src/modules/`,
`src/core/`, `src/database/migrations/`, `test/`). Conversion gets its own
Nest module rather than joining an existing one — it owns two entities, its
own storage root, and a provider set unrelated to users or auth
(Constitution I). `src/main.ts` is deliberately untouched: the conversion
route requests its own multipart limits per call, so the global registration
that serves the photo route keeps its `PHOTO_MAX_SIZE_BYTES` ceiling
([research.md §4](./research.md)).

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
