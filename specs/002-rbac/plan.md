# Implementation Plan: Role-Based Access Control (RBAC)

**Branch**: `002-rbac` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-rbac/spec.md`

## Summary

Centralized RBAC: roles, permissions (each with allowed actions), and grants (role→permission,
optionally scoped to actions) are stored in PostgreSQL and loaded into an in-memory access
configuration at startup. Access checks (`hasPermission(user, permission, action)`) evaluate the
union of a user's roles against the cached configuration — no per-request DB query. Admins manage
roles, permissions, and grants via CRUD endpoints; any mutation invalidates the cache and triggers
a synchronous reload so subsequent checks see the new state within the same process. All
management operations and reload events are audit-logged. User↔role membership is modeled as a
join table (`user_roles`) so access checks can resolve a user's roles, but user-role CRUD endpoints
are out of scope per the spec's assumptions.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node.js), NestJS 11

**Primary Dependencies**: `@nestjs/common`, `@nestjs/typeorm`, `typeorm-transactional`,
`class-validator`/`class-transformer`, `@nestjs/swagger`

**Storage**: PostgreSQL via TypeORM (new tables: `roles`, `permissions`, `grants`, `user_roles`,
`rbac_audit_events`)

**Testing**: Jest unit tests (`*.spec.ts`) for services/guards/controllers; Supertest e2e for
CRUD + access-check HTTP contracts, per Constitution Principle IV

**Target Platform**: Linux server (existing Fastify-based NestJS backend)

**Project Type**: Web service (single NestJS backend, no frontend in this repo)

**Performance Goals**: Access checks are pure in-memory lookups (no DB round-trip); SC-001 requires
configuration changes to be visible within 5s (achieved synchronously — reload completes before the
mutating request returns, well under 5s)

**Constraints**: No application restart for configuration changes (FR-017/FR-018); consistent
snapshot during reload — no partial/mixed rules visible to concurrent checks (edge case in spec)

**Scale/Scope**: Admin-managed configuration (roles/permissions/grants counted in the tens to low
hundreds), evaluated on every protected request; 3 CRUD resource types + 1 cross-cutting guard

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Modular Architecture** — RBAC is implemented as `src/modules/rbac/` with its own controller(s)
  and services (`RolesService`, `PermissionsService`, `GrantsService`, `AccessConfigService`,
  `RbacAuditService`). Enforcement primitives (guard + decorator) are exported for other modules to
  consume. PASS.
- **II. Input Validation & Security** — All CRUD DTOs use `class-validator`; management endpoints
  are restricted to admins via a guard. No new unauthenticated/credential-bearing endpoints are
  introduced, so no new rate-limiting surface is required beyond the existing global throttler.
  PASS.
- **III. Database Performance & Integrity** — New tables get explicit indexes on lookup columns
  (`roles.name`, `permissions.name`, `grants(role_id, permission_id)` unique, `user_roles(user_id)`,
  `user_roles(role_id)`). Multi-step writes (e.g., grant validation against permission actions plus
  insert) use `@Transactional()`. Migrations are added under `src/database/migrations/`;
  `POSTGRES_SYNCHRONIZE` stays `false`. PASS.
- **IV. Test Coverage** — Unit tests for each service (including cache invalidation/reload logic and
  the permission-evaluation algorithm) and the guard; e2e tests for CRUD conflict/validation paths
  and for allow/deny access-check scenarios. PASS (planned, enforced at implementation/tasks phase).
- **V. Observability & API Documentation** — RBAC management operations and reload events are
  logged as audit records (data mutations) per Principle V; Swagger decorators added for all new
  endpoints/DTOs. PASS.

**Known gap surfaced by this feature (documented, not blocking)**: the codebase has no login/session
mechanism yet (`AuthModule` only covers registration/confirmation; `AdminGuard` is an explicit
placeholder that always allows). RBAC's guard therefore depends on a `request.user` shape
(`{ id, roles }`) that a future authentication feature must populate. This plan defines that
contract and provides a guard-compatible seam (see [research.md](./research.md), decision
"Current-user resolution seam") rather than building session/JWT auth, which is out of scope per
the spec's Assumptions.

## Project Structure

### Documentation (this feature)

```text
specs/002-rbac/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
│   └── rbac-api.md
└── tasks.md              # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/
├── core/                          # unchanged
├── modules/
│   ├── rbac/                      # NEW
│   │   ├── rbac.module.ts
│   │   ├── entities/
│   │   │   ├── role.entity.ts
│   │   │   ├── permission.entity.ts
│   │   │   ├── grant.entity.ts
│   │   │   ├── user-role.entity.ts
│   │   │   └── rbac-audit-event.entity.ts
│   │   ├── dto/
│   │   │   ├── create-role.dto.ts / update-role.dto.ts / role-response.dto.ts
│   │   │   ├── create-permission.dto.ts / update-permission.dto.ts / permission-response.dto.ts
│   │   │   └── create-grant.dto.ts / update-grant.dto.ts / grant-response.dto.ts
│   │   ├── roles.controller.ts / roles.service.ts
│   │   ├── permissions.controller.ts / permissions.service.ts
│   │   ├── grants.controller.ts / grants.service.ts
│   │   ├── access-config.service.ts    # in-memory cache, load/reload, hasPermission()
│   │   ├── rbac-audit.service.ts
│   │   ├── guards/
│   │   │   ├── admin.guard.ts          # real replacement for settings' placeholder (or shared)
│   │   │   └── permission.guard.ts     # reads @RequirePermission metadata, calls AccessConfigService
│   │   └── decorators/
│   │       └── require-permission.decorator.ts
│   └── users/, auth/, settings/       # unchanged, existing
└── database/migrations/
    └── <timestamp>-Rbac.migration.ts  # NEW: roles, permissions, grants, user_roles, rbac_audit_events

tests/ (co-located *.spec.ts) + e2e specs under existing e2e project
```

**Structure Decision**: Single NestJS backend (existing repo layout). RBAC lands as one new
top-level module under `src/modules/rbac/`, following the same controller/service/entity/dto split
used by `auth` and `settings`. `AccessConfigService` and the guard/decorator pair are the only
pieces other modules are expected to import (via `RbacModule` exports), keeping the module boundary
explicit per Principle I.

## Complexity Tracking

*No constitution violations requiring justification.*
