# Implementation Plan: JWT Cookie-Based Session Authorization

**Branch**: `004-jwt-session-auth` | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-jwt-session-auth/spec.md`

## Summary

Replace the current opaque, DB-backed session cookie (`Session` entity/table,
`SessionService`, `SessionAuthGuard`) with a stateless JWT access/refresh pair carried
in `httpOnly` cookies: a 15-minute access token authenticates every protected request
(re-checking the user's active status and current roles on each request, never trusting
embedded claims for that), and a 30-day, single-use-then-rotated refresh token
(`POST /auth/refresh`) renews the session without a password. No refresh-token state
(allowlist, denylist, jti) is ever persisted server-side per FR-010; the only available
revocation is TTL expiry and client-side cookie clearing on logout. See
[research.md](./research.md) for the library, cookie, and audit-logging decisions
behind this approach.

## Technical Context

**Language/Version**: TypeScript 5.7 / Node.js (NestJS 11)

**Primary Dependencies**: `@nestjs/jwt` (new), `@fastify/cookie` (existing),
`@nestjs/throttler` (existing), `typeorm` + `pg` (existing, for the user-status lookup
only — no new persisted entities)

**Storage**: PostgreSQL via TypeORM — no new tables; one migration to drop the
`sessions` table/index and extend the `login_audit_events.event_type` enum

**Testing**: Jest unit tests (`*.spec.ts`) for `TokenService`/`JwtAuthGuard`; Supertest
e2e for the login → protected-resource → expiry → refresh → logout flow

**Target Platform**: Linux server (existing NestJS/Fastify backend)

**Project Type**: Single backend project (existing `src/modules/`, `src/core/` layout)

**Performance Goals**: Session renewal (`/auth/refresh`) completes in under 1s under
normal load (SC-003) — trivially met since it is signature verification plus one
indexed user lookup, no network calls

**Constraints**: No server-side refresh-credential storage of any kind (FR-010); access
tokens must re-verify user active status and roles on every request rather than trusting
embedded claims (FR-003); cookies must be `httpOnly`, transport-restricted, and
same-site constrained (FR-012); no credential or secret material may reach logs
(FR-014)

**Scale/Scope**: Single NestJS application, one existing module (`auth`) modified plus
its two existing consumer areas (`rbac`, `settings` guards) repointed to the new guard;
no new modules

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | Change stays inside the existing `auth` module (controller/service/guard split preserved: `TokenService` holds JWT logic, `JwtAuthGuard` stays a thin `CanActivate`, `AuthController` only wires cookies). `rbac`/`settings` guards import the new guard via the module's existing export, no new cross-module coupling. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | New `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` validated at boot via the existing Joi schema (`config.validation.ts`); `/auth/refresh` is rate-limited like `/auth/login`; cookies are `httpOnly`/`secure`(prod)/`sameSite=lax` per FR-012; two independent secrets + a `typ` claim prevent access/refresh token confusion. | PASS |
| III. Database Performance & Integrity | Only new DB work is a `WHERE id = $1` user lookup (already indexed via PK) on every protected request/refresh — no new tables; the `sessions` table drop and audit-enum extension both ship as a versioned migration in `src/database/migrations/`; `POSTGRES_SYNCHRONIZE` stays `false`. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | `TokenService`, `JwtAuthGuard`, updated `AuthService`/`AuthController` all get/keep unit tests; e2e coverage extended for `/auth/refresh` and the changed `/auth/logout` contract. Existing `session-auth.guard.spec.ts`/`session.service.spec.ts` are replaced by their JWT equivalents rather than left stale. | PASS |
| V. Observability & API Documentation | Failed auth/refresh attempts recorded via the existing `LoginAuditService` (category-only failure reasons, no secrets — FR-013/FR-014); Swagger annotations added for `POST /auth/refresh` and updated for `/auth/logout`'s new (no-auth-required) contract. | PASS |

No violations — Complexity Tracking section is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/004-jwt-session-auth/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
├── contracts/
│   └── auth-endpoints.md # Phase 1 output (/speckit-plan command)
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── config/
│       ├── config.types.ts        # + JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
│       └── config.validation.ts   # + Joi rules for the above
├── modules/
│   ├── auth/
│   │   ├── auth.module.ts               # registers @nestjs/jwt providers, TokenService, JwtAuthGuard; drops SessionService/SessionAuthGuard/Session entity
│   │   ├── auth.controller.ts           # cookie helpers -> access_token/refresh_token; new POST /auth/refresh; /auth/logout no longer guarded
│   │   ├── auth.service.ts              # issues {accessToken, refreshToken} instead of IssuedSession
│   │   ├── token.service.ts             # NEW — sign/verify access & refresh JWTs
│   │   ├── token.service.spec.ts        # NEW
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts        # NEW — replaces session-auth.guard.ts
│   │   │   └── jwt-auth.guard.spec.ts   # NEW
│   │   ├── entities/
│   │   │   ├── session.entity.ts        # REMOVED
│   │   │   └── login-audit-event.entity.ts  # + ACCESS_CHECK_FAILED, TOKEN_REFRESH_ATTEMPT
│   │   ├── session.service.ts           # REMOVED
│   │   └── guards/session-auth.guard.ts # REMOVED
│   ├── rbac/
│   │   ├── guards/permission.guard.ts   # SessionAuthGuard usage -> JwtAuthGuard
│   │   ├── roles.controller.ts          # same
│   │   ├── permissions.controller.ts    # same
│   │   └── grants.controller.ts         # same
│   └── settings/
│       └── guards/admin.guard.ts        # SessionAuthGuard usage -> JwtAuthGuard
└── database/
    └── migrations/
        └── <timestamp>-JwtSessionAuth.migration.ts  # NEW — drop sessions table/index, extend login_audit_events.event_type enum

tests/ (colocated *.spec.ts as above; e2e specs under existing e2e project config)
```

**Structure Decision**: Single existing NestJS backend project (`src/core` +
`src/modules`, per the constitution's Technical Stack table) — no new project or
directory root. This feature is a targeted rework inside the existing `auth` module
plus small guard-import updates in `rbac` and `settings`, consistent with how the prior
`002-rbac` and `003-session-login` features were delivered.

## Complexity Tracking

*No Constitution Check violations — not applicable.*
