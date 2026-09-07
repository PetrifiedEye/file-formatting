# Implementation Plan: View User Profile

**Branch**: `005-view-user-profile` | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-view-user-profile/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add `GET /users/:userId` to return a user's profile, gated by identity and RBAC:
a caller always gets their own full profile; a caller holding `users:read` gets a
restricted field set (`id`, `photo`) for another user; anyone else is denied (403)
without disclosing target existence. Unauthenticated requests get 401 before any
lookup. The access decision is made in application code (not declaratively via
`PermissionGuard`) because "self" must bypass the permission check entirely, and
the field set differs by access level. A new `users` RBAC permission (action
`read`) and a `photo_url` column on `users` are required — neither exists yet.

## Technical Context

**Language/Version**: TypeScript 5 / Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (Fastify), TypeORM, `@nestjs/throttler`, `@nestjs/swagger`, `class-validator`

**Storage**: PostgreSQL via TypeORM — reuses `users` table; adds one nullable `photo_url` column via migration; reuses `rbac` tables (`permissions`, `grants`) to seed a new `users:read` permission

**Testing**: Jest (unit, `*.spec.ts`), Supertest e2e (`test/*.e2e-spec.ts`)

**Target Platform**: Linux server (containerized Node backend)

**Project Type**: Single backend project (existing NestJS repo; no frontend/mobile counterpart in scope)

**Performance Goals**: No new goal beyond existing per-request throttling; endpoint is a single indexed PK lookup

**Constraints**: 401 MUST be evaluated before any user-existence/permission check; default-deny field filtering; no IDOR (self vs `users:read` vs deny must be indistinguishable in timing/response shape to the extent existing patterns allow); rate limiting MUST cover reads (no existing per-route `@Throttle` precedent — global throttler applies, override only if product wants a stricter limit than global default)

**Scale/Scope**: One new endpoint, one new module controller, one new migration (permission seed + column), optional audit trail

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Modular Architecture** — PASS. Feature adds a `UsersController` inside the existing `src/modules/users/` module (service/entity already live there); no cross-module bypass — RBAC decision goes through `AccessConfigService` (public service of `RbacModule`), auth via `JwtAuthGuard` (public of `AuthModule`).
- **II. Input Validation & Security (NON-NEGOTIABLE)** — PASS. `userId` path param is a UUID; validated via `ParseUUIDPipe` (malformed → treated as not-found per spec, so pipe failure is mapped to 404, not a validation 400). Rate limiting: global `ThrottlerGuard` already applies to all routes; plan does not need a bespoke mechanism, satisfying FR-007 by inheritance.
- **III. Database Performance & Integrity** — PASS. Single lookup by primary key (`id`), already indexed (PK). New `photo_url` column is nullable, no backfill needed. Migration follows existing timestamp-prefixed convention in `src/database/migrations/`.
- **IV. Test Coverage (NON-NEGOTIABLE)** — PASS (planned). Unit tests for `UsersService` field-filtering logic and `UsersController`/guard interaction; e2e test `test/users-profile.e2e-spec.ts` covering all 4 P1/P2 stories (self, privileged, denied, 401/404).
- **V. Observability & API Documentation** — PASS (planned). Swagger DTOs (`@ApiProperty`) for two response shapes (self vs privileged) or one DTO with optional fields; audit logging follows the existing per-domain audit pattern (new `UsersAuditService` + `UserProfileAuditEvent` entity, mirroring `LoginAuditService`), satisfying FR-010 (best-effort, does not block response).

No violations requiring justification — Complexity Tracking is not filled.

## Project Structure

### Documentation (this feature)

```text
specs/005-view-user-profile/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── users/
│   │   ├── entities/
│   │   │   └── user.entity.ts               # MODIFY: add photoUrl column
│   │   ├── dto/
│   │   │   └── user-profile-response.dto.ts  # NEW: self/privileged response shape
│   │   ├── users.controller.ts               # NEW: GET /users/:userId
│   │   ├── users.controller.spec.ts           # NEW
│   │   ├── users.service.ts                   # MODIFY: add getProfileFor(viewer, targetId)
│   │   ├── users.service.spec.ts               # MODIFY
│   │   ├── users-audit.service.ts              # NEW: profile-view audit trail
│   │   ├── users-audit.service.spec.ts          # NEW
│   │   ├── entities/
│   │   │   └── user-profile-audit-event.entity.ts  # NEW
│   │   └── users.module.ts                     # MODIFY: register controller + audit service/entity
│   ├── auth/                                    # (unchanged) JwtAuthGuard reused as-is
│   └── rbac/                                    # (unchanged) AccessConfigService.hasPermission reused as-is
└── database/
    └── migrations/
        └── <timestamp>-UsersProfile.migration.ts  # NEW: add users.photo_url column + seed 'users' permission (action 'read')

test/
└── users-profile.e2e-spec.ts   # NEW: self / privileged / denied / 401 / 404 coverage
```

**Structure Decision**: Single existing backend project (`src/modules/`, `src/core/`, `src/database/migrations/`, `test/`). No new top-level project or module — the feature extends the existing (controller-less) `users` module, following the constitution's Modular Architecture principle.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
