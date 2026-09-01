<!--
Sync Impact Report
- Version change: (none) → 1.0.0
- Modified principles: N/A (initial ratification)
- Added sections:
  - Core Principles (5 principles)
  - Technical Stack & Constraints
  - Development Workflow & Quality Gates
  - Governance
- Removed sections: N/A
- Follow-up TODOs: None
- Deferred non-governance intent: File format conversion backend feature → /speckit-specify
-->

# File Formatting Constitution

## Core Principles

### I. Modular Architecture

Every feature MUST be organized as a NestJS module with a dedicated controller and service.
Business logic belongs in services; controllers MUST only handle HTTP concerns (routing, request
mapping, response shaping). Shared infrastructure (config, database, health, throttling) lives
under `src/core/`; domain features live under `src/modules/`. Cross-module dependencies MUST
be explicit via module imports — no circular imports, no direct service-to-service bypass of
module boundaries.

**Rationale**: A consistent module/controller/service layout keeps the file-formatting
domain extensible as new source and target formats are added without entangling HTTP, persistence,
and conversion logic.

### II. Input Validation & Security (NON-NEGOTIABLE)

All external input MUST be validated before use. Request DTOs MUST use `class-validator` decorators
and pass through the global `ValidationPipe` (`whitelist: true`). Environment and boot-time
configuration MUST be validated via Joi in `ConfigModule`. CORS MUST allow only trusted domains
configured via environment variables — hard-coded localhost origins are permitted for local
development only and MUST NOT ship to production unchanged. Rate limiting via `@nestjs/throttler`
MUST protect authentication and other abuse-prone endpoints; global throttling MUST remain
enabled. Brute-force and DDoS mitigation MUST be applied wherever endpoints accept unauthenticated
or credential-bearing traffic.

**Rationale**: File conversion accepts user-supplied content and metadata; strict validation and
defense-in-depth reduce injection, abuse, and unauthorized access risks.

### III. Database Performance & Integrity

Database access MUST use TypeORM with PostgreSQL. Queries MUST select only the fields required
for the operation — avoid `SELECT *` or equivalent unbounded entity loads. Indexes MUST be
defined for columns used in `WHERE`, `JOIN`, `ORDER BY`, and foreign-key lookups; new migrations
MUST include index rationale when non-obvious. Multi-step writes that must succeed or fail
together MUST use `@Transactional()` from `typeorm-transactional`. Schema changes MUST go through
versioned migrations in `src/database/migrations/`; `POSTGRES_SYNCHRONIZE` MUST remain `false`
in all non-throwaway environments.

**Rationale**: Conversion jobs and user records will grow over time; indexed, selective queries
and transactional consistency prevent performance degradation and partial-state corruption.

### IV. Test Coverage (NON-NEGOTIABLE)

All services, controllers, and non-trivial utilities MUST have unit tests (`*.spec.ts`) using
Jest. Integration and end-to-end tests MUST cover HTTP contracts, database interactions, and
critical user flows (e.g., format conversion requests, auth). Tests MUST run via `npm run test`
(unit) and `npm run test:e2e` (integration). New features MUST NOT merge without tests that
demonstrate expected behavior and guard against regressions. Coverage SHOULD be tracked with
`npm run test:cov`; gaps in critical paths MUST be justified in the PR description.

**Rationale**: File conversion correctness is user-visible and hard to verify manually across
format pairs; automated tests are the primary safety net.

### V. Observability & API Documentation

A health-check endpoint MUST remain available for monitoring (`HealthModule` / `@nestjs/terminus`).
Critical events MUST be logged: authentication attempts (success and failure), application errors,
and data mutations (create, update, delete). Logs MUST be structured and MUST NOT include secrets,
raw credentials, or full file contents unless explicitly required and redacted elsewhere.
The HTTP API MUST expose OpenAPI (Swagger) documentation that reflects the actual running
contract — DTOs, response schemas, status codes, and authentication requirements MUST stay in
sync with implementation. Documentation MUST be served in development and MUST be available in
production via a controlled route or build artifact.

**Rationale**: Operators need health signals; developers and integrators need accurate API docs;
security and audit teams need traceability of auth and data-changing operations.

## Technical Stack & Constraints

The backend MUST adhere to the stack established in this repository:

| Layer | Technology |
|-------|------------|
| Framework | NestJS 11 on Fastify (`@nestjs/platform-fastify`) |
| Validation | `class-validator` / `class-transformer` (runtime), Joi (config) |
| ORM / DB | TypeORM + PostgreSQL (`pg`) |
| Transactions | `typeorm-transactional` |
| Rate limiting | `@nestjs/throttler` |
| Health | `@nestjs/terminus` |
| HTTP plugins | `@fastify/compress`, `@fastify/cookie` |
| Testing | Jest, `@nestjs/testing`, Supertest (e2e) |

Additional constraints:

- Use `@/` path aliases for imports.
- Feature code belongs in `src/modules/`; infrastructure in `src/core/`.
- File-format conversion logic MUST be isolated in dedicated module(s) with clear input/output
  contracts; binary and text formats MUST validate size, MIME/type, and encoding at the boundary.
- Secrets and trusted CORS origins MUST come from environment variables validated at startup.
- OpenAPI setup SHOULD use `@nestjs/swagger` when added; decorators MUST mirror DTO definitions.

## Development Workflow & Quality Gates

1. **Spec before build** — New capabilities start with a feature spec (`/speckit-specify`) and
   implementation plan (`/speckit-plan`) before code changes.
2. **Module scaffolding** — Use Nest CLI (`nest generate module|controller|service`) to preserve
   conventions.
3. **Migrations** — Entity changes require a generated migration; never rely on synchronize in
   shared environments.
4. **Format & lint** — Run `npm run format` and `npm run lint` before committing.
5. **PR checklist** — Every PR MUST confirm: validation on new inputs, indexes for new queries,
   tests added/updated, Swagger/OpenAPI updated, rate limits on sensitive routes, logging on
   critical paths, CORS unchanged or explicitly reviewed.
6. **Code review** — Reviewers MUST verify constitution compliance; violations MUST be fixed or
   explicitly amended via this constitution before merge.

## Governance

This constitution supersedes ad-hoc practices for the File Formatting backend. Amendments MUST
be made via `/speckit-constitution`, documented in the Sync Impact Report (HTML comment at the
top of this file), and reviewed before merge.

**Versioning policy**:

- **MAJOR** — Removal or incompatible redefinition of a principle.
- **MINOR** — New principle or materially expanded guidance.
- **PATCH** — Clarifications, wording, or non-semantic refinements.

**Compliance**: All specs, plans, tasks, and PRs MUST be checked against this document.
Complexity beyond these rules MUST be justified in the implementation plan. Runtime development
guidance lives in `README.md` and module-level README files under `src/core/`.

**Version**: 1.0.0 | **Ratified**: 2026-09-01 | **Last Amended**: 2026-09-01
