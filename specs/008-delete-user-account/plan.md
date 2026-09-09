# Implementation Plan: Delete User Account

**Branch**: `008-delete-user-account` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-delete-user-account/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add self-service account deletion (email-confirmed, following the existing email-change
confirmation pattern) and admin-direct account deletion (permission-gated) to the existing
`UsersModule`. Both paths converge on one shared, transactional deletion procedure that atomically
claims the target row (to make repeat/concurrent requests idempotent-or-conflicting per FR-010/
FR-011), removes the user's owned photo file and personal-data row, and leaves already-PII-free
audit tables untouched for traceability, except redacting the plaintext email already stored on
pre-existing `login_audit_events`/`registration_audit_events` rows for the target user (see
data-model.md). A new `users`/`delete` permission action gates the admin
path; a new `AccountDeletionChallenge` entity (mirroring `EmailChangeChallenge`) drives the
self-service confirmation; a new `AccountDeletionAuditEvent` entity (mirroring `ProfileAuditEvent`)
records every attempt without PII. No new architectural patterns are introduced — every mechanism
reuses a directly analogous existing one (see [research.md](./research.md)).

## Technical Context

**Language/Version**: TypeScript (NestJS 11)

**Primary Dependencies**: NestJS 11 on Fastify, TypeORM + PostgreSQL, `typeorm-transactional`,
`@nestjs/throttler`, `@nestjs/swagger`, `class-validator`/`class-transformer`, existing
`EmailService` (`src/core/email`), existing `LocalFileStorageService` (`src/core/storage`),
existing `AccessConfigService` (`src/modules/rbac`)

**Storage**: PostgreSQL via TypeORM; local-disk file storage for the profile photo asset
(`ASSETS_DIR`, via `LocalFileStorageService`)

**Testing**: Jest unit tests (`*.spec.ts`) colocated with source; Supertest e2e tests
(`test/*.e2e-spec.ts`) against the isolated e2e test database (`test/setup-e2e.ts`)

**Target Platform**: Linux server (existing backend deployment)

**Project Type**: Single NestJS backend service (this repository)

**Performance Goals**: No new goals beyond existing route latency norms; deletion is a single
synchronous transaction, not a background job (per spec Assumptions)

**Constraints**: Self-deletion confirmation must reuse the existing 10-minute expiry / 5-attempt /
60-second resend-cooldown constants (`src/modules/auth/utils/confirmation-token.ts`); no PII may
ever be written to audit rows; deletion must not rely on any session-revocation mechanism beyond
the existing stateless-JWT + live-user-lookup guard (no new session store)

**Scale/Scope**: One new controller-route group (4 routes) on the existing `UsersController`, two
new entities/tables, one new service pair (deletion + its audit service), one migration — scoped
entirely within `src/modules/users/` plus a small addition to `src/database/migrations/`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Modular Architecture | New code lives in the existing `UsersModule` (`src/modules/users/`); business logic in a new `AccountDeletionService`, HTTP concerns stay in `UsersController`; no cross-module bypass — reuses `StorageModule`, `RbacModule` (via `AccessConfigService`), `AuthModule`'s `confirmation-token.ts` util and `ConfirmationMailService`, all already imported by `UsersModule` | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | New DTO for the confirm-code body uses `class-validator`; all 4 new routes get `@Throttle`; admin route enforces the `users`/`delete` permission before any mutation; self routes always act only on `request.user.id` (no attacker-controlled target) | PASS |
| III. Database Performance & Integrity | New tables get purpose-built indexes (partial unique on active challenge, actor+createdAt on audit); the claim-and-delete sequence runs inside `@Transactional()`; schema changes via a new versioned migration, no `synchronize` | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | Plan requires new unit tests for `AccountDeletionService`/`AccountDeletionAuditService` and a new `test/account-deletion.e2e-spec.ts` covering all acceptance scenarios (see [quickstart.md](./quickstart.md)) — to be produced by `/speckit-tasks` + implementation, not by this planning phase | PASS (planned) |
| V. Observability & API Documentation | Every new route gets full `@Api*Response` Swagger decorators matching existing route density; deletion attempts are logged via the new audit service (best-effort, non-blocking, matching `UsersService.recordAudit`); no PII in logs or audit rows | PASS |

No violations requiring justification — Complexity Tracking section is empty/omitted.

## Project Structure

### Documentation (this feature)

```text
specs/008-delete-user-account/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
├── contracts/            # Phase 1 output (/speckit-plan command)
│   └── account-deletion-api.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

This is a single NestJS backend project (no separate frontend in this repo); all changes are
additive within the existing `src/modules/users/` feature module and `src/database/migrations/`.

```text
backend/                                    # repository root (this repo IS the backend)
├── src/
│   ├── modules/
│   │   └── users/
│   │       ├── entities/
│   │       │   ├── account-deletion-challenge.entity.ts       # NEW
│   │       │   └── account-deletion-audit-event.entity.ts     # NEW
│   │       ├── dto/
│   │       │   └── confirm-account-deletion.dto.ts            # NEW
│   │       ├── account-deletion.service.ts                    # NEW
│   │       ├── account-deletion.service.spec.ts               # NEW
│   │       ├── account-deletion-audit.service.ts               # NEW
│   │       ├── account-deletion-audit.service.spec.ts          # NEW
│   │       ├── users.controller.ts                             # MODIFIED (+4 routes)
│   │       ├── users.module.ts                                 # MODIFIED (register new providers/repos)
│   │       └── users.service.ts                                # UNCHANGED (existing deleteUser/toRelativeAssetPath reused)
│   └── database/
│       └── migrations/
│           └── 1760200000000-AccountDeletion.migration.ts      # NEW
└── test/
    └── account-deletion.e2e-spec.ts                             # NEW
```

**Structure Decision**: Single-project NestJS backend (matches the repository's existing
`src/modules/` + `src/core/` + `src/database/migrations/` + `test/` layout). All new code is
added to the existing `users` feature module rather than a new module — deletion is a lifecycle
operation on the same `User` entity/aggregate that `UsersModule` already owns, and every
dependency it needs (`StorageModule`, `RbacModule`, `AuthModule`'s mail/token utilities) is
already imported there.

## Complexity Tracking

*No violations — table omitted.*
