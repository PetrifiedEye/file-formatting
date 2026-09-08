# Phase 1 Data Model: Isolated E2E Test Database

This feature introduces no new database tables, entities, or ORM models — the only "entity" is a
configuration shape. There are no state transitions.

## Test Environment Configuration

Represents the set of environment values that apply only to e2e test runs, sourced from
`.env.test` (or process env in CI), read by both `test/setup-e2e.ts` and
`scripts/ensure-test-db.ts`. It reuses the exact same field set already validated by
`configValidationSchema` (`src/core/config/config.validation.ts`) — no new fields are introduced,
only a new *source* file for a subset of them.

| Field | Type | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | string | yes | Must be `test` for e2e runs |
| `POSTGRES_HOST` | string (hostname) | yes | Same Postgres server as dev (per spec Assumptions) |
| `POSTGRES_PORT` | number (port) | yes | Same as dev, typically |
| `POSTGRES_USER` | string | yes | May reuse dev credentials (per spec Assumptions) |
| `POSTGRES_PASSWORD` | string | yes | May reuse dev credentials |
| `POSTGRES_DB` | string | yes | **Must differ from dev's `POSTGRES_DB`** — this is the field that drives isolation |
| `POSTGRES_MIGRATIONS_RUN` | boolean | no (default `false`, but `.env.test.example` sets it `true`) | Ensures schema is current on every e2e boot (Story 3) |
| `POSTGRES_SYNCHRONIZE` | boolean | no (default `false`) | Stays `false`, per Principle III — schema changes only via migrations |
| `POSTGRES_LOGGING` | boolean | no | Optional, developer preference |
| All other required fields already in `configValidationSchema` | — | yes | `PORT`, `COOKIE_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SMTP_*`, `APP_BASE_URL`, `ASSETS_DIR`, `ASSETS_BASE_URL` — these can be copied from `.env` as-is; they don't affect database isolation but are still required for the Nest app to boot during e2e tests |

**Validation rules**:
- Enforced structurally by the existing Joi `configValidationSchema` when the Nest app boots
  inside each e2e spec's `beforeAll` (unchanged).
- Enforced additionally, *before* that, by `test/setup-e2e.ts`:
  1. `.env.test` file must exist → else throw with a message pointing at `.env.test.example`
     (FR-007).
  2. Resolved `POSTGRES_DB` (test) must differ from the value found in the dev `.env` file's
     `POSTGRES_DB` → else throw (Edge Case: identical dev/test DB names).

**Relationships**: None (no ORM entity). Conceptually parallel to the existing (undocumented as a
"model") dev environment configuration already loaded from `.env` by `ConfigModule`.

**State**: Static per test run — loaded once in `setup-e2e.ts` before any test file executes, no
mutation during the run.
