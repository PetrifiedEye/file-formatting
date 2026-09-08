# Implementation Plan: Isolated E2E Test Database

**Branch**: `007-e2e-test-database` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-e2e-test-database/spec.md`

## Summary

E2E tests currently run against the same Postgres database as local dev (`POSTGRES_DB` from
`.env`), so every `npm run test:e2e` run destroys seeded dev data. The fix is configuration-only:
introduce a dedicated `.env.test` (gitignored, templated by a committed `.env.test.example`) that
points at a separate database name (e.g. `app_test`) on the same Postgres server, make
`test/setup-e2e.ts` load it explicitly (failing fast if missing or if it resolves to the same
database as dev), add a `pretest:e2e` script that creates the test database if it doesn't exist
yet, and rely on the existing `POSTGRES_MIGRATIONS_RUN` migration-on-boot mechanism (already wired
in `DatabaseModule`) to bring the test database schema up to date on every run. No application
code, entities, or business logic changes.

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js (NestJS 11)

**Primary Dependencies**: `@nestjs/config`, `dotenv` (add as explicit dependency; currently only
a transitive one), `typeorm`, `pg`, `ts-node` (already present, used to run the DB-bootstrap script)

**Storage**: PostgreSQL — same server/container as dev, separate database name (`app_test` by
default) selected via `.env.test`

**Testing**: Jest + Supertest, run via `npm run test:e2e` (`test/jest-e2e.json`,
`test/setup-e2e.ts`)

**Target Platform**: Linux/macOS dev machines and CI (Node.js server), local Postgres via
`docker-compose.yml`

**Project Type**: Web service (single NestJS backend) — this feature only touches test bootstrap
and config, not the API surface

**Performance Goals**: N/A (test infrastructure change, no runtime/production code path affected)

**Constraints**: Must not require a second Postgres server/container; must not commit secrets;
must fail loudly rather than silently reuse dev config; must not change individual test files
beyond what's needed to pick up new config

**Scale/Scope**: Single repo, ~10 existing `*.e2e-spec.ts` files, one new bootstrap script, one new
env template file, doc updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Modular Architecture** — N/A to this feature; no new modules/controllers/services are
  added. The one new script (`scripts/ensure-test-db.ts`) is infra tooling, not a NestJS module,
  consistent with how `src/database/data-source.ts` already exists outside the module tree for
  CLI purposes. **PASS**.
- **II. Input Validation & Security (NON-NEGOTIABLE)** — Boot-time config continues to be
  validated via the existing Joi schema (`configValidationSchema`); no new external HTTP input is
  introduced. `.env.test` (real values) stays gitignored like `.env`; only `.env.test.example` is
  committed. **PASS**.
- **III. Database Performance & Integrity** — No schema/entity changes. Test database schema is
  brought up to date via the existing migration mechanism (`POSTGRES_MIGRATIONS_RUN` +
  `migrationsRun` in `DatabaseModule`), not a new schema-management approach, per the spec's
  assumptions. **PASS**.
- **IV. Test Coverage (NON-NEGOTIABLE)** — This feature is test infrastructure itself; the
  "test" for it is the isolation behavior described in the spec's Independent Test sections
  (verified manually/via quickstart, not a new Jest suite, since it's about how the suite runs,
  not application behavior). No regression risk to existing unit/e2e tests since their assertions
  are unchanged, only the target database. **PASS** (documented in quickstart.md as the
  validation mechanism).
- **V. Observability & API Documentation** — No new endpoints or API contracts. README will be
  updated per FR-005 so setup is documented. **PASS**.

No violations requiring Complexity Tracking justification.

## Project Structure

### Documentation (this feature)

```text
specs/007-e2e-test-database/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

No `contracts/` directory: this feature introduces no HTTP endpoints, CLI commands consumed by
other systems, or other externally-facing interface — it only changes local test bootstrap and
environment configuration. The "contract" that exists (the shape of `.env.test`) is documented in
`data-model.md` and `quickstart.md` instead.

### Source Code (repository root)

```text
backend/                          # this repo (already a single NestJS project, no separate frontend)
├── .env.example                  # existing dev template (unchanged)
├── .env.test.example             # NEW: committed template for the test env file
├── .env.test                     # NEW, gitignored: developer's actual test env values
├── docker-compose.yml            # unchanged: one Postgres container, two DB names on it
├── scripts/
│   └── ensure-test-db.ts         # NEW: creates the test database if missing, used by pretest:e2e
├── src/
│   ├── core/config/               # existing ConfigModule/ConfigService/Joi schema (unchanged)
│   ├── core/database/database.module.ts  # existing TypeORM wiring (unchanged, already supports
│   │                                        migrationsRun + arbitrary POSTGRES_DB)
│   └── database/data-source.ts    # existing CLI data source (unchanged)
├── test/
│   ├── jest-e2e.json               # unchanged (still points at setup-e2e.ts)
│   ├── setup-e2e.ts                # MODIFIED: load .env.test explicitly, validate it, safety-check
│   │                                  it differs from dev's POSTGRES_DB
│   └── *.e2e-spec.ts               # unchanged
└── package.json                    # MODIFIED: add "pretest:e2e" script
```

**Structure Decision**: Single NestJS backend project (existing layout under `src/`, `test/`).
This feature adds only: one gitignored env file + its committed example template, one small
standalone bootstrap script under a new `scripts/` directory (mirroring the existing pattern of
`src/database/data-source.ts` living outside the Nest module tree for tooling purposes), and an
edit to `test/setup-e2e.ts`. No new `src/modules/*` or `src/core/*` code.

## Complexity Tracking

*No constitution violations — section not applicable.*
