---

description: "Task list for User Registration implementation"
---

# Tasks: User Registration

**Input**: Design documents from `/specs/001-user-registration/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/registration-api.openapi.yaml, quickstart.md

**Tests**: Included. Constitution IV and `quickstart.md` require Jest unit tests (`*.spec.ts`) plus Supertest e2e covering P1/P2/P3 paths and anti-enumeration. Tests are written after the code they cover (not TDD-first).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- NestJS backend at repository root: `src/`, `test/`
- Domain: `src/modules/`; infrastructure: `src/core/`

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add libraries and local operator tooling required by registration

- [X] T001 Install `bcryptjs`, `@types/bcryptjs`, `nodemailer`, `@types/nodemailer`, and `@nestjs/swagger` in `package.json`
- [X] T002 [P] Add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `APP_BASE_URL`, and `CORS_ORIGINS` to `.env.example`
- [X] T003 [P] Add a Mailpit sidecar (SMTP `1025`, UI `8025`) to `docker-compose.yml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config, persistence, email, hashing, module wiring, and OpenAPI bootstrap that every story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Add `SMTP_*`, `APP_BASE_URL`, and `CORS_ORIGINS` fields to `src/core/config/config.types.ts`
- [X] T005 [P] Add Joi rules for `SMTP_*`, `APP_BASE_URL`, and `CORS_ORIGINS` in `src/core/config/config.validation.ts`
- [X] T006 Replace hard-coded CORS origins with `CORS_ORIGINS` from `ConfigService` (comma-separated; keep localhost defaults when unset) in `src/main.ts`
- [X] T007 [P] Create `User` entity (`citext` email, `status` enum, `password_hash`, `pending_expires_at`, `confirmed_at`, indexes) in `src/modules/users/entities/user.entity.ts`
- [X] T008 [P] Create singleton `SystemSettings` entity (`id = 1`, confirmation flags, password policy) in `src/modules/settings/entities/system-settings.entity.ts`
- [X] T009 [P] Create `ConfirmationChallenge` entity (hashed OTP/link, attempts, expiry, invalidate/consume) in `src/modules/auth/entities/confirmation-challenge.entity.ts`
- [X] T010 [P] Create `RegistrationAuditEvent` entity (event types, outcome, no secrets) in `src/modules/auth/entities/registration-audit-event.entity.ts`
- [X] T011 Write migration enabling `citext`, creating the four tables with indexes, and seeding `system_settings` (`id=1`, confirmation off, min length 8) in `src/database/migrations/1756730000000-UserRegistration.migration.ts`
- [X] T012 [P] Implement Nodemailer SMTP `EmailService` and `EmailModule` in `src/core/email/email.service.ts` and `src/core/email/email.module.ts`
- [X] T013 [P] Implement bcryptjs password hasher (cost factor 12) in `src/modules/auth/utils/password-hasher.ts`
- [X] T014 [P] Implement password policy validator (min length 8; optional uppercase/digit/special from settings) in `src/modules/settings/password-policy.validator.ts`
- [X] T015 Implement `UsersService` (`findByNormalizedEmail`, create active/pending, activate) and register TypeORM in `src/modules/users/users.service.ts` and `src/modules/users/users.module.ts`
- [X] T016 Implement `SettingsService.getSettings()` for the singleton row and export `SettingsModule` in `src/modules/settings/settings.service.ts` and `src/modules/settings/settings.module.ts`
- [X] T017 Implement append-only `RegistrationAuditService` (never log password, OTP, or link secret) in `src/modules/auth/registration-audit.service.ts`
- [X] T018 Scaffold `AuthController`, `AuthService`, and `AuthModule` (import `UsersModule`, `SettingsModule`, `EmailModule`, TypeORM entities) in `src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.service.ts`, and `src/modules/auth/auth.module.ts`
- [X] T019 Import `AuthModule`, `SettingsModule`, and `EmailModule` in `src/core/app/app.module.ts`
- [X] T020 Serve Swagger UI at `/api/docs` (always in development; gated in production) in `src/main.ts`
- [X] T021 [P] Create placeholder `AdminGuard` with a documented TODO for real admin auth in `src/modules/settings/guards/admin.guard.ts`
- [X] T022 [P] Add unit tests for the hasher in `src/modules/auth/utils/password-hasher.spec.ts`
- [X] T023 [P] Add unit tests for password policy in `src/modules/settings/password-policy.validator.spec.ts`
- [X] T024 [P] Add `EmailService` unit tests with an SMTP test double in `src/core/email/email.service.spec.ts`

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 - Register without email confirmation (Priority: P1) 🎯 MVP

**Goal**: A guest submits a valid email and password while registration confirmation is disabled; a usable (`active`) account is created and no confirmation email is sent.

**Independent Test**: With confirmation off (default seed), `POST /auth/register` with a new email creates `users.status = active`; a second submit for the same email does not create another account and does not reveal that the email exists.

### Implementation for User Story 1

- [X] T025 [P] [US1] Create `RegisterRequestDto` and `RegisterResponseDto` in `src/modules/auth/dto/register-request.dto.ts` and `src/modules/auth/dto/register-response.dto.ts`
- [X] T026 [P] [US1] Implement trim + lowercase email normalizer in `src/modules/auth/utils/email-normalizer.ts`
- [X] T027 [US1] Implement `AuthService.register()` for confirmation-off: validate email/password, hash, create `active` user with `confirmed_at`, generic anti-enumeration on duplicate usable email, write audit events in `src/modules/auth/auth.service.ts`
- [X] T028 [US1] Implement `POST /auth/register` with DTO validation, `@Throttle()` 5 req/min/IP, and Swagger decorators in `src/modules/auth/auth.controller.ts`
- [X] T029 [P] [US1] Add email-normalizer unit tests (case, surrounding spaces) in `src/modules/auth/utils/email-normalizer.spec.ts`
- [X] T030 [P] [US1] Add `UsersService` unit tests in `src/modules/users/users.service.spec.ts`
- [X] T031 [US1] Add `AuthService` unit tests for confirmation-off success, invalid email/password, and duplicate email in `src/modules/auth/auth.service.spec.ts`
- [X] T032 [US1] Add e2e Scenario 1 (usable account, no Mailpit mail, duplicate anti-enumeration) in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: User Story 1 is fully functional and testable independently (MVP)

---

## Phase 4: User Story 6 - Administrator controls confirmation per scenario (Priority: P2)

**Goal**: An administrator can read and update independent confirmation flags (registration, password recovery, sign-in) and password-policy fields; only the registration flag affects this feature.

**Independent Test**: Toggle password-recovery or sign-in flags and register; behavior still follows the registration flag. Toggle registration confirmation and a new registration follows US1 vs US2.

### Implementation for User Story 6

- [X] T033 [P] [US6] Create `ConfirmationPolicyResponseDto` and `UpdateConfirmationPolicyRequestDto` in `src/modules/settings/dto/confirmation-policy-response.dto.ts` and `src/modules/settings/dto/update-confirmation-policy-request.dto.ts`
- [X] T034 [US6] Implement `SettingsService.updateConfirmationPolicy()` persisting independent flags without activating existing pending users in `src/modules/settings/settings.service.ts`
- [X] T035 [US6] Implement `GET` and `PATCH /admin/settings/confirmation-policy` with `AdminGuard` and Swagger in `src/modules/settings/settings.controller.ts`
- [X] T036 [US6] Register `SettingsController` and `AdminGuard` in `src/modules/settings/settings.module.ts`
- [X] T037 [US6] Add `SettingsService` unit tests for independent flags and password-policy fields in `src/modules/settings/settings.service.spec.ts`
- [X] T038 [US6] Add e2e Scenario 6 (recovery/sign-in flags do not change registration) in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: Admin can switch registration confirmation; US1 still works with the flag off

---

## Phase 5: User Story 2 - Register with email confirmation (Priority: P2)

**Goal**: When registration confirmation is enabled, `POST /auth/register` creates a `pending_confirmation` user, tells the guest confirmation is required, and sends an email with a 6-digit OTP and a magic link.

**Independent Test**: Enable the registration flag, register a new email, verify `status = pending_confirmation`, Mailpit has OTP + link, and no second account is created for a usable duplicate email.

### Implementation for User Story 2

- [X] T039 [P] [US2] Implement OTP (`crypto.randomInt` 6 digits) and magic-link token (`crypto.randomBytes(32)` base64url) with SHA-256 hashes in `src/modules/auth/utils/confirmation-token.ts`
- [X] T040 [US2] Implement `ConfirmationChallengeService` (one active challenge per pending user; insert new / set `invalidated_at` on previous) in `src/modules/auth/confirmation-challenge.service.ts`
- [X] T041 [US2] Implement confirmation email body (OTP + `{APP_BASE_URL}/auth/register/confirm/link?token=`) via `EmailService` in `src/modules/auth/confirmation-mail.service.ts`
- [X] T042 [US2] Extend `AuthService.register()` for confirmation-on: pending user, `pending_expires_at` +24h, create challenge, send mail, `confirmationRequired: true`; enforce 5 confirmation emails per email per 10 minutes via audit counts; skip confirmation work when the registration flag is off in `src/modules/auth/auth.service.ts`
- [X] T043 [P] [US2] Implement lazy delete of pending users whose `pending_expires_at` has passed so the email can be reused in `src/modules/users/users.service.ts`
- [X] T044 [P] [US2] Add confirmation-token unit tests in `src/modules/auth/utils/confirmation-token.spec.ts`
- [X] T045 [US2] Add `AuthService` unit tests for confirmation-on success and no-mail on invalid input in `src/modules/auth/auth.service.spec.ts`
- [X] T046 [US2] Add e2e Scenario 2 (pending user + Mailpit OTP and link) in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: User Stories 1, 6, and 2 work independently; confirmation path is started but not completable until US3/US4

---

## Phase 6: User Story 3 - Confirm registration with a one-time code (Priority: P3)

**Goal**: Guest submits the 6-digit OTP; a valid unexpired code within 5 attempts activates the account in one transaction.

**Independent Test**: Complete a confirmation-required registration, submit the correct code, verify `status = active`. Wrong, expired, and 6th attempts leave the account unusable.

### Implementation for User Story 3

- [X] T047 [P] [US3] Create `ConfirmCodeRequestDto` in `src/modules/auth/dto/confirm-code-request.dto.ts`
- [X] T048 [US3] Implement `AuthService.confirmByCode()` (`@Transactional()`): verify hash, decrement `attempts_remaining`, reject expired/locked/consumed/invalidated, activate user, consume challenge, audit; generic client errors (FR-015) in `src/modules/auth/auth.service.ts`
- [X] T049 [US3] Implement `POST /auth/register/confirm/code` with Swagger in `src/modules/auth/auth.controller.ts`
- [X] T050 [US3] Add unit tests for OTP success, wrong code, expiry, 5-attempt lock, and already-confirmed in `src/modules/auth/auth.service.spec.ts`
- [X] T051 [US3] Add e2e Scenario 3 in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: OTP confirmation independently completes the confirmation-required path

---

## Phase 7: User Story 4 - Confirm registration with an email link (Priority: P3)

**Goal**: Guest opens the magic link; a valid unexpired unused token activates the account. Reused, expired, or tampered tokens fail closed.

**Independent Test**: Start confirmation-required registration, open the valid link, verify `status = active`. Re-open the same link and use an expired/tampered token without activating a second account.

### Implementation for User Story 4

- [X] T052 [US4] Implement `AuthService.confirmByLink()` (`@Transactional()`): lookup by `link_token_hash`, reject expired/consumed/invalidated/tampered, activate user; already-confirmed and code-then-link (or reverse) must not create another account in `src/modules/auth/auth.service.ts`
- [X] T053 [US4] Implement `GET /auth/register/confirm/link?token=` with Swagger in `src/modules/auth/auth.controller.ts`
- [X] T054 [US4] Add unit tests for valid, expired, reused, and tampered links in `src/modules/auth/auth.service.spec.ts`
- [X] T055 [US4] Add e2e Scenario 4 in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: Either OTP or magic link independently activates the pending account

---

## Phase 8: User Story 5 - Resend registration confirmation (Priority: P4)

**Goal**: Guest can request a new confirmation email at most once per 60 seconds; a resend invalidates previous OTP and link; no mail when confirmation is off or no pending registration exists.

**Independent Test**: Resend after ≥ 60 s sends a new Mailpit message and old codes/links fail. Resend sooner returns 429 / wait message with no extra email.

### Implementation for User Story 5

- [X] T056 [P] [US5] Create `ResendRequestDto` and `ResendResponseDto` in `src/modules/auth/dto/resend-request.dto.ts` and `src/modules/auth/dto/resend-response.dto.ts`
- [X] T057 [US5] Implement `AuthService.resendConfirmation()`: 60 s `last_sent_at` gate, email-cap check, invalidate previous challenge, issue new OTP/link, send mail; anti-enumeration when confirmation is off or no pending user; treat same-email re-register of a pending row as the resend-limited path (no second user) in `src/modules/auth/auth.service.ts`
- [X] T058 [US5] Implement `POST /auth/register/resend` with `@Throttle()` 1 req/60 s/IP and Swagger in `src/modules/auth/auth.controller.ts`
- [X] T059 [US5] Add unit tests for interval, invalidation of old tokens, disabled confirmation, and missing pending user in `src/modules/auth/auth.service.spec.ts`
- [X] T060 [US5] Add e2e Scenario 5 in `test/auth-registration.e2e-spec.ts`

**Checkpoint**: All user stories are independently functional

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Residual e2e gaps, controller tests, contract alignment, and quality gates

- [X] T061 Replace the obsolete `Hello World` assertion with a health-check (or delete the unused case) in `test/app.e2e-spec.ts`
- [X] T062 [P] Add `AuthController` unit tests in `src/modules/auth/auth.controller.spec.ts`
- [X] T063 [P] Add `SettingsController` unit tests in `src/modules/settings/settings.controller.spec.ts`
- [X] T064 Add e2e Scenario 7 (HTTP 429 and max 5 confirmation emails per email per 10 minutes) in `test/auth-registration.e2e-spec.ts`
- [X] T065 Add `RegistrationAuditService` unit tests proving passwords/OTP/link secrets are never stored in `src/modules/auth/registration-audit.service.spec.ts`
- [X] T066 Align Swagger decorators on `src/modules/auth/auth.controller.ts` and `src/modules/settings/settings.controller.ts` with `specs/001-user-registration/contracts/registration-api.openapi.yaml`
- [X] T067 Run `npm run format`, `npm run lint`, `npm run test`, and `npm run test:e2e`, then walk through `specs/001-user-registration/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS** all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — uses default `registration_confirmation_enabled = false`
- **User Story 6 (Phase 4)**: Depends on Foundational — independently testable; unblocks toggling US2
- **User Story 2 (Phase 5)**: Depends on Foundational + US6 (to turn confirmation on) + US1 register endpoint
- **User Story 3 (Phase 6)**: Depends on US2 (pending user + issued OTP)
- **User Story 4 (Phase 7)**: Depends on US2 (pending user + issued link); independent of US3
- **User Story 5 (Phase 8)**: Depends on US2; independent of US3/US4
- **Polish (Phase 9)**: Depends on all desired user stories

### User Story Dependencies

- **User Story 1 (P1)**: After Foundational — no other stories
- **User Story 6 (P2)**: After Foundational — no other stories (parallel with US1)
- **User Story 2 (P2)**: After US6 (flag on) and US1 (`POST /auth/register`)
- **User Story 3 (P3)**: After US2 — OTP confirm
- **User Story 4 (P3)**: After US2 — magic-link confirm (parallel with US3)
- **User Story 5 (P4)**: After US2 — resend (parallel with US3/US4)

### Within Each User Story

- DTOs / utils before services
- Services before controllers
- Story implementation before that story’s unit and e2e tests
- Story complete before moving to the next priority (unless staffing parallel stories)

### Parallel Opportunities

- Phase 1: T002 and T003
- Phase 2: T004/T005; T007–T010; T012–T014; T022–T024
- After Foundational: US1 and US6 in parallel
- After US2: US3, US4, and US5 in parallel
- Within US1: T025/T026; T029/T030
- Within US2: T039 and T043; T044 in parallel with T043

---

## Parallel Example: User Story 1

```bash
# After Foundational, launch DTO + normalizer together:
Task: "Create RegisterRequestDto and RegisterResponseDto in src/modules/auth/dto/register-request.dto.ts and src/modules/auth/dto/register-response.dto.ts"
Task: "Implement trim + lowercase email normalizer in src/modules/auth/utils/email-normalizer.ts"

# After AuthService.register() exists, launch unit tests together:
Task: "Add email-normalizer unit tests in src/modules/auth/utils/email-normalizer.spec.ts"
Task: "Add UsersService unit tests in src/modules/users/users.service.spec.ts"
```

## Parallel Example: User Stories 3–5 (after US2)

```bash
Task: "Implement AuthService.confirmByCode() in src/modules/auth/auth.service.ts"          # US3
Task: "Implement AuthService.confirmByLink() in src/modules/auth/auth.service.ts"          # US4 — sequential with US3 if same file; otherwise staff separately after merge
Task: "Implement AuthService.resendConfirmation() in src/modules/auth/auth.service.ts"     # US5 — same-file conflict: run US3 → US4 → US5 sequentially on auth.service.ts
```

> **Note**: US3, US4, and US5 all extend `src/modules/auth/auth.service.ts` and `src/modules/auth/auth.controller.ts`. Parallelize across developers only if work is merged carefully; otherwise implement US3 then US4 then US5 sequentially. DTO files (T047, T056) can still be created in parallel.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: `POST /auth/register` with confirmation off; run `test/auth-registration.e2e-spec.ts` Scenario 1
5. Demo/ship MVP (accounts immediately usable; no mail required)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → independently testable MVP
3. US6 → admin can toggle confirmation
4. US2 → pending registration + confirmation email
5. US3 → OTP confirm
6. US4 → magic-link confirm
7. US5 → resend
8. Polish → rate-limit e2e, Swagger alignment, quality gates

### Parallel Team Strategy

1. Team completes Setup + Foundational together
2. Developer A: US1; Developer B: US6
3. After US6: Developer A: US2
4. After US2: split US3 / US4 / US5 only if `auth.service.ts` ownership is coordinated; otherwise one developer finishes confirm + resend sequentially

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to spec user stories (US1–US6)
- Default seed keeps registration confirmation **off**, so US1 does not need US6
- Pending users stay pending when the admin turns confirmation off (US6 acceptance #4)
- Client responses never reveal email existence (FR-015); operators use `registration_audit_events`
- Sign-in/session issuance is out of scope — “usable” means `users.status = active`
- Commit after each task or logical group
- Stop at any checkpoint to validate the story independently
