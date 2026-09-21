# Implementation Plan: Transformation Result Storage & Download

**Branch**: `013-transformation-result-storage` | **Date**: 2026-09-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-transformation-result-storage/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Complete the existing opt-in `store` capability by adding immutable retention
deadlines, administrator-managed retention policy, authorized streamed
downloads for owners and oversight administrators, recurring expiry cleanup,
and save/download auditing shared by document and image transformations.

The implementation keeps both existing conversion contracts and private local
storage. A new `TransformationResultStorageModule` owns lifecycle, download,
and audit behavior across both conversion families. It reads the existing
`conversion_records`/`conversion_stored_files` model, adds one frozen
`expires_at` value to every history row, and deletes expired history records
with their files. Downloads use owner-scoped queries and pre-opened file
descriptors; a new `transformation-history:download-any` action gates the exact
admin route specified by the feature.

## Technical Context

**Language/Version**: TypeScript 5.7 / Node.js >= 20.9 (NestJS 11)

**Primary Dependencies**: NestJS 11 on Fastify, TypeORM 0.3/PostgreSQL,
`typeorm-transactional`, `class-validator`, `@nestjs/swagger`,
`@nestjs/throttler`, Node `fs` streams. No new runtime package: recurring work
uses the repository's established lifecycle-managed `setInterval` pattern.

**Storage**: PostgreSQL metadata plus private local files under the existing
`CONVERSION_STORAGE_DIR`. One migration adds
`conversion_records.expires_at`, retention policy on `system_settings`, a
result-audit table/indexes, and the new RBAC action/grant.

**Testing**: Jest colocated unit tests and Supertest e2e against the isolated
PostgreSQL test database; filesystem tests use temporary private directories.

**Target Platform**: Linux server/container running NestJS/Fastify with a
POSIX-like local filesystem.

**Project Type**: Single backend web service.

**Performance Goals**: Typical saved-result download completes in under 3
seconds; server memory use is independent of saved file size during download;
expiry scan uses an indexed deadline and bounded batches; successful
`store=true` adds no perceptible latency under normal local-storage operation.

**Constraints**: Conversion status/body/content headers remain unchanged by
save success/failure; existing `store` name and retention outcome headers stay
compatible; save/audit failures never fail conversion; downloads never buffer
the full file; self/admin IDOR protection and uniform unavailable 404; admin
permission checked before target lookup; expiry enforced before cleanup;
cleanup continues after per-item failures; no file bytes in DB/logs/audits;
storage remains outside static assets; `POSTGRES_SYNCHRONIZE=false`.

**Scale/Scope**: Two conversion endpoints extended through their shared
retention service, two new download routes, two admin settings routes, one new
feature module, one migration, one recurring cleanup process, and unit/e2e
coverage across document and image results. Results remain bounded by existing
20 MiB default pipeline output limits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research and post-design (unchanged — PASS)

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | New `TransformationResultStorageModule` owns download, lifecycle, policy adapter, and result audit services/controllers. Conversion orchestration remains in existing services; controllers only map HTTP/auth/headers. Module imports/exports are explicit and acyclic. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | `store` keeps explicit multipart validation. Settings DTO validates integer range. UUID pipes validate route ids. JWT protects both downloads; self owner comes from the session; admin checks `download-any` before lookup. Queries include expected owner, files stay outside static assets, and every route is throttled/documented. | PASS |
| III. Database Performance & Integrity | Versioned reversible migration; indexed `expires_at`; explicit selected columns; one-to-one/cascade constraints reused. Stored-file attach remains transactional. Cross-filesystem/database cleanup uses idempotent ordered operations and retry because PostgreSQL cannot transact a local unlink. Synchronize remains false. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Unit tests cover services/controllers/storage/audit/cleanup/settings; e2e covers both save families, both download paths, RBAC/IDOR, expiry/cleanup, drift/errors, repeat/concurrent reads, and audit. `npm run verify` and `npm run test:e2e` are required implementation gates. | PASS (planned) |
| V. Observability & API Documentation | Save/download attempts write structured audit rows with ids, outcome, byte count, and duration but no content/path. Cleanup logs per-cycle counts and safe identifiers. Swagger describes binary success and all error statuses; health remains unchanged. | PASS |

No constitution violations. The unavoidable cross-resource cleanup consistency
limit is explicitly handled with expiry gating, idempotency, compensation, and
retry; it does not require a constitution exception.

## Project Structure

### Documentation (this feature)

```text
specs/013-transformation-result-storage/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── transformation-result-download-api.md
│   └── transformation-retention-settings-api.md
└── tasks.md             # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── app/app.module.ts                              # MODIFY: import new module
│   ├── config/
│   │   ├── config.types.ts                            # MODIFY: cleanup interval
│   │   └── config.validation.ts                       # MODIFY: validate/default interval
│   └── storage/
│       ├── conversion-file-storage.service.ts         # MODIFY: contained pre-open/read + strict remove
│       └── conversion-file-storage.service.spec.ts    # MODIFY
├── modules/
│   ├── conversion/
│   │   ├── conversion.module.ts                       # MODIFY: import result-storage module
│   │   ├── conversion.service.ts                      # MODIFY: shared save finalization
│   │   ├── conversion.service.spec.ts                 # MODIFY
│   │   ├── conversion-history.service.ts              # MODIFY: frozen expiresAt
│   │   ├── conversion-history.service.spec.ts         # MODIFY
│   │   ├── conversion-retention.service.ts            # MODIFY: size gate, attach, compensation, audit
│   │   ├── conversion-retention.service.spec.ts       # MODIFY
│   │   └── entities/conversion-record.entity.ts       # MODIFY: expiresAt
│   ├── image-conversion/
│   │   ├── image-conversion.service.ts                # MODIFY: shared save finalization
│   │   └── image-conversion.service.spec.ts           # MODIFY
│   ├── settings/
│   │   ├── dto/transformation-retention-policy.dto.ts # NEW
│   │   ├── entities/system-settings.entity.ts         # MODIFY: retention days
│   │   ├── entities/settings-audit-event.entity.ts    # MODIFY: event type
│   │   ├── settings.controller.ts                     # MODIFY: GET/PATCH policy
│   │   ├── settings.service.ts                        # MODIFY: read/update policy
│   │   └── *.spec.ts                                  # MODIFY
│   └── transformation-result-storage/
│       ├── transformation-result-storage.module.ts    # NEW
│       ├── self-result-download.controller.ts         # NEW
│       ├── admin-result-download.controller.ts        # NEW
│       ├── transformation-result-download.service.ts  # NEW
│       ├── transformation-result-cleanup.service.ts   # NEW
│       ├── transformation-retention-policy.service.ts # NEW
│       ├── transformation-result-audit.service.ts     # NEW
│       ├── transformation-result-audit.filter.ts      # NEW
│       ├── transformation-result.enums.ts              # NEW
│       ├── entities/
│       │   └── transformation-result-audit-event.entity.ts
│       └── *.spec.ts                                  # NEW unit tests
└── database/migrations/
    └── 1761500000000-TransformationResultStorage.migration.ts

test/
├── file-conversion.e2e-spec.ts                        # MODIFY: expiry/save audit
├── image-conversion.e2e-spec.ts                       # MODIFY: expiry/save audit
├── admin-settings.e2e-spec.ts                         # MODIFY: retention policy
└── transformation-result-storage.e2e-spec.ts          # NEW: download/cleanup/audit

.env.example                                            # MODIFY: cleanup interval
README.md                                               # MODIFY: policy, routes, cleanup
```

**Structure Decision**: Use the existing single NestJS backend layout. The new
cross-family module owns result access/lifecycle and is imported by
`ConversionModule` only for shared policy/audit collaborators. It accesses the
shared entities through its own `TypeOrmModule.forFeature` registration, not
through service-to-service reach-around. Existing
`TransformationHistoryModule` remains focused on paginated metadata reads.

## Complexity Tracking

No violations require justification.

## Implementation Sequence

1. Create the migration/entity/settings policy and frozen `expires_at` write
   path first; backfill existing rows and seed `download-any`.
2. Consolidate both conversion families onto shared retention finalization:
   history row first, size/storage/attach compensation second, exactly one save
   audit, final existing retention header last.
3. Add secure pre-open/read/remove storage primitives.
4. Implement owner-scoped download service and self/admin controllers with
   stream-completion audit finalization.
5. Implement indexed recurring cleanup with per-item retry/isolation.
6. Complete unit tests, e2e tests, Swagger, environment/README updates, then
   run `npm run verify` and `npm run test:e2e`.

## Post-Design Constitution Re-check

Phase 1 introduces no new dependency, no unvalidated input, no public/static
file path, no unindexed cleanup query, no unversioned schema mutation, and no
controller-owned business logic. The contracts and data model preserve every
pre-research PASS above.

