# Implementation Plan: User Profile Update

**Branch**: `006-user-profile-update` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-user-profile-update/spec.md`

## Summary

Extend the existing `users` module with: (1) a self/admin profile-update endpoint limited to the profile photo, backed by new local disk-based asset storage served statically at `/assets`; (2) a self-service email-change flow reusing the codebase's existing OTP/magic-link confirmation primitives (`src/modules/auth/utils/confirmation-token.ts`) via a new `EmailChangeChallenge` entity and `EmailChangeService`, following the `PasswordResetService` pattern; (3) an admin-only direct email-update endpoint gated by a new `users:update-email` RBAC permission action; (4) a new `ProfileAuditEvent` table recording every update/email-change lifecycle event (field names only, never values), written best-effort exactly like the existing `UsersAuditService` pattern. All new routes sit under `@nestjs/throttler` per-route limits mirroring existing `auth.controller.ts` thresholds.

## Technical Context

**Language/Version**: TypeScript 5.7, Node.js (NestJS 11)

**Primary Dependencies**: NestJS 11 (`@nestjs/platform-fastify`), TypeORM 0.3 + PostgreSQL, `@nestjs/throttler`, `@nestjs/swagger`, `class-validator`/`class-transformer`, `typeorm-transactional`, `nodemailer` (via existing `EmailService`), new: `@fastify/multipart` (photo upload — not yet a dependency), existing but unused: `@fastify/static` (photo serving)

**Storage**: PostgreSQL (new tables `email_change_challenges`, `profile_audit_events`; existing `users.photo_url`/`users.email` reused); local filesystem under `ASSETS_DIR` for photo binaries

**Testing**: Jest unit specs (`*.spec.ts` colocated with source), Supertest e2e specs under `test/*.e2e-spec.ts`

**Target Platform**: Linux server (containerized NestJS/Fastify backend)

**Project Type**: Single backend service (this repo)

**Performance Goals**: No new domain-specific throughput target beyond existing per-route rate limits (see [research.md § R7](./research.md#r7-rate-limiting-thresholds)); photo upload capped at `PHOTO_MAX_SIZE_BYTES` (default 5MB) to bound request latency and disk I/O.

**Constraints**: Email-change confirmation TTL 10 min, max 5 wrong attempts, 60s resend cooldown (spec Assumptions, matches existing `CONFIRMATION_TTL_MS`/`RESEND_INTERVAL_MS`); photo uploads: JPEG/PNG/WebP only, magic-number validated, size-capped; all field-level access default-deny (FR-022); audit writes never block or fail the primary request (FR-020 + existing best-effort convention).

**Scale/Scope**: 5 new/changed HTTP endpoints, 2 new entities + 1 new migration set, 1 new shared storage module, no new external services.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Modular Architecture | New capability extends the existing `users` module (controller/service split preserved); new generic file-storage infra placed under `src/core/storage/`, not inside a feature module; no circular imports — `users` already `forwardRef`s `auth` and `rbac`, new `EmailChangeService` reuses `auth`'s pure utility functions (no new service-to-service coupling) | PASS |
| II. Input Validation & Security (NON-NEGOTIABLE) | All new request bodies get `class-validator` DTOs (`InitiateEmailChangeDto`, `ConfirmEmailChangeDto`, `AdminUpdateEmailDto`); photo upload validated by size limit + magic-number sniffing, never trusting client `Content-Type`; every new route rate-limited via `@Throttle`; RBAC enforced via `AccessConfigService.hasPermission` (default-deny, FR-022) | PASS |
| III. Database Performance & Integrity | New tables get purpose-built indexes (partial unique "one active challenge per user", audit `(actor_id, created_at)`); `EmailChangeService.confirm` uses `@Transactional()` like `PasswordResetService.confirmReset`; schema changes via versioned migrations, `POSTGRES_SYNCHRONIZE` untouched | PASS |
| IV. Test Coverage (NON-NEGOTIABLE) | New unit specs for `EmailChangeService`, `ProfileAuditService`, `LocalFileStorageService`, updated `UsersService`; e2e coverage extends `test/users-profile.e2e-spec.ts` conventions (see [quickstart.md](./quickstart.md#automated-coverage)) | PASS (tracked in tasks.md, not yet written) |
| V. Observability & API Documentation | Every new controller method gets Swagger decorators (`@ApiOperation`, `@ApiOkResponse`, `@ApiForbiddenResponse`, etc.) matching `UsersController.getProfile` style; audit entries cover every mutation path; no secrets/file bytes logged | PASS |

No violations requiring justification — Complexity Tracking section intentionally left empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-user-profile-update/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/
│   └── users-profile-update.md
└── tasks.md              # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
backend/                                  # this repo (single NestJS service)
├── src/
│   ├── core/
│   │   ├── storage/                      # NEW — generic local file storage, shared infra
│   │   │   ├── local-file-storage.service.ts
│   │   │   ├── local-file-storage.service.spec.ts
│   │   │   └── storage.module.ts
│   │   └── config/
│   │       ├── config.types.ts           # MODIFIED — ASSETS_DIR, ASSETS_BASE_URL, PHOTO_MAX_SIZE_BYTES
│   │       └── config.validation.ts      # MODIFIED — Joi rules for the above
│   ├── modules/
│   │   ├── users/
│   │   │   ├── entities/
│   │   │   │   ├── user.entity.ts                    # unchanged (photo_url/email already present)
│   │   │   │   ├── email-change-challenge.entity.ts  # NEW
│   │   │   │   └── profile-audit-event.entity.ts      # NEW
│   │   │   ├── dto/
│   │   │   │   ├── user-profile-response.dto.ts       # unchanged, reused
│   │   │   │   ├── initiate-email-change.dto.ts        # NEW
│   │   │   │   ├── confirm-email-change.dto.ts         # NEW
│   │   │   │   └── admin-update-email.dto.ts            # NEW
│   │   │   ├── users.controller.ts        # MODIFIED — add PATCH :userId, email-change routes, admin email route
│   │   │   ├── users.service.ts           # MODIFIED — add updatePhoto()
│   │   │   ├── email-change.service.ts    # NEW
│   │   │   ├── profile-audit.service.ts   # NEW
│   │   │   └── users.module.ts            # MODIFIED — register new entities/providers
│   │   ├── auth/
│   │   │   ├── utils/confirmation-token.ts  # unchanged, reused
│   │   │   └── confirmation-mail.service.ts # MODIFIED — add sendEmailChangeConfirmation()
│   │   └── rbac/                          # unchanged code; new migration adds grants
│   ├── database/migrations/
│   │   └── <timestamp>-EmailChangeAndProfileUpdate.migration.ts  # NEW
│   └── main.ts                            # MODIFIED — register @fastify/multipart, @fastify/static
└── test/
    └── users-profile-update.e2e-spec.ts   # NEW
```

**Structure Decision**: Single-project NestJS backend (this repo has no separate frontend in this codebase). All feature code stays inside the existing `src/modules/users/` module per Constitution Principle I; the only new top-level unit is `src/core/storage/`, justified because local file storage is generic infrastructure, not domain logic, matching how `src/core/email/` and `src/core/config/` are already organized.

## Complexity Tracking

*No entries — no Constitution Check violations.*
