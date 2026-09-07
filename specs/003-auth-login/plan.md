# Implementation Plan: User Login & Session Authentication

**Branch**: `003-auth-login` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-auth-login/spec.md`

## Summary

Add the login, session, and account-protection layer the registration feature was built without:
email/password login issuing a database-backed session cookie; an optional sign-in email
verification step reusing the registration OTP/link mechanism; brute-force lockout with full
audit logging; self-service password recovery; and a real `SessionAuthGuard` that finally
populates `request.user` so the existing (currently inert) `PermissionGuard`/RBAC routes and the
placeholder `AdminGuard` actually enforce authentication. Approach: extend the existing
`src/modules/auth` module with new services/entities that mirror the patterns already
established for registration (hashed opaque tokens, challenge tables with attempt limits,
per-endpoint `@Throttle`, a sibling audit-event table) rather than introducing a new auth
paradigm (e.g. JWT) — see [research.md](./research.md) for the resolved design decisions.

## Technical Context

**Language/Version**: TypeScript 5.7, Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (`@nestjs/platform-fastify`), TypeORM 0.3 + `pg`,
`typeorm-transactional`, `@nestjs/throttler`, `@fastify/cookie` (already registered in
`main.ts`), `bcryptjs`, `nodemailer`, `class-validator`/`class-transformer`, `@nestjs/swagger`.
No new runtime dependencies required (see research.md §1 — opaque DB-backed sessions instead of
JWT).

**Storage**: PostgreSQL via TypeORM; new tables `sessions`, `login_challenges`,
`password_reset_challenges`, `login_audit_events`; new columns `failed_login_attempts`,
`locked_until` on `users`.

**Testing**: Jest (`npm run test`) for unit specs; Jest + Supertest (`npm run test:e2e`) for
end-to-end HTTP contract tests, following `test/auth-registration.e2e-spec.ts` and
`test/rbac-access-check.e2e-spec.ts`.

**Target Platform**: Linux server (containerized NestJS backend), existing local dev stack
(Postgres, Mailpit).

**Project Type**: Single backend web service (existing repo, no separate frontend in this repo).

**Performance Goals**: Login round-trip < 5s under normal load (SC-001); session validation is a
single indexed lookup (`sessions.token_hash` unique index), no heavier than existing
`ConfirmationChallenge` lookups already in production use.

**Constraints**: Every failed-login outcome (unknown email vs wrong password) MUST be
indistinguishable (FR-002/FR-003/SC-002); no request may leak whether an email is registered
across login, verification, or password-reset endpoints; rate limiting and lockout MUST NOT
themselves become an email-address oracle (generic 423/401 bodies).

**Scale/Scope**: Same single-tenant scale as the existing registration feature; 4 new tables, ~10
new/changed source files, no new infrastructure services.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Compliance |
|---|---|
| I. Modular Architecture | Stays inside `src/modules/auth` (new services: `SessionService`, `LoginAuditService`, `PasswordResetService`, guard: `SessionAuthGuard`) plus additive columns on the existing `User` entity in `src/modules/users`. Controllers stay thin (delegate to `AuthService`/new services); no cross-module service reach-arounds — `RbacModule`/`SettingsModule` only gain a guard dependency on the new `SessionAuthGuard`, exported the same way `PermissionGuard` already is. **PASS** |
| II. Input Validation & Security (NON-NEGOTIABLE) | All new DTOs (`LoginRequestDto`, `LoginVerifyRequestDto`, `PasswordResetRequestDto`, `PasswordResetConfirmDto`) use `class-validator`, pass through the existing global `ValidationPipe`. Rate limiting via `@nestjs/throttler` applied to `/auth/login`, `/auth/login/verify`, `/auth/password-reset/*` (research.md §8). Brute-force mitigation via lockout (FR-008). Session cookie is `httpOnly`/`secure`/`sameSite=lax`, using the already-validated `COOKIE_SECRET`. **PASS** |
| III. Database Performance & Integrity | New indexes: unique on `sessions.token_hash`, partial active-row indexes on the two new challenge tables (mirroring `idx_confirmation_challenges_active`), composite `(normalized_email, created_at)`/`(event_type, created_at)` on `login_audit_events` (mirroring `registration_audit_events`). Lockout is a direct column check, not an aggregate query (research.md §3). Multi-step writes (verify challenge + issue session; reset password + invalidate sessions) wrapped in `@Transactional()`, matching `AuthService.confirmByCode`. All changes ship as versioned migrations under `src/database/migrations/`; `POSTGRES_SYNCHRONIZE` stays `false`. **PASS** |
| IV. Test Coverage (NON-NEGOTIABLE) | New `*.spec.ts` for every new service/guard; new `test/auth-login.e2e-spec.ts` covering all five user stories' acceptance scenarios end-to-end, following existing e2e patterns. Task breakdown (`/speckit-tasks`) will enumerate these explicitly. **PASS (planned)** |
| V. Observability & API Documentation | Every login/verify/logout/reset attempt logged via `LoginAuditService` (structured, no raw passwords/tokens — only hashes and outcomes, matching `RegistrationAuditService`'s redaction discipline). New endpoints get `@ApiOperation`/`@ApiOkResponse`/etc. Swagger decorators, matching the existing `auth.controller.ts` style. **PASS** |

No violations requiring a Complexity Tracking entry.

## Project Structure

### Documentation (this feature)

```text
specs/003-auth-login/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── auth-api.md      # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

**Structure Decision**: Single NestJS backend project (Option 1, adapted to this repo's existing
`src/core` / `src/modules` split — no `src/models`/`src/cli`/`src/lib` scaffolding is used here;
the real layout below reflects the actual repository conventions established by the registration
and RBAC features).

```text
src/
├── modules/
│   ├── auth/
│   │   ├── auth.controller.ts               # extend: login/verify/logout/reset routes
│   │   ├── auth.service.ts                   # extend: login/verify/reset methods
│   │   ├── auth.module.ts                    # extend: new providers/entities
│   │   ├── session.service.ts                # NEW — issue/validate/invalidate sessions
│   │   ├── guards/
│   │   │   └── session-auth.guard.ts         # NEW — populates request.user from session cookie
│   │   ├── login-challenge.service.ts        # NEW — pending sign-in verification
│   │   ├── password-reset.service.ts         # NEW — password recovery flow
│   │   ├── login-audit.service.ts            # NEW — sibling of registration-audit.service.ts
│   │   ├── entities/
│   │   │   ├── session.entity.ts             # NEW
│   │   │   ├── login-challenge.entity.ts     # NEW
│   │   │   ├── password-reset-challenge.entity.ts  # NEW
│   │   │   └── login-audit-event.entity.ts   # NEW
│   │   └── dto/
│   │       ├── login-request.dto.ts          # NEW
│   │       ├── login-response.dto.ts         # NEW
│   │       ├── login-verify-request.dto.ts   # NEW
│   │       ├── password-reset-request.dto.ts # NEW
│   │       └── password-reset-confirm.dto.ts # NEW
│   ├── users/
│   │   ├── entities/user.entity.ts           # extend: failedLoginAttempts, lockedUntil
│   │   └── users.service.ts                  # extend: lockout read/update helpers
│   ├── settings/
│   │   └── guards/admin.guard.ts             # replace placeholder with real session+role check
│   └── rbac/
│       ├── roles.controller.ts               # add SessionAuthGuard alongside PermissionGuard
│       ├── permissions.controller.ts         # add SessionAuthGuard alongside PermissionGuard
│       └── grants.controller.ts              # add SessionAuthGuard alongside PermissionGuard
└── database/
    └── migrations/
        └── <timestamp>-AuthLogin.migration.ts # NEW — sessions, login_challenges,
                                                 #       password_reset_challenges,
                                                 #       login_audit_events, users columns

test/
├── auth-login.e2e-spec.ts                    # NEW
└── support/
    └── rbac-test-auth.module.ts              # superseded by real SessionAuthGuard in e2e setup
                                                 # once available; retained only if still needed
                                                 # for RBAC-only fixtures that don't exercise login
```

## Complexity Tracking

*No entries — no Constitution Check violations.*
