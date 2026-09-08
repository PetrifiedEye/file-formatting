# Feature Specification: Isolated E2E Test Database

**Feature Branch**: `007-e2e-test-database`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "give e2e tests their own database instead of running against the same one Adminer/dev use. Add a .env.test (or override POSTGRES_DB) pointing at e.g. app_test, and wire jest-e2e.json/test bootstrap to load it. Otherwise every e2e run will keep destroying your dev seed data."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run e2e suite without losing dev data (Priority: P1)

As a developer working on this backend, when I run the e2e test suite, I want it to run against a dedicated test database so that my local development data (seeded users, roles, uploaded profile photos, etc., viewable in Adminer) is never wiped, truncated, or mutated by test runs.

**Why this priority**: This is the core problem statement — every e2e run currently destroys dev seed data because tests and local development share one database. This is the minimum change that makes e2e tests safe to run repeatedly during normal development.

**Independent Test**: Seed the dev database with a distinct user via the running dev server, run `npm run test:e2e`, then verify (e.g. via Adminer or a direct query) that the seeded dev user is still present and unmodified afterward.

**Acceptance Scenarios**:

1. **Given** a developer has dev data in their local Postgres database, **When** they run the e2e test suite, **Then** the dev database's contents are unchanged after the run completes.
2. **Given** the e2e test suite is running, **When** any test creates, updates, or deletes records, **Then** those changes occur only in the dedicated test database, never in the dev database.
3. **Given** a developer has not manually created the test database beforehand, **When** they run the e2e test suite for the first time, **Then** the suite either creates the database automatically or fails with a clear, actionable error message telling them how to create it.

---

### User Story 2 - Predictable, isolated environment configuration per run (Priority: P2)

As a developer, when the e2e suite starts, I want its environment configuration (database name, and any other environment-specific values) to be loaded from a dedicated test environment source, so that I don't have to manually edit `.env` back and forth between running the app and running e2e tests.

**Why this priority**: Without a dedicated config source, the only way to isolate the database is to hand-edit shared `.env` values before/after each test run, which is error-prone and defeats the purpose of isolation. This story makes isolation automatic and repeatable.

**Independent Test**: Run the e2e suite immediately after starting the dev server (without touching `.env`), and confirm both processes report connecting to their respective, different databases (dev vs. test) in their startup logs/output.

**Acceptance Scenarios**:

1. **Given** the developer has a valid `.env` for the dev app and the new test environment configuration in place, **When** they start the dev server and separately run the e2e suite, **Then** each process connects to its own database without any manual edits to shared configuration files.
2. **Given** the test environment configuration is missing required values, **When** the e2e suite starts, **Then** it fails fast with a clear error rather than silently falling back to the dev database.

---

### User Story 3 - Clean, repeatable test runs (Priority: P3)

As a developer, when I run the e2e suite multiple times in a row (e.g., in a tight edit-test loop or in CI), I want each run to start from a consistent database state, so that test failures are caused by real regressions and not by leftover data from a previous run.

**Why this priority**: This builds on database isolation — once tests have their own database, the suite should also manage that database's schema/state consistently across runs. This is lower priority than isolation itself, since isolation alone already solves the "destroying dev data" problem, but it's necessary for reliable, repeatable test results.

**Independent Test**: Run the e2e suite twice in immediate succession and confirm both runs produce the same pass/fail outcome for an unchanged codebase, with no test failing only on the second run due to leftover state from the first.

**Acceptance Scenarios**:

1. **Given** the test database already contains data from a previous e2e run, **When** the e2e suite runs again, **Then** the required schema is present (via migrations) and tests do not fail due to leftover records from the earlier run.
2. **Given** the e2e suite runs in a fresh environment where the test database does not yet exist, **When** the suite starts, **Then** the necessary schema is established (e.g., via migrations) before any tests execute.

### Edge Cases

- What happens if a developer's local `POSTGRES_DB` (dev) and the test database name accidentally end up identical due to misconfiguration? The suite must not silently proceed against the dev database — it should detect this and fail loudly rather than run tests destructively.
- What happens if the test environment configuration file is missing entirely (e.g., a fresh clone that hasn't been set up yet)? The suite should fail with a clear message pointing the developer to the setup step, rather than falling back to dev defaults.
- What happens when the same Postgres server instance (container) is used for both dev and test, but on different database names, versus separate Postgres instances entirely? Both must be supported since dev environments commonly reuse one running Postgres container for the test database.
- How does this interact with CI, where there is no pre-existing `.env`? CI must be able to supply the test database configuration through its own mechanism (e.g., environment variables) without requiring a committed secrets file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The e2e test suite MUST connect to a database that is distinct from the database used by the developer's running dev server (as configured via the project's Adminer/dev `.env`).
- **FR-002**: The system MUST provide a dedicated test environment configuration source (e.g., a `.env.test` file or equivalent override mechanism) that specifies the test database name, separate from the dev environment configuration.
- **FR-003**: The e2e test bootstrap process MUST load the test environment configuration before the application/database connection is initialized for any e2e test run.
- **FR-004**: Running the e2e suite MUST NOT modify, delete, or otherwise affect any data in the dev database.
- **FR-005**: The project MUST document (e.g., in README or an example env file) how a developer sets up the test database and its configuration for the first time.
- **FR-006**: The e2e test bootstrap process MUST ensure the test database's schema is up to date (e.g., by running migrations) before tests execute.
- **FR-007**: If the test environment configuration is missing or incomplete, the e2e suite MUST fail with a clear error rather than silently using dev configuration or defaults.
- **FR-008**: The test database configuration MUST be overridable via environment variables so that CI environments can supply it without a committed file containing secrets.

### Key Entities

- **Test Environment Configuration**: The set of environment-specific values (chiefly the test database name, plus any connection settings needed) that apply only to e2e test runs, distinct from the dev environment configuration already used by the app and Adminer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After running the full e2e suite, 100% of pre-existing dev database records remain unchanged, verified by comparing a snapshot of dev data before and after the run.
- **SC-002**: A developer can run the e2e suite immediately after seeding dev data and immediately after starting the dev server, with zero manual configuration edits required between the two actions.
- **SC-003**: Running the e2e suite back-to-back twice produces identical pass/fail results for unchanged code, with no run-order-dependent failures.
- **SC-004**: A first-time contributor can go from a fresh clone to a passing e2e run by following documented setup steps, without needing to ask how to avoid clobbering dev data.

## Assumptions

- The project continues to use a single PostgreSQL server/container for local development, with the test database being a separate database name (e.g. `app_test`) on that same server rather than a wholly separate server instance; both configurations may point at the same host/port.
- Schema setup for the test database reuses the existing migration mechanism already used for the dev database, rather than introducing a new schema management approach.
- Secrets (passwords) for the test database in local development can reuse the same credentials as dev (since it's the same local Postgres server); only the database name needs to differ. CI may override any of these values via environment variables.
- This feature covers configuration/bootstrap wiring only; it does not require changing individual test files' logic beyond what's needed to pick up the new configuration.
- "Adminer/dev" database refers to the database currently configured via `POSTGRES_DB` in the project's `.env` file, which Adminer also connects to for inspection.
