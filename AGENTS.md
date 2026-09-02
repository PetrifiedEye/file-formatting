# Agent Instructions

Instructions for AI agents working in this repository. Follow these rules on every task.

## Mandatory quality gate (before finishing)

Before marking any code change complete, run:

```bash
npm run verify
```

This runs TypeScript (`tsc --noEmit`), ESLint without auto-fix, and unit tests. **All must pass with zero errors.**

When HTTP routes, auth flows, or database contracts change, also run:

```bash
npm run test:e2e
```

If verification fails, fix every error before finishing. Do not leave ESLint warnings in `src/`. Do not disable lint or TypeScript rules without explicit justification.

### Cleanup vs verification

| Command | Purpose |
|---------|---------|
| `npm run format` | Auto-format with Prettier |
| `npm run lint` | Lint and auto-fix |
| `npm run lint:check` | Lint without modifying files (used by `verify`) |
| `npm run verify` | **Required gate** — typecheck + lint:check + unit tests |

## Stack and layout

- **Framework**: NestJS 11 on **Fastify** (`@nestjs/platform-fastify`) — not Express
- **`src/core/`** — shared infrastructure (config, database, health, email, throttling)
- **`src/modules/`** — domain feature modules
- **`src/database/`** — TypeORM CLI data-source and migrations
- **Imports**: use `@/` path aliases (e.g. `@/core/config/config.service`)

## NestJS conventions

Match existing patterns in the codebase. Do not invent new architectural styles.

### Module structure

Every feature is a NestJS module with a controller and service(s):

- **Controllers** — HTTP only: routing, DTO binding, response shaping, Swagger decorators, rate limiting
- **Services** — business logic, repositories, orchestration
- **DTOs** — request/response classes with `class-validator` decorators and `@nestjs/swagger` `ApiProperty`
- **Entities** — TypeORM entities in `entities/` subdirectories

Scaffold with Nest CLI when adding features:

```bash
nest generate module <name>
nest generate controller <name>
nest generate service <name>
```

### Validation and config

- Request DTOs use `class-validator`; global `ValidationPipe` has `whitelist: true`
- Environment config is validated via Joi in `ConfigModule` at startup
- CORS origins come from environment variables — never hard-code production origins

### Database

- TypeORM + PostgreSQL; entities auto-loaded from `src/**/*.entity.ts`
- Schema changes require versioned migrations in `src/database/migrations/`
- `POSTGRES_SYNCHRONIZE` must remain `false` — never rely on auto-sync
- Multi-step writes that must succeed or fail together use `@Transactional()` from `typeorm-transactional`
- Register entities via `TypeOrmModule.forFeature([...])` in the feature module

### Security and observability

- Rate-limit abuse-prone endpoints with `@nestjs/throttler` (`@Throttle(...)`)
- Expose Swagger/OpenAPI docs via `@nestjs/swagger` decorators on controllers and DTOs
- Health checks live in `HealthModule` (`@nestjs/terminus`)
- Log critical events; never log secrets, credentials, or raw file contents

## Code style

- Run `npm run format` before committing if Prettier would change files
- Follow ESLint rules in `eslint.config.mjs` (type-checked, Prettier-integrated)
- Keep changes minimal and focused — match surrounding naming, imports, and documentation level
- Prefer extending existing code over reimplementing similar logic

## Canonical examples

Use these files as reference when adding new code:

| Pattern | File |
|---------|------|
| Controller + Swagger + Throttle | `src/modules/auth/auth.controller.ts` |
| Module wiring | `src/modules/auth/auth.module.ts` |
| Request DTO | `src/modules/auth/dto/register-request.dto.ts` |
| Global config validation | `src/core/config/config.module.ts` |
| App bootstrap (Fastify) | `src/main.ts` |

## References

- [`.specify/memory/constitution.md`](.specify/memory/constitution.md) — full project governance (architecture, validation, DB, tests, observability)
- [`README.md`](README.md) — setup, database, migrations, scripts
