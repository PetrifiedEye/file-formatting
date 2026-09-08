# Phase 0 Research: Isolated E2E Test Database

All items from the Technical Context were already resolvable from the existing codebase and the
spec's own Assumptions section — no NEEDS CLARIFICATION markers remain. This document records the
decisions made and the alternatives rejected.

## 1. Where does the test env config live?

**Decision**: A gitignored `.env.test` file, loaded explicitly by `test/setup-e2e.ts`, templated
by a committed `.env.test.example` (mirrors the existing `.env` / `.env.example` pattern already
used for dev).

**Rationale**: The spec (FR-002) explicitly names `.env.test` as the expected mechanism, and the
repo already has an established convention (`.env` + `.env.example`) that developers know. Reusing
it minimizes new concepts. `.gitignore` already has an entry for `.env.test.local` (a Next.js/CRA
convention) but not for `.env.test` itself — this needs to be added so real test credentials are
never committed, matching how `.env` is already ignored.

**Alternatives considered**:
- *Single `.env` with a `POSTGRES_TEST_DB` override variable, switched via `NODE_ENV`*: rejected
  because it still requires editing shared config or adding conditional lookup logic throughout
  `ConfigService`, and doesn't satisfy "no manual edits between running dev server and e2e tests"
  (spec User Story 2).
- *Encode test DB name directly in `jest-e2e.json` via `globalSetup` env injection*: rejected,
  less discoverable than a `.env.test` file, and doesn't give CI a natural single override point
  (CI already knows how to inject env vars; a file-based convention is easiest to override).

## 2. How does `test/setup-e2e.ts` load `.env.test` instead of `.env`?

**Decision**: Use `dotenv.config({ path: '.env.test' })` explicitly (rather than the current bare
`import 'dotenv/config'`, which loads `.env`). Add `dotenv` as an explicit `devDependency` (today
it's only resolvable as a transitive dependency of `@nestjs/config`, which is fragile to rely on
directly).

Before loading, check `fs.existsSync('.env.test')` and throw a clear, actionable `Error` if it's
missing (FR-007), pointing the developer at `.env.test.example`.

After loading, read the dev database name too (via `dotenv.parse(fs.readFileSync('.env'))`,
without mutating `process.env`) and compare it against the now-loaded test `POSTGRES_DB`. If they
match, throw — this is the "misconfiguration" edge case in the spec (identical dev/test DB names
must fail loudly, never silently run destructively).

**Rationale**: `dotenv.config()` by default does **not** override variables already present in
`process.env`, which is exactly what's needed for FR-008 (CI supplies `POSTGRES_DB=app_test` etc.
as real env vars, no file needed, and those values win over anything a stray `.env.test` might
contain).

**Alternatives considered**:
- *`dotenv-cli` wrapping the jest command (`dotenv -e .env.test -- jest ...`)*: rejected — adds a
  new CLI dependency and moves logic into `package.json` script strings instead of
  version-controlled, readable TypeScript; also harder to add the dev/test-DB-collision safety
  check.
- *Overriding `process.env.POSTGRES_DB` directly in `setup-e2e.ts` without a file*: rejected,
  fails FR-002 (needs a dedicated config *source*, not a hardcoded value in test code) and would
  require editing test code to change the test DB name.

## 3. How does the test database get created on first run?

**Decision**: A small standalone script, `scripts/ensure-test-db.ts` (run via `ts-node`), invoked
as an npm `pretest:e2e` hook before `test:e2e`. It loads `.env.test` the same way
`setup-e2e.ts` does, connects to the Postgres server's default `postgres` maintenance database
using the `pg` client (already a direct dependency), checks `SELECT 1 FROM pg_database WHERE
datname = $1`, and issues `CREATE DATABASE "<name>"` only if absent. Schema migrations are **not**
run here — that stays the job of the existing `POSTGRES_MIGRATIONS_RUN=true` + `migrationsRun`
option already wired into `DatabaseModule`, which runs on every app boot (including the e2e app
bootstrapped in each `*.e2e-spec.ts`'s `beforeAll`).

**Rationale**: Reuses the existing migration mechanism (per spec Assumptions: "reuses the existing
migration mechanism ... rather than introducing a new schema management approach"). `CREATE
DATABASE` cannot run inside a transaction/prepared statement in Postgres and cannot be done via a
migration, so it necessarily needs a separate bootstrap step outside the ORM.

**Alternatives considered**:
- *Shell script using `psql`/`createdb` CLI*: rejected in favor of TypeScript so it can share
  `.env.test` parsing logic and error messages with `setup-e2e.ts`, and doesn't assume the
  Postgres client CLI tools are installed on the host (only that Node/`pg` are, which is already
  guaranteed).
- *Rely on `docker-entrypoint-initdb.d` init SQL to create `app_test` alongside `app` on container
  start*: rejected as the sole mechanism — it only runs once against a fresh (empty) Postgres data
  volume. Since `docker-compose.yml` already has a named, persistent `postgres_data` volume,
  developers with an existing dev container would never get the test DB created this way,
  violating FR-003's "first-time" requirement for already-running setups.
- *Auto-create lazily inside the Nest app bootstrap itself (e.g. in `DatabaseModule`)*: rejected —
  would entangle test-only bootstrap concerns into production application code, violating
  Principle I (controllers/services shouldn't carry test-environment-only branches).

## 4. CI override mechanism

**Decision**: No change needed beyond what's already true of `ConfigService`/Joi: CI sets
`POSTGRES_HOST`, `POSTGRES_DB=app_test` (or any name), etc. as real process environment variables.
Because `dotenv.config()` doesn't override existing `process.env` values (see #2), and because
`.env.test` won't exist in a fresh CI checkout (it's gitignored), CI naturally supplies its own
values with no committed secrets file required. `scripts/ensure-test-db.ts` and `setup-e2e.ts`
both read from `process.env` after the (best-effort) `dotenv.config()` call, so CI-supplied values
flow through unchanged.

**Rationale**: Matches FR-008 exactly and requires zero CI-specific code.

**Alternatives considered**: A CI-specific `.env.ci` file — rejected as unnecessary; plain env
vars are simpler and is how most CI providers (GitHub Actions, GitLab CI) already inject secrets.
