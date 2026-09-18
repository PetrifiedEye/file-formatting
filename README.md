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
npm run fixtures:images  # Regenerate the image test fixtures (pretest:e2e runs it)
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
│   ├── conversion/  # File format conversion (see its README for the rules)
│   └── image-conversion/  # Image conversion (see its README for the rules)
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

| Purpose    | Library                              |
| ---------- | ------------------------------------ |
| HTTP       | Fastify (`@nestjs/platform-fastify`) |
| Validation | Joi                                  |
| ORM        | TypeORM (`@nestjs/typeorm`)          |
| Database   | PostgreSQL (`pg`)                    |
| CSV        | `csv-parse` / `csv-stringify`        |
| XML        | `fast-xml-parser`                    |
| YAML       | `yaml` (v2, YAML 1.2)                |

## Core Modules

| Purpose       | Module           |
| ------------- | ---------------- |
| Configuration | `ConfigModule`   |
| Database      | `DatabaseModule` |
| Health Check  | `HealthModule`   |

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

| Variable                                       | Default                 | Meaning                                                         |
| ---------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `CONVERSION_MAX_BYTES_CSV`                     | `5242880`               | Max accepted CSV input                                          |
| `CONVERSION_MAX_BYTES_JSON`                    | `5242880`               | Max accepted JSON input                                         |
| `CONVERSION_MAX_BYTES_XML`                     | `5242880`               | Max accepted XML input                                          |
| `CONVERSION_MAX_BYTES_YAML`                    | `5242880`               | Max accepted YAML input                                         |
| `CONVERSION_MAX_OUTPUT_BYTES`                  | `20971520`              | Ceiling on the produced document                                |
| `CONVERSION_MAX_DEPTH`                         | `64`                    | Max structural nesting depth                                    |
| `CONVERSION_MAX_NODES`                         | `200000`                | Max nodes in the parsed document                                |
| `CONVERSION_MAX_CSV_COLUMNS`                   | `1024`                  | Max columns a CSV output may have                               |
| `CONVERSION_TIMEOUT_MS`                        | `10000`                 | Per-conversion time budget                                      |
| `CONVERSION_MAX_CONCURRENT`                    | `4`                     | Conversions in flight (bounds memory)                           |
| `CONVERSION_STORAGE_DIR`                       | `./storage/conversions` | Retained-result root                                            |
| `TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS` | `3600000`               | Expired-result cleanup interval; `0` disables scheduled cleanup |

The input limit is **per source format**: the one applied is the detected
format's, so the same byte count can be accepted as XML and refused as CSV.

Both conversion operations accept an optional multipart `store` field. It is
`false` when omitted and accepts only the strings `true` or `false`. A
successful `store=true` request privately retains the exact response bytes and
links them to that conversion-history row. The existing response remains the
conversion itself; `X-Conversion-Retention` reports `stored` or `failed`.
Invalid values return `400 invalid_store_flag`.

## Image Conversion

`POST /api/images/convert` converts an uploaded image between PNG, JPEG, and
SVG-as-a-source; `GET /api/images/convert/formats` lists the directions the
service accepts. Both require a session.

Each format is one handler that may implement `decode`, `encode`, or both, and
conversion is always `decode → RasterImage → encode`. The direction set is
_decoders x encoders minus self-pairs_ — which is why `png→svg` is not
forbidden but **unrepresentable**: the SVG handler implements no encoder, so
the pair cannot be computed and discovery cannot advertise it.

**The rules — SVG sizing and safety, alpha compositing, EXIF orientation, the
pixel budget, and a worked example of adding WebP — are in
[`src/modules/image-conversion/README.md`](src/modules/image-conversion/README.md)**,
with the pixel-level contract in
[`specs/011-image-conversion/contracts/image-rasterisation-rules.md`](specs/011-image-conversion/contracts/image-rasterisation-rules.md).

Image attempts are recorded in the _same_ `conversion_records` history as text
conversions, and retained images share `CONVERSION_STORAGE_DIR`. The feature
adds no table and no column.

### Settings

All optional; the defaults below ship in [`.env.example`](.env.example).

| Variable                      | Default    | Meaning                                     |
| ----------------------------- | ---------- | ------------------------------------------- |
| `IMAGE_MAX_BYTES_PNG`         | `10485760` | Max accepted PNG input                      |
| `IMAGE_MAX_BYTES_JPEG`        | `10485760` | Max accepted JPEG input                     |
| `IMAGE_MAX_BYTES_SVG`         | `2097152`  | Max accepted SVG input                      |
| `IMAGE_MAX_OUTPUT_WIDTH`      | `8192`     | Max rasterised width                        |
| `IMAGE_MAX_OUTPUT_HEIGHT`     | `8192`     | Max rasterised height                       |
| `IMAGE_MAX_PIXELS`            | `16000000` | Decoded pixel budget, read from the header  |
| `IMAGE_MAX_OUTPUT_BYTES`      | `20971520` | Ceiling on the produced image               |
| `IMAGE_BACKGROUND_COLOR`      | `#ffffff`  | What alpha composites onto                  |
| `IMAGE_JPEG_QUALITY`          | `85`       | Fixed output quality; never caller-supplied |
| `IMAGE_CONVERSION_TIMEOUT_MS` | `30000`    | Per-conversion time budget                  |
| `IMAGE_MAX_CONCURRENT`        | `2`        | Conversions in flight (bounds memory)       |
| `IMAGE_SVG_FONT_DIR`          | _(empty)_  | Fonts for SVG text; empty means none        |

Like the text pipeline, the input limit is **per source format**, so the same
byte count can be accepted as PNG and refused as SVG. `IMAGE_SVG_FONT_DIR`
being empty is meaningful rather than unset: no fonts are loaded and no system
font scan happens, so `<text>` in an SVG renders as nothing — deliberate, so
the same drawing converts identically on every host.

Peak raster memory is bounded by `IMAGE_MAX_PIXELS x 4 bytes x
IMAGE_MAX_CONCURRENT`.

Image conversion uses the same optional `store` field and private storage
lifecycle. `X-Image-Conversion-Retention` reports `not-requested`, `stored`, or
`failed`; storing never changes the converted image bytes or status.

## Retained transformation results

Each transformation-history row receives an immutable expiry when it is
created. The default policy is 90 days. Administrators holding
`settings:manage` can read or change the policy for **new** rows:

```text
GET   /admin/settings/transformation-retention
PATCH /admin/settings/transformation-retention
Body: { "retentionDays": 180 }  # integer, 1–3650
```

Changing this setting does not move existing deadlines. Apply the feature
migration before deployment with `npm run migration:run`; it backfills
existing history rows to 90 days, adds the retention setting and
`transformation-history:download-any` action, and creates the result-audit
table.

An authenticated owner downloads an unexpired retained result from:

```text
GET /api/transformations/history/:itemId/download
```

An administrator with `transformation-history:download-any` may download for a
specified owner from:

```text
GET /admin/users/:userId/transformations/history/:itemId/download
```

Downloads stream the saved bytes with their trusted media type, deterministic
filename, exact `Content-Length`, `Content-Encoding: identity`, and
`Cache-Control: private, no-store`. Unknown, unsaved, cross-owner, expired, and
missing-on-disk results all use the same `404 Transformation result not
available` response. Authentication and admin permission checks run before
resource lookup. Unexpected preflight storage failures return 500; if a read
fails after headers are sent, the server aborts the incomplete transfer rather
than presenting partial bytes as a valid download.

Cleanup runs in bounded expiry order at
`TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS`. It unlinks a retained file
before deleting its history row and linked metadata. Missing files are treated
as already removed; other per-item failures leave that row for a later retry
without blocking subsequent expired rows. Set the interval to `0` only when an
external process invokes equivalent cleanup.

## The storage root is not `ASSETS_DIR`

Shared by both conversion features, and the reason they share one root.

`CONVERSION_STORAGE_DIR` must stay **outside** `ASSETS_DIR`. `@fastify/static`
serves `ASSETS_DIR` at `/assets/` with no authentication, so a retained
conversion or image placed there would be readable by anyone who could guess
its path. Retained files have no direct/static route: only the authenticated
download operations above expose their bytes, and API/audit payloads never
expose storage paths. The application logs an error at startup if the two
directories overlap.

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
