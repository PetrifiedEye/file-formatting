---

description: "Task list for Isolated E2E Test Database"
---

# Tasks: Isolated E2E Test Database

**Input**: Design documents from `/specs/007-e2e-test-database/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: No automated test tasks are generated — per plan.md's Constitution Check, this feature's
validation mechanism is the manual quickstart.md walkthrough, not a new Jest suite (the feature
changes bootstrap/config, not application behavior).

**Organization**: Tasks are grouped by user story. This feature is small (config + one script), so
most of the work lands in Phase 2 (Foundational) and Phase 3 (US1), since isolation, config-loading,
and DB-creation are tightly coupled; later phases add the remaining safety checks and docs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Path Conventions

Single NestJS backend project — paths are relative to repo root (`backend/`).

---

## Phase 1: Setup

**Purpose**: Add the new dependency and gitignore entry needed by every later task.

- [X] T001 Add `dotenv` as an explicit devDependency in [package.json](../../package.json) (run `npm install --save-dev dotenv`)
- [X] T002 [P] Add `.env.test` to [.gitignore](../../.gitignore) (next to the existing `.env` entry), keeping `.env.test.local` as-is

**Checkpoint**: Dependency installed, real test env values can never be committed.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the committed template and the test-DB-creation script that both User Story 1
and User Story 2 rely on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Create `.env.test.example` at repo root, copying all keys from [.env.example](../../.env.example) but with `POSTGRES_DB=app_test` and `POSTGRES_MIGRATIONS_RUN=true` pre-filled (per data-model.md's Test Environment Configuration field table)
- [X] T004 Create `scripts/ensure-test-db.ts`: load `.env.test` via `dotenv.config({ path: '.env.test' })` (throw a clear error naming `.env.test.example` if the file is missing and no `POSTGRES_DB` is already in `process.env`), then connect with the `pg` client to the server's default `postgres` maintenance database using `POSTGRES_HOST`/`POSTGRES_PORT`/`POSTGRES_USER`/`POSTGRES_PASSWORD` from `process.env`, run `SELECT 1 FROM pg_database WHERE datname = $1` for `POSTGRES_DB`, and issue `CREATE DATABASE "<name>"` only if absent; catch connection failures and re-throw with an actionable message (e.g. "Postgres unreachable at host:port — is `docker-compose up -d postgres` running?")
- [X] T005 Add a `"pretest:e2e"` script to [package.json](../../package.json) that runs `scripts/ensure-test-db.ts` via `ts-node` (e.g. `"pretest:e2e": "ts-node -r tsconfig-paths/register scripts/ensure-test-db.ts"`), so npm invokes it automatically before `test:e2e`

**Checkpoint**: Template exists, test database can be created on demand — user story work can now begin.

---

## Phase 3: User Story 1 - Run e2e suite without losing dev data (Priority: P1) 🎯 MVP

**Goal**: E2E test runs never touch the dev database — they connect to and mutate only a separate
test database, which is auto-created on first run.

**Independent Test**: Seed the dev database with a distinct user via the running dev server, run
`npm run test:e2e`, then verify (via Adminer or a direct query) that the seeded dev user is still
present and unmodified afterward.

### Implementation for User Story 1

- [X] T006 [US1] Modify [test/setup-e2e.ts](../../test/setup-e2e.ts) to replace the bare `import 'dotenv/config'` with an explicit `fs.existsSync('.env.test')` check that throws a clear `Error` pointing at `.env.test.example` when missing, then calls `dotenv.config({ path: '.env.test' })`
- [X] T007 [US1] Verify end-to-end per quickstart.md Story 1: start `npm run start:dev`, seed/note a dev DB row count, run `npm run test:e2e`, and confirm the dev DB row count is unchanged afterward (Acceptance Scenarios 1 & 2)
- [X] T008 [US1] Verify first-time test DB creation per quickstart.md Story 1: `DROP DATABASE IF EXISTS app_test` then run `npm run test:e2e` and confirm `pretest:e2e` creates it automatically and tests pass (Acceptance Scenario 3)

**Checkpoint**: User Story 1 is fully functional — e2e runs are isolated from dev data and the test DB self-creates on first use.

---

## Phase 4: User Story 2 - Predictable, isolated environment configuration per run (Priority: P2)

**Goal**: Dev server and e2e suite each load their own environment configuration automatically,
with no manual `.env` edits between runs, and the suite fails fast (rather than silently reusing
dev config) on misconfiguration.

**Independent Test**: Run the e2e suite immediately after starting the dev server (without
touching `.env`), and confirm both processes report connecting to their respective, different
databases in their startup logs.

### Implementation for User Story 2

- [X] T009 [US2] Extend [test/setup-e2e.ts](../../test/setup-e2e.ts) to also read the dev `.env` file's `POSTGRES_DB` via `dotenv.parse(fs.readFileSync('.env'))` (without mutating `process.env`) and compare it against the loaded test `POSTGRES_DB`; throw a clear error if they match, so the suite never silently runs against the dev database (Edge Case in spec.md)
- [X] T010 [US2] Apply the same `.env.test`-missing fail-fast check from T006 to `scripts/ensure-test-db.ts` (`fs.existsSync('.env.test')` before `dotenv.config()`), so both entry points fail identically instead of only one (FR-007)
- [X] T011 [US2] Verify per quickstart.md Story 2: run `npm run start:dev` and `npm run test:e2e` concurrently without editing `.env`, confirm each logs its own `POSTGRES_DB`; then rename `.env.test` away and confirm `npm run test:e2e` fails fast with a clear error before any DB connection attempt (Acceptance Scenarios 1 & 2)
- [X] T012 [US2] Verify the dev/test DB name collision edge case per quickstart.md: temporarily set `.env.test`'s `POSTGRES_DB` to match dev's and confirm `npm run test:e2e` fails loudly rather than running

**Checkpoint**: User Stories 1 AND 2 both work independently — isolation is automatic and misconfiguration fails loudly.

---

## Phase 5: User Story 3 - Clean, repeatable test runs (Priority: P3)

**Goal**: Repeated e2e runs against an existing test database always have current schema, so
failures reflect real regressions rather than stale/missing schema.

**Independent Test**: Run the e2e suite twice in immediate succession and confirm both runs
produce the same pass/fail outcome for an unchanged codebase.

### Implementation for User Story 3

- [X] T013 [US3] Confirm `.env.test.example` (from T003) sets `POSTGRES_MIGRATIONS_RUN=true` so the existing `migrationsRun` option in [src/core/database/database.module.ts](../../src/core/database/database.module.ts) runs migrations on every e2e app boot — no code change expected here, this task is a verification/adjustment pass if the wiring doesn't already pick up the env var for `NODE_ENV=test`
- [X] T014 [US3] Verify per quickstart.md Story 3: run `npm run test:e2e` twice in immediate succession (first run creates `app_test` + runs migrations, second run reuses it) and confirm identical pass/fail results with no leftover-state failures (Acceptance Scenarios 1 & 2, SC-003)

**Checkpoint**: All user stories independently functional — isolation, automatic config, and repeatable schema state.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation required by FR-005, plus final full-suite validation.

- [X] T015 [P] Document test database setup in [README.md](../../README.md) (or equivalent existing setup docs): copying `.env.test.example` to `.env.test`, that no manual `createdb` step is needed, and how CI overrides values via real environment variables (FR-005, FR-008)
- [X] T016 Run the full quickstart.md validation end-to-end (`npm run verify` then `npm run test:e2e` twice) to confirm SC-001 through SC-004 all hold

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup (needs `dotenv` installed) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — delivers the MVP (isolation + auto-create)
- **User Story 2 (Phase 4)**: Depends on Foundational; extends the same `setup-e2e.ts` file touched in US1 (T006), so in practice do it after US1's T006 lands to avoid edit conflicts
- **User Story 3 (Phase 5)**: Depends on Foundational; independent of US1/US2 file changes (touches `database.module.ts`/config only), but is only meaningfully verifiable once US1's auto-create (T004/T008) works
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### Within Each User Story

- T006 (US1) must land before T009/T010 (US2), since both touch `test/setup-e2e.ts`
- Verification tasks (T007, T008, T011, T012, T014, T016) depend on their preceding implementation tasks in the same phase

### Parallel Opportunities

- T001 and T002 (Setup) can run in parallel — different files
- T003 (Foundational) can run in parallel with T001/T002 — different file, no shared dependency
- T004 depends on T001 (needs `dotenv` installed) and T003 (needs the example values to model)
- T015 (Polish docs) can run in parallel with T016 (verification) — different concerns

---

## Parallel Example: Setup + Foundational

```bash
# Launch independent Setup/Foundational tasks together:
Task: "Add dotenv as devDependency in package.json"
Task: "Add .env.test to .gitignore"
Task: "Create .env.test.example at repo root"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (`dotenv` installed, gitignore updated)
2. Complete Phase 2: Foundational (`.env.test.example` + `scripts/ensure-test-db.ts` + `pretest:e2e`)
3. Complete Phase 3: User Story 1 (`setup-e2e.ts` loads `.env.test`, verified against quickstart.md)
4. **STOP and VALIDATE**: Dev data survives an e2e run; test DB auto-creates on first run
5. This alone resolves the core problem statement in spec.md

### Incremental Delivery

1. Setup + Foundational → test DB can be created and templated
2. User Story 1 → dev data is safe, isolation works (MVP)
3. User Story 2 → config loading is automatic and fails fast on misconfiguration
4. User Story 3 → repeated runs are schema-consistent
5. Polish → documented for new contributors (FR-005), full suite re-verified

---

## Notes

- This feature has no `contracts/` directory and no new entities — Phase 2/3 carry more weight
  than a typical Foundational/US1 split because DB creation (research.md decision #3) and config
  loading (research.md decision #2) are tightly coupled.
- No test tasks were generated per the "Tests" note above; verification tasks instead reference the
  manual quickstart.md scenarios directly.
- Commit after each task or logical group.
- Avoid: committing `.env.test` itself, editing individual `*.e2e-spec.ts` files (out of scope per
  plan.md), reusing `docker-entrypoint-initdb.d` as the DB-creation mechanism (rejected in research.md).
