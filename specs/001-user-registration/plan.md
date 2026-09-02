# Implementation Plan: User Registration

**Branch**: `001-user-registration` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-user-registration/spec.md`

## Summary

Implement guest registration by email and password on the existing NestJS 11 + Fastify backend. Two operational modes controlled by an administrator flag: immediate account activation (confirmation off, P1 default) and email confirmation via 6-digit OTP or magic link (confirmation on). The feature adds `AuthModule` endpoints, `UsersModule` persistence, a `SettingsModule` for confirmation/password policy, core email delivery, audit logging, and layered rate limiting — all aligned with the project constitution.

## Technical Context

**Language/Version**: TypeScript 5.7 / Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (`@nestjs/platform-fastify`), TypeORM 0.3, `@nestjs/throttler`, `class-validator`, `bcryptjs`, `nodemailer`, `@nestjs/swagger` (to add)

**Storage**: PostgreSQL via TypeORM; migrations in `src/database/migrations/`

**Testing**: Jest (unit `*.spec.ts`), Supertest (e2e in `test/`)

**Target Platform**: Linux/macOS server (Docker Compose for local Postgres + Mailpit)

**Project Type**: Web service (REST API backend)

**Performance Goals**: Registration without confirmation completes in < 1 min user time (SC-001); confirmation path < 5 min excluding mail latency (SC-002); bcrypt verify p95 < 500 ms

**Constraints**: Anti-enumeration client responses (FR-015); no secrets in logs/audit (FR-018); `POSTGRES_SYNCHRONIZE=false`; global + per-route throttling on unauthenticated endpoints

**Scale/Scope**: Initial single-region deployment; registration endpoints + admin policy API; no sign-in/session issuance

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Requirement | Plan Compliance |
|-----------|-------------|-----------------|
| I. Modular Architecture | Feature as NestJS module with controller/service separation | `AuthModule`, `UsersModule`, `SettingsModule`; business logic in services; `EmailModule` in `src/core/email/` |
| II. Input Validation & Security | class-validator DTOs, Joi config, rate limiting, CORS from env | All request DTOs validated; bcrypt passwords; `@Throttle()` on register/resend; move CORS to `CORS_ORIGINS` env |
| III. Database Performance & Integrity | TypeORM, selective queries, indexes, migrations, `@Transactional()` | Entities with indexes per data-model; confirmation activate in transaction; versioned migration with `citext` |
| IV. Test Coverage | Unit + e2e tests for services, controllers, critical flows | Test plan in quickstart; e2e for P1/P2/P3 paths and anti-enumeration |
| V. Observability & API Documentation | Health check, structured logging, OpenAPI | Audit table + Logger; `@nestjs/swagger` on all new endpoints |

**Gate status (pre-design)**: PASS — no violations.

**Gate status (post-design)**: PASS — design uses standard module layout; no unjustified complexity. CORS hard-coding in `main.ts` flagged for fix during implementation (research §12).

## Project Structure

### Documentation (this feature)

```text
specs/001-user-registration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── registration-api.openapi.yaml
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── app/app.module.ts          # Import AuthModule, SettingsModule
│   ├── config/                    # Add SMTP, APP_BASE_URL, CORS_ORIGINS
│   ├── database/
│   ├── email/                     # NEW: Nodemailer SMTP adapter
│   │   ├── email.module.ts
│   │   └── email.service.ts
│   ├── health/
│   └── throttler/
├── database/
│   └── migrations/
│       └── *-UserRegistration.migration.ts
└── modules/
    ├── auth/
    │   ├── auth.module.ts
    │   ├── auth.controller.ts
    │   ├── auth.service.ts
    │   ├── dto/
    │   ├── entities/
    │   │   ├── confirmation-challenge.entity.ts
    │   │   └── registration-audit-event.entity.ts
    │   └── *.spec.ts
    ├── users/
    │   ├── users.module.ts
    │   ├── users.service.ts
    │   ├── entities/user.entity.ts
    │   └── *.spec.ts
    └── settings/
        ├── settings.module.ts
        ├── settings.controller.ts
        ├── settings.service.ts
        ├── entities/system-settings.entity.ts
        └── *.spec.ts

test/
├── auth-registration.e2e-spec.ts  # NEW
└── jest-e2e.json
```

**Structure Decision**: Single NestJS backend (Option 1). Registration lives in `AuthModule`; user persistence in `UsersModule`; admin policy in `SettingsModule`; email infrastructure in `src/core/email/` per constitution infrastructure vs domain split.

## Complexity Tracking

> No constitution violations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Phase 0: Research (Complete)

All unknowns resolved in [research.md](./research.md):
- Password hashing (`bcryptjs`)
- OTP/link token generation and storage
- Email delivery (Nodemailer + SMTP)
- Email normalization (`citext`)
- User/pending model (single table + status enum)
- Rate limiting (HTTP + application layers)
- Admin policy storage (`system_settings` singleton)
- Audit logging schema
- OpenAPI via `@nestjs/swagger`
- Anti-enumeration response strategy
- CORS env migration

## Phase 1: Design (Complete)

Artifacts generated:
- [data-model.md](./data-model.md) — entities, fields, indexes, state transitions
- [contracts/registration-api.openapi.yaml](./contracts/registration-api.openapi.yaml) — REST contract
- [quickstart.md](./quickstart.md) — manual and automated validation scenarios

**Post-design Constitution re-check**: PASS.

## Implementation Notes (for `/speckit-tasks`)

1. Add dependencies: `bcryptjs`, `@types/bcryptjs`, `nodemailer`, `@types/nodemailer`, `@nestjs/swagger`.
2. Enable PostgreSQL `citext` extension in first migration.
3. Wire `AuthModule` into `AppModule` (currently only `UsersModule` is imported).
4. Implement `EmailService` with test double for unit tests and Mailpit for e2e.
5. Admin endpoints ship with a placeholder guard (documented TODO for real admin auth).
6. Expired pending users: lazy delete on registration attempt or scheduled job (choose lazy for MVP).
7. Update existing e2e test (`test/app.e2e-spec.ts`) — currently expects `Hello World` route that does not exist.

## Next Step

Run `/speckit-tasks` to generate dependency-ordered implementation tasks from this plan.
