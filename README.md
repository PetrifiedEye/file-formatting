# Backend Template

NestJS backend project template. HTTP kernel is **Fastify** (`@nestjs/platform-fastify`), not Express — use Fastify plugins and types (`NestFastifyApplication`, `app.register(...)`) in `src/main.ts`. Compression (`@fastify/compress`) and cookies (`@fastify/cookie`) are already registered.

## Scripts

```bash
npm run start:dev    # Development with hot reload
npm run start:prod   # Production
npm run build        # Build
npm run lint         # Lint & fix
npm run lint:check   # Lint without auto-fix
npm run verify       # Typecheck + lint (no fix) + unit tests
npm run test         # Unit tests
npm run test:e2e     # E2E tests
```

## Project Structure

```
src/
├── core/
│   ├── config/      # App configuration (env variables)
│   ├── database/    # TypeORM + PostgreSQL connection
│   ├── health/      # Health check endpoints
│   └── app/         # Root module
├── database/        # TypeORM CLI data-source and migrations
├── modules/         # Feature modules
│   └── conversion/  # File format conversion (see its README for the rules)
└── main.ts          # Entry point
```

## Database

PostgreSQL and TypeORM are already wired in. Use them for new modules — no extra setup.

- **Local Postgres:** `docker compose up -d` (image and credentials from `.env` / `.env.example`)
- **Database UI (Adminer):** http://localhost:8081 — System: **PostgreSQL**, Server: **postgres**, credentials from `.env`
- **Connection:** `DatabaseModule` (`src/core/database`) is imported in `AppModule`
- **Entities:** any `*.entity.ts` under `src/` is auto-loaded
- **Repositories:** `TypeOrmModule.forFeature([YourEntity])` in a feature module, then `@InjectRepository(YourEntity)`
- **Transactions:** `@Transactional()` from `typeorm-transactional` (context is initialized in `main.ts`)
- **Schema:** migrations in `src/database/migrations/`. `POSTGRES_SYNCHRONIZE` is `false` by default — do not rely on auto-sync

```bash
npm run migration:generate   # Generate from entity changes
npm run migration:run        # Apply pending migrations
npm run migration:revert     # Roll back the last migration
npm run migration:show       # List applied / pending
```

CLI uses `src/database/data-source.ts`. At runtime, Nest uses the DataSource from `DatabaseModule`. If `POSTGRES_MIGRATIONS_RUN=true`, pending migrations also run on app start.

### Seeding local/e2e accounts

There is no self-service "become admin" path by design — admin and RBAC-manager accounts must be provisioned directly against the database. After `npm run migration:run`, run:

```bash
npm run seed:e2e
```

This creates (idempotently — safe to re-run) the two fixture accounts the frontend Playwright suite expects (`frontend/tests/e2e/support/seeded-users.ts`):

- `admin@example.com` / `AdminPassword1!` — `admin` role (`rbac:manage`)
- `rbac-manager@example.com` / `RbacPassword1!` — `rbac-manager` role (`rbac:manage`, `users:read`)

Override emails/passwords via `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_RBAC_USER_EMAIL`, `E2E_RBAC_USER_PASSWORD`. See `scripts/seed-e2e-users.ts`.

### E2E test database

E2E tests run against a separate, isolated database (not your dev database), so `npm run test:e2e` never touches or destroys dev data:

1. Copy the template once: `cp .env.test.example .env.test`, then adjust any values that differ from your dev `.env` (at minimum they must point at different `POSTGRES_DB` values — the template defaults to `app_test`).
2. That's it — no manual `createdb` step needed. Running `npm run test:e2e` automatically runs `pretest:e2e` first, which creates the test database if it doesn't exist yet, and migrations run on app boot via `POSTGRES_MIGRATIONS_RUN=true`.
3. If `.env.test` is missing, or its `POSTGRES_DB` matches dev's, the suite fails fast with a clear error instead of silently running against (and mutating) the dev database.
4. **CI:** no `.env.test` file is needed — set `POSTGRES_HOST`, `POSTGRES_DB`, etc. as real environment variables and they take precedence over anything a file would provide.

## Libraries

| Purpose       | Library                  |
|---------------|--------------------------|
| HTTP          | Fastify (`@nestjs/platform-fastify`) |
| Validation    | Joi                      |
| ORM           | TypeORM (`@nestjs/typeorm`) |
| Database      | PostgreSQL (`pg`)        |
| CSV           | `csv-parse` / `csv-stringify` |
| XML           | `fast-xml-parser`        |
| YAML          | `yaml` (v2, YAML 1.2)    |

## Core Modules

| Purpose       | Module           |
|---------------|-----------------|
| Configuration | `ConfigModule`  |
| Database      | `DatabaseModule` |
| Health Check  | `HealthModule`  |

## File Format Conversion

`POST /api/convert` converts an uploaded file between CSV, JSON, XML, and
YAML; `GET /api/convert/formats` lists the directions the service accepts.
Both require a session.

Every format is one handler that reads its wire form into a canonical document
and writes that document back out, so four handlers produce all twelve
directions and the discovery endpoint is derived rather than written down.
**The mapping rules — what happens to a ragged CSV row, an XML attribute, a
`null` on the way to a spreadsheet — are specified in
[`src/modules/conversion/README.md`](src/modules/conversion/README.md)**,
along with a worked example of adding a fifth format.

### Settings

All optional; the defaults below ship in [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `CONVERSION_MAX_BYTES_CSV` | `5242880` | Max accepted CSV input |
| `CONVERSION_MAX_BYTES_JSON` | `5242880` | Max accepted JSON input |
| `CONVERSION_MAX_BYTES_XML` | `5242880` | Max accepted XML input |
| `CONVERSION_MAX_BYTES_YAML` | `5242880` | Max accepted YAML input |
| `CONVERSION_MAX_OUTPUT_BYTES` | `20971520` | Ceiling on the produced document |
| `CONVERSION_MAX_DEPTH` | `64` | Max structural nesting depth |
| `CONVERSION_MAX_NODES` | `200000` | Max nodes in the parsed document |
| `CONVERSION_MAX_CSV_COLUMNS` | `1024` | Max columns a CSV output may have |
| `CONVERSION_TIMEOUT_MS` | `10000` | Per-conversion time budget |
| `CONVERSION_MAX_CONCURRENT` | `4` | Conversions in flight (bounds memory) |
| `CONVERSION_STORAGE_DIR` | `./storage/conversions` | Retained-result root |

The input limit is **per source format**: the one applied is the detected
format's, so the same byte count can be accepted as XML and refused as CSV.

### The storage root is not `ASSETS_DIR`

`CONVERSION_STORAGE_DIR` must stay **outside** `ASSETS_DIR`. `@fastify/static`
serves `ASSETS_DIR` at `/assets/` with no authentication, so a retained
conversion placed there would be readable by anyone who could guess its path.
Nothing serves retained files over HTTP; the application logs an error at
startup if the two directories overlap.

## Adding a Module

```bash
nest generate module <name>
nest generate controller <name>
nest generate service <name>
```

## Code Style

- Use `@` aliases for imports (e.g., `@config/config.service`)
- Run `npm run format` before committing
- Follow NestJS module pattern
