# Implementation Plan: Transformation History

**Branch**: `012-transformation-history` | **Date**: 2026-09-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-transformation-history/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a new `TransformationHistoryModule` exposing
`GET /api/transformations/history` (self) and
`GET /api/transformations/history/:userId` (admin oversight), both behind
the existing `JwtAuthGuard` cookie session, reading the transformation
history that feature 010 (file conversion) and feature 011 (image
conversion) already write into the single shared `conversion_records` table.

The read path is a direct application of the keyset-cursor pagination
already built for `GET /users` (`UserDirectoryService`): an HMAC-signed,
opaque cursor over `(created_at, id)`, fingerprinted to the effective filter
set **and** to whose history is being paginated (self vs. a specific admin
target), so a cursor cannot be replayed across users or filter
combinations. Authorization for the admin route is one new RBAC permission
(`transformation-history:read-any`), granted to the `admin` role by a
migration, checked the same manual way `UsersController` checks `users:list`
— because, like that controller, this one also has a self-service route
that must never require any permission, which a single class-level guard
cannot express.

The one real design gap this feature surfaces: feature 011 deliberately
added no `file`/`image` discriminator column to `conversion_records`,
reasoning that the format value itself says which family a row belongs to
— true only when a format is ever recorded. Both format columns can be
`NULL` simultaneously on an early failure (before detection runs), for
either family, which makes `type` unrecoverable from the format columns
alone for that (real, reachable) subset of rows. This feature adds a
`transformation_type` column, populated by each writer at write time (each
already knows its own family unconditionally, with no dependency on
detection succeeding) rather than derived from format. This is the one
schema change to an existing table; everything else this feature needs
(size, duration, outcome, formats, timestamps) already has a column.

Technical approach and the reasoning behind every choice is in
[research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 / Node.js ≥ 20.9 (NestJS 11)

**Primary Dependencies**: NestJS 11 (Fastify), TypeORM, `@nestjs/throttler`,
`@nestjs/swagger`, `class-validator` / `class-transformer`. **No new runtime
packages** — this feature is a read/query path over infrastructure the
project already has (RBAC, JWT cookie auth, cursor pagination primitives
copied from `UserDirectoryService`, the audit-entity pattern copied from
`UserDirectoryAuditService`).

**Storage**: PostgreSQL via TypeORM. One migration: adds
`conversion_records.transformation_type` (new enum column, backfilled, then
`NOT NULL`) and one new index `idx_conversion_records_user_created
(user_id, created_at DESC)`; seeds the `transformation-history` permission
and its `admin`-role grant; creates the new
`transformation_history_audit_events` table. No table is dropped or
narrowed; every step has a symmetric `down()`.

**Testing**: Jest unit (`*.spec.ts` colocated with each new file), Supertest
e2e (`test/transformation-history.e2e-spec.ts`) against the isolated e2e
database, structured like `test/users-directory.e2e-spec.ts` — fixture
history rows inserted directly via the `ConversionRecord` repository rather
than run through the real conversion endpoints.

**Target Platform**: Linux server (containerized NestJS/Fastify backend)

**Project Type**: Single backend project (existing NestJS repo; no frontend
or mobile counterpart in scope)

**Performance Goals**: first page of a user's own history in under 2 seconds
even at tens of thousands of historical records for that user (SC-001).

**Constraints**: strict access control (self needs no permission; another
user's history needs `transformation-history:read-any`, evaluated fresh on
every request — FR-015); mandatory, opaque, idempotent cursor pagination
(FR-006–FR-009); reject-not-guess on invalid filters/pagination/date ranges
(FR-011, FR-012); an allow-listed response field set with nothing that could
identify another user or reveal file/image content (FR-013, FR-014); an
independent rate limit per route, admin no more permissive than self
(FR-016); a best-effort, non-blocking audit write on every outcome of every
request, with no file/image content and no filter *values* in it (FR-017,
FR-018); `POSTGRES_SYNCHRONIZE` remains `false`.

**Scale/Scope**: one new module, two routes, one new migration touching one
existing table (additive column + index) and one new table, one new RBAC
permission/grant, zero new runtime dependencies.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research and post-design (unchanged — PASS)

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | New `src/modules/transformation-history/`. `TransformationHistoryController` is HTTP-only (guard, DTO binding, permission/existence checks, status mapping); `TransformationHistoryService` owns query-building, the cursor, and the outcome/format translation; `TransformationHistoryAuditService` owns the audit write. Cross-module dependencies are explicit imports: `RbacModule` (`AccessConfigService`), `UsersModule` (`UsersService.findById` for the 404 check), `AuthModule` + a local `TypeOrmModule.forFeature([User, UserRole])` for `JwtAuthGuard` (the same pattern `ConversionModule`/`ImageConversionModule` already use), and a direct `TypeOrmModule.forFeature([ConversionRecord])` for read access to the shared history table — no service-to-service reach-around. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | `JwtAuthGuard` on both routes. `TransformationHistoryQueryDto` validated through the global `ValidationPipe` (`whitelist: true`) exactly like `ListUsersQueryDto`; `:userId` validated with `ParseUUIDPipe`. Admin route authorization checked fresh per request via `AccessConfigService` (no session-cached permission — FR-015). `@Throttle` on both routes, admin ≤ self (FR-016). No new external input surface beyond query parameters and one path parameter — no file/body content is accepted by this feature at all. | PASS |
| III. Database Performance & Integrity | The service selects an explicit column list (no `SELECT *`) mapped to the allow-listed response DTO. One new composite index (`user_id, created_at DESC`) covers every query this feature issues, chosen because it is the one predicate+sort pair every request shares — not because of any lower-cardinality filter, none of which gets its own index (rationale: [research.md §8](./research.md)). The new `transformation_type` column ships with a `NOT NULL` constraint after backfill, and the migration's `down()` reverses column, index, permission/grant rows, and the new table, in that order. `POSTGRES_SYNCHRONIZE` stays `false`. No multi-step write needs `@Transactional()` — this feature performs no write of its own besides the one-time migration and independent, per-request audit inserts. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Unit tests for the query-building/filter-translation logic, the cursor encode/decode/fingerprint (including cross-user and cross-filter cursor rejection), the permission/existence-check ordering, and the audit service's non-throwing behavior. E2E covers all six user stories: self read, admin read (found/not-found), denial without the permission (both existing and non-existing target), unauthenticated, every filter individually and combined, every invalid-input case (FR bounds, bad enum, bad cursor, inverted date range), idempotent repetition, and an audit-row assertion for every reachable outcome including the ones raised before the handler runs (401/400/429, via the route-scoped exception filter — mirroring `UserDirectoryAuditFilter`). | PASS (planned) |
| V. Observability & API Documentation | `@ApiTags('transformation-history')`, `@ApiOperation`, and one `@Api*Response` decorator per documented status code (200/400/401/403/404/429) on each route, matching `UsersController`'s convention. Every request (any outcome) writes one audit row — the feature's own structured "critical event" log, and additionally a natural analogue to the auth/data-mutation logging the constitution asks for, even though this feature performs no mutation. Health endpoint unchanged. Swagger reflects the exact DTO shapes in [contracts/transformation-history-api.md](./contracts/transformation-history-api.md). | PASS |

No violations. Complexity Tracking documents one item worth naming
explicitly even though it is not a violation.

## Project Structure

### Documentation (this feature)

```text
specs/012-transformation-history/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── transformation-history-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── conversion/                                        # EXISTING — additive edits only
│   │   ├── conversion.enums.ts                             # MODIFY: + TransformationType
│   │   ├── conversion-history.service.ts                   # MODIFY: ConversionAttempt.transformationType (required)
│   │   ├── conversion.service.ts                            # MODIFY: pass transformationType: 'file'
│   │   ├── entities/conversion-record.entity.ts             # MODIFY: + transformationType column
│   │   └── conversion.module.ts                             # UNCHANGED (already exports ConversionRecord's module-level access via TypeOrmModule.forFeature elsewhere)
│   ├── image-conversion/
│   │   └── image-conversion.service.ts                      # MODIFY: pass transformationType: 'image'
│   └── transformation-history/                              # NEW MODULE
│       ├── transformation-history.module.ts                 # NEW
│       ├── transformation-history.controller.ts              # NEW: the two routes
│       ├── transformation-history.controller.spec.ts         # NEW
│       ├── transformation-history.service.ts                  # NEW: query building, cursor, translation
│       ├── transformation-history.service.spec.ts            # NEW
│       ├── transformation-history.enums.ts                    # NEW: TransformationHistoryStatus
│       ├── transformation-history-audit.service.ts            # NEW
│       ├── transformation-history-audit.service.spec.ts      # NEW
│       ├── transformation-history-audit.filter.ts             # NEW: 401/400/429 audit capture
│       ├── entities/
│       │   └── transformation-history-audit-event.entity.ts   # NEW
│       └── dto/
│           ├── transformation-history-query.dto.ts            # NEW
│           ├── transformation-history-item.dto.ts             # NEW
│           └── transformation-history-page.dto.ts             # NEW
├── core/app/app.module.ts                                    # MODIFY: import TransformationHistoryModule
└── database/
    └── migrations/
        └── 1761400000000-TransformationHistory.migration.ts   # NEW: column + index + permission/grant + audit table

test/
└── transformation-history.e2e-spec.ts                        # NEW
```

**Structure Decision**: single existing backend project
(`src/modules/`, `src/core/`, `src/database/migrations/`, `test/`).
Transformation history gets its own module rather than living inside
`ConversionModule` or `ImageConversionModule`: it is a read/reporting
concern over data two other modules own, with its own authorization
model (self vs. admin-oversight) and its own audit trail — none of which
belongs conceptually to either conversion pipeline. It depends on
`ConversionModule` only for the `ConversionRecord` entity (read access via
its own `TypeOrmModule.forFeature`, the same way `ImageConversionModule`
already re-registers `ConversionRecord`/`ConversionStoredFile` for its own
context) and touches `ConversionModule`'s and `ImageConversionModule`'s
write paths only to add the one new required field each already has the
information to supply.

## Complexity Tracking

> No Constitution Check violations. One cross-cutting edit is named here for
> visibility, not because it violates a principle.

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| This feature edits feature 010's and feature 011's write paths (`conversion.enums.ts`, `conversion-history.service.ts`, both services' call sites, the entity, one migration) to add `transformation_type`. | FR-010/FR-013 require every record to expose and be filterable by `type`; the format columns alone cannot supply it for rows where detection never completed on either side ([research.md §2](./research.md)). | Deriving `type` from format at query time was rejected — it makes a subset of a user's own real failed attempts silently unfilterable/unclassifiable, contradicting FR-013's unconditional field guarantee. A parallel, separately-maintained history keyed by which endpoint was hit was rejected as exactly the "duplicating or re-logging" FR-020 forbids. |
