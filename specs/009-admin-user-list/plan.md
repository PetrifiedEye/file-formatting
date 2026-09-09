# Implementation Plan: Admin User List

**Branch**: `009-admin-user-list` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-admin-user-list/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add `GET /users` as a cursor-paginated administrator directory of listable
accounts, gated by a new `users.list` RBAC action (granted to Admin by
default). Callers without that permission get 403 with no items;
unauthenticated requests get 401 before any lookup. Each item is an
allow-listed summary (`id`, `email`, `photo`, `createdAt`, `status`,
`lastLoginAt`). Search (email `ILIKE` / exact id), status filter
(`active` | `pending_confirmation`), and sort (`createdAt`, `lastLoginAt`,
`email`) compose with keyset pagination. A nullable `users.last_login_at`
column denormalizes existing login-audit history so last-sign-in sort meets
the 10k-row latency goal. Every attempt is audited without PII.

Technical approach is documented in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 / Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (Fastify), TypeORM, `@nestjs/throttler`,
`@nestjs/swagger`, `class-validator` / `class-transformer`, Node `crypto`
(HMAC cursors). No new runtime packages.

**Storage**: PostgreSQL via TypeORM — `users` gains `last_login_at`; new
table `user_directory_audit_events`; partial directory indexes; seed
`list` on the existing `users` permission and Admin grant. Photo URLs
reuse existing `photo_url` / `/assets` storage.

**Testing**: Jest unit (`*.spec.ts` colocated), Supertest e2e
(`test/users-directory.e2e-spec.ts`) against the isolated e2e database.

**Target Platform**: Linux server (containerized NestJS/Fastify backend)

**Project Type**: Single backend project (existing NestJS repo; no
frontend/mobile counterpart in scope)

**Performance Goals**: First page of the directory in under 2 seconds with
at least 10,000 listable accounts (SC-001), via indexed keyset queries
(not offset scans, not per-row login-audit aggregates).

**Constraints**: Always paginate (`limit` default 20, max 100); opaque
HMAC cursor; default-deny field allow-list; 401 before permission or data
access; `users.read` must not imply `users.list`; rate limit on the
collection route; audit writes are best-effort and contain no search text
or emails; `POSTGRES_SYNCHRONIZE` remains `false`.

**Scale/Scope**: One new collection endpoint; one new permission action;
one column + one audit table + indexes; small AuthService touch to stamp
`last_login_at` when tokens are issued.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research / post-design (unchanged — PASS)

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | Feature stays in `src/modules/users/` (`UsersController` HTTP-only; `UserDirectoryService` owns listing/keyset; existing `AccessConfigService` via `RbacModule` import). Auth stamp of `last_login_at` is a one-line update on the existing token-issue paths in `AuthService`, not a new cross-module bypass. No circular imports. | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | `ListUsersQueryDto` with `class-validator`; global `ValidationPipe` whitelist; HMAC-verified cursors; `JwtAuthGuard` then `users.list`; `@Throttle` on the collection route; default-deny response mapping; search wildcards escaped. CORS unchanged. | PASS |
| III. Database Performance & Integrity | Selective column list (no unbounded entity dump to the client). Partial indexes on `(created_at, id)`, `(email, id)`, `(last_login_at, id)` for listable rows (`deletion_started_at IS NULL`) — required for `ORDER BY` / keyset. `last_login_at` avoids sorting by a subquery on `login_audit_events`. Versioned migration; synchronize stays off. Directory read is a single SELECT (no multi-step write → no `@Transactional()` needed on the list path). Token-issue `last_login_at` update is a single-row UPDATE alongside existing login work. | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Unit tests for keyset, NULL sort, filters, allow-list, cursor HMAC/mismatch, audit best-effort. E2E `test/users-directory.e2e-spec.ts` covers US1–US5 (page/cursor, search/filter/sort, 403 vs `users.read`, 401, 400, audit without PII, 429). | PASS (planned) |
| V. Observability & API Documentation | Swagger on the new handler and DTOs (`@ApiTags('users')` already on the controller). Audit every attempt (success/denied/unauthenticated/invalid/rate_limited) without PII. Health endpoint unchanged. | PASS |

No violations. Complexity Tracking is not filled. The path-gated
`UserDirectoryAuditFilter` (research §11) is a new file but not a
constitution exception — it is the minimum way to record 401/429 required
by FR-018 without changing global guards.

## Project Structure

### Documentation (this feature)

```text
specs/009-admin-user-list/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── user-directory.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── users/
│   │   ├── dto/
│   │   │   ├── list-users-query.dto.ts           # NEW
│   │   │   ├── user-directory-item.dto.ts        # NEW
│   │   │   └── user-directory-page.dto.ts        # NEW
│   │   ├── entities/
│   │   │   ├── user.entity.ts                    # MODIFY: lastLoginAt
│   │   │   └── user-directory-audit-event.entity.ts  # NEW
│   │   ├── user-directory.service.ts             # NEW: query, keyset, cursor
│   │   ├── user-directory.service.spec.ts        # NEW
│   │   ├── user-directory-audit.service.ts       # NEW
│   │   ├── user-directory-audit.service.spec.ts  # NEW
│   │   ├── user-directory-audit.filter.ts        # NEW: 401/429 audit hook
│   │   ├── users.controller.ts                   # MODIFY: GET /users
│   │   ├── users.controller.spec.ts              # MODIFY or NEW
│   │   └── users.module.ts                       # MODIFY: register service/entity/filter
│   ├── auth/
│   │   └── auth.service.ts                       # MODIFY: stamp lastLoginAt on token issue
│   └── rbac/                                     # unchanged at runtime; migration updates
│                                                 # users permission actions + admin grant
└── database/
    └── migrations/
        └── 1760300000000-AdminUserList.migration.ts  # NEW

test/
└── users-directory.e2e-spec.ts   # NEW
```

**Structure Decision**: Single existing backend project (`src/modules/`,
`src/core/`, `src/database/migrations/`, `test/`). No new top-level
package. Listing is a distinct capability inside `UsersModule` (same
split as `AccountDeletionService` / `EmailChangeService`), not a new
Nest module.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
