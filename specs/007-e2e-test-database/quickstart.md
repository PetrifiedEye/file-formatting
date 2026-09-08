# Quickstart: Validating Isolated E2E Test Database

This walks through setting up the feature locally and validating each user story's acceptance
scenarios from [spec.md](./spec.md).

## Prerequisites

- Local Postgres running via `docker-compose up -d postgres` (or an already-running dev stack).
- A dev `.env` already in place (per `.env.example`), pointing at `POSTGRES_DB=app`.
- Dependencies installed (`npm install`), including the new `dotenv` devDependency added by this
  feature.

## One-time setup

1. Copy the new test env template and edit only what differs from dev (at minimum, the database
   name):
   ```bash
   cp .env.test.example .env.test
   ```
   `.env.test.example` ships with `POSTGRES_DB=app_test` and `POSTGRES_MIGRATIONS_RUN=true`
   pre-filled; other values (`POSTGRES_HOST`, credentials, secrets, SMTP, etc.) can be copied from
   your existing `.env` if you're reusing the same local Postgres/Mailpit containers.
2. That's it — no manual `createdb` step is required; `scripts/ensure-test-db.ts` runs
   automatically before the suite (see Story 1, Scenario 3 below).

## Story 1 — Run e2e suite without losing dev data (P1)

**Validate SC-001 / Acceptance Scenario 1 & 2**:

```bash
# 1. Start the dev server against the dev DB and seed some data through it
#    (e.g. register a user via the running API, or use an existing seeded account).
npm run start:dev

# 2. In another shell, snapshot the dev DB
psql "$DEV_CONN_STRING" -c "SELECT count(*) FROM users;" # note the count

# 3. Run the e2e suite (uses .env.test, not .env)
npm run test:e2e

# 4. Re-check the dev DB — count must be unchanged
psql "$DEV_CONN_STRING" -c "SELECT count(*) FROM users;"
```
Expected: the count from step 2 and step 4 match exactly, and (optionally) inspecting via Adminer
shows the same seeded rows untouched.

**Validate Acceptance Scenario 3 (first-time test DB creation)**:

```bash
# Drop the test DB if it happens to already exist, to simulate a first-time run
psql "$DEV_CONN_STRING" -U postgres -c "DROP DATABASE IF EXISTS app_test;"
npm run test:e2e
```
Expected: `pretest:e2e` (via `scripts/ensure-test-db.ts`) creates `app_test` automatically before
Jest starts, migrations run on app boot, and tests pass with no manual intervention. If Postgres
itself is unreachable, the script fails with a clear, actionable error instead of Jest failing
with an opaque connection error.

## Story 2 — Predictable, isolated environment configuration per run (P2)

**Validate Acceptance Scenario 1**:

```bash
npm run start:dev &     # dev server logs it connected to POSTGRES_DB=app
npm run test:e2e        # e2e run logs (via app bootstrap) it connected to POSTGRES_DB=app_test
```
Expected: both processes run concurrently without editing `.env` in between, each connecting to
its own database.

**Validate Acceptance Scenario 2 (fail fast on missing config)**:

```bash
mv .env.test .env.test.bak
npm run test:e2e
mv .env.test.bak .env.test   # restore
```
Expected: the run fails immediately in `setup-e2e.ts` with a clear error naming `.env.test` and
pointing at `.env.test.example`, before any database connection is attempted.

**Validate the dev/test DB name collision edge case**:

```bash
# Temporarily set .env.test's POSTGRES_DB to match dev's (e.g. both "app")
npm run test:e2e
```
Expected: the run fails fast with an explicit error refusing to proceed, rather than running
tests against the dev database.

## Story 3 — Clean, repeatable test runs (P3)

**Validate Acceptance Scenario 1 & 2, and SC-003**:

```bash
npm run test:e2e   # first run: creates app_test (if absent) + runs migrations + runs tests
npm run test:e2e   # second run, immediately after: same pass/fail outcome
```
Expected: identical results across both runs; no test fails only on the second run due to leftover
data (existing e2e specs are already responsible for their own row-level cleanup/uniqueness —
this feature only guarantees the *schema* is current and the *database* is isolated, per the
spec's Assumptions).

## Full verification

```bash
npm run verify   # typecheck + lint + unit tests (unaffected by this feature)
npm run test:e2e # exercises the full flow described above
```
