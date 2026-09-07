---

description: "Task list for User Login & Session Authentication"

---

# Tasks: User Login & Session Authentication

**Input**: Design documents from `/specs/003-auth-login/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auth-api.md, quickstart.md

**Tests**: Included — plan.md Constitution Check (Principle IV, NON-NEGOTIABLE) requires new
`*.spec.ts` for every new service/guard plus a new `test/auth-login.e2e-spec.ts`.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P5) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)

## Path Conventions

Single NestJS backend project per plan.md: `src/modules/auth/`, `src/modules/users/`,
`src/modules/rbac/`, `src/modules/settings/`, `src/database/migrations/`, `test/`.

---

## Phase 1: Setup

**Purpose**: Shared utilities and constants every later phase needs before any schema or service
work begins.

- [X] T001 Add `SESSION_TTL_MS` (24h) constant alongside the existing `PENDING_TTL_MS` /
      `CONFIRMATION_TTL_MS` constants in [src/modules/auth/utils/confirmation-token.ts](../../src/modules/auth/utils/confirmation-token.ts) (research.md §7), exporting it for reuse by `SessionService`
- [X] T002 [P] Add `LOCKOUT_THRESHOLD` (5) and `LOCKOUT_DURATION_MS` (15 min) constants in
      [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts) or a shared `src/modules/auth/utils/lockout.constants.ts` (research.md §3; FR-008)

**Checkpoint**: Constants available for the migration and every service in later phases.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema, entities, and the session lookup primitive that every user story
depends on. **No user story work can begin until this phase is complete.**

- [X] T003 Add `failed_login_attempts` (smallint, default 0) and `locked_until` (timestamptz,
      nullable) columns to `users` in a new migration
      `src/database/migrations/<timestamp>-AuthLogin.migration.ts` (data-model.md "Modified entity")
- [X] T004 In the same migration file, create table `sessions` (id, user_id FK → users
      ON DELETE CASCADE, token_hash varchar(64) unique, issued_at, expires_at, invalidated_at
      nullable, ip_address inet nullable, user_agent text nullable, created_at) with unique index
      on `token_hash` and partial index `idx_sessions_active` on `user_id` WHERE
      `invalidated_at IS NULL` (data-model.md "Session")
- [X] T005 In the same migration file, create table `login_challenges` (id, user_id FK, otp_hash,
      link_token_hash, issued_at, expires_at, attempts_remaining default 5, invalidated_at
      nullable, consumed_at nullable, created_at) with partial index on `user_id` WHERE
      `invalidated_at IS NULL AND consumed_at IS NULL` and index on `link_token_hash`
      (data-model.md "LoginChallenge")
- [X] T006 In the same migration file, create table `password_reset_challenges` with the identical
      shape/indexes as `login_challenges` (data-model.md "PasswordResetChallenge")
- [X] T007 In the same migration file, create table `login_audit_events` (id, event_type enum
      [`login_attempt`, `login_verification_attempt`, `logout`, `password_reset_requested`,
      `password_reset_attempt`], outcome enum [`success`, `failure`, `locked_out`],
      normalized_email citext, user_id FK ON DELETE SET NULL nullable, ip_address inet nullable,
      user_agent text nullable, failure_reason varchar(100) nullable, metadata jsonb, created_at)
      with composite indexes `(normalized_email, created_at)` and `(event_type, created_at)`,
      mirroring `registration_audit_events` (data-model.md "LoginAuditEvent")
- [X] T008 Run `npm run migration:run` locally against the dev Postgres and confirm all four
      schema changes from T003–T007 apply cleanly
- [X] T009 [P] Add `failedLoginAttempts` and `lockedUntil` properties to
      [src/modules/users/entities/user.entity.ts](../../src/modules/users/entities/user.entity.ts) mapping to the T003 columns
- [X] T010 [P] Create `Session` entity in
      src/modules/auth/entities/session.entity.ts mapping the T004 table
- [X] T011 [P] Create `LoginChallenge` entity in
      src/modules/auth/entities/login-challenge.entity.ts mapping the T005 table
- [X] T012 [P] Create `PasswordResetChallenge` entity in
      src/modules/auth/entities/password-reset-challenge.entity.ts mapping the T006 table
- [X] T013 [P] Create `LoginAuditEvent` entity in
      src/modules/auth/entities/login-audit-event.entity.ts mapping the T007 table, following the
      structure of [src/modules/auth/entities/registration-audit-event.entity.ts](../../src/modules/auth/entities/registration-audit-event.entity.ts)
- [X] T014 Register the four new entities (T010–T013) in
      [src/modules/auth/auth.module.ts](../../src/modules/auth/auth.module.ts) `TypeOrmModule.forFeature([...])` and in
      [src/modules/users/users.module.ts](../../src/modules/users/users.module.ts) if `User` entity changes require it
- [X] T015 [P] Create `LoginAuditService` in src/modules/auth/login-audit.service.ts as a
      sibling of [src/modules/auth/registration-audit.service.ts](../../src/modules/auth/registration-audit.service.ts), exposing a `record(event)`
      method writing to `login_audit_events` with redacted (hash-only, no raw secrets) metadata
      (research.md §4; FR-009)
- [X] T016 [P] `LoginAuditService` unit spec in src/modules/auth/login-audit.service.spec.ts
      mirroring [src/modules/auth/registration-audit.service.spec.ts](../../src/modules/auth/registration-audit.service.spec.ts)
- [X] T017 Create `SessionService` in src/modules/auth/session.service.ts with `issue(user, ip,
      userAgent)` (generates `crypto.randomBytes(32).toString('base64url')`, stores SHA-256 hash +
      `expires_at = now() + SESSION_TTL_MS`), `validate(rawToken)` (hash + active-row lookup:
      `invalidated_at IS NULL AND expires_at > now()`), `invalidate(sessionId)`, and
      `invalidateAllForUser(userId)` (used by password reset, FR-015) (data-model.md "Session";
      research.md §1, §7) — depends on T010
- [X] T018 [P] `SessionService` unit spec in src/modules/auth/session.service.spec.ts covering
      issue/validate/invalidate/invalidateAllForUser and expiry edge cases
- [X] T019 Create `SessionAuthGuard` in src/modules/auth/guards/session-auth.guard.ts: reads the
      `session` cookie, calls `SessionService.validate`, loads the user's role names via the same
      `user_roles`/`roles` join used in `test/support/rbac-test-auth.module.ts`, sets `request.user
      = { id, roles }`, throws `UnauthorizedException` otherwise (contracts/auth-api.md "Guard
      contract"; research.md §5) — depends on T017
- [X] T020 [P] `SessionAuthGuard` unit spec in
      src/modules/auth/guards/session-auth.guard.spec.ts covering valid session, missing cookie,
      expired session, and invalidated session cases

**Checkpoint**: Schema, entities, session issuance/validation, guard, and audit logging exist and
are unit-tested. User story implementation can now begin.

---

## Phase 3: User Story 1 - Log In With Email and Password (Priority: P1) 🎯 MVP

**Goal**: A registered, confirmed user can log in with email/password and receive a session
cookie; wrong password or unknown email both return an identical generic error; logout invalidates
the session.

**Independent Test**: Register a user, log in with correct credentials, confirm a session cookie
is issued and can be used for `/auth/logout`; confirm wrong password / unknown email return the
same `401`; confirm logout invalidates the cookie (quickstart.md Scenario 1).

### Tests for User Story 1

- [X] T021 [P] [US1] E2E test scaffold `test/auth-login.e2e-spec.ts`: describe block "Login"
      covering correct-credentials login (200, `verificationRequired:false`, `Set-Cookie: session=`),
      wrong password (401 generic), unknown email (401, identical body to wrong password), logout
      (200) then reuse of the same cookie (401), and login against an unconfirmed
      (`pending_confirmation`) account (403, `canResend:true`) — following the pattern in
      [test/auth-registration.e2e-spec.ts](../../test/auth-registration.e2e-spec.ts) (spec.md US1 Acceptance Scenarios 1–4; FR-016;
      contracts/auth-api.md)
- [X] T022 [P] [US1] `AuthService` unit spec additions in [src/modules/auth/auth.service.spec.ts](../../src/modules/auth/auth.service.spec.ts)
      for the new `login` and `logout` methods: correct credentials, wrong password, unknown email
      (identical outcome), unconfirmed account rejection

### Implementation for User Story 1

- [X] T023 [US1] Create `LoginRequestDto` (email, password) in
      src/modules/auth/dto/login-request.dto.ts using `class-validator`, mirroring
      [src/modules/auth/dto/register-request.dto.ts](../../src/modules/auth/dto/register-request.dto.ts)
- [X] T024 [P] [US1] Create `LoginResponseDto` (message, verificationRequired) in
      src/modules/auth/dto/login-response.dto.ts
- [X] T025 [US1] Implement `AuthService.login(dto, ip, userAgent)` in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts): look up user by normalized email, check
      `locked_until` (defer full lockout behavior to US3, but the read must exist so the check
      doesn't crash), reject with a generic invalid-credentials outcome for unknown email OR wrong
      password (FR-002/FR-003), reject with 403 semantics for `status = pending_confirmation`
      (FR-016), otherwise (when no sign-in verification is enabled — full branch added in US2) call
      `SessionService.issue` and set the `session` cookie via `@fastify/cookie`
      (`httpOnly`, `secure` in production, `sameSite=lax`), log the outcome via
      `LoginAuditService` — depends on T017, T015, T023 (FR-001, FR-002, FR-003, FR-004, FR-016)
- [X] T026 [US1] Implement `AuthService.logout(sessionId)` in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts): call `SessionService.invalidate`, clear the
      `session` cookie, log a `logout` event via `LoginAuditService` — depends on T017, T015
      (FR-006)
- [X] T027 [US1] Add `POST /auth/login` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts) with `@Throttle({ default: { limit: 5, ttl:
      60000 } })`, `@ApiOperation`/`@ApiOkResponse` Swagger decorators, mapping
      `AuthService.login` outcomes to `200`/`401`/`403`/`423` per contracts/auth-api.md — depends
      on T025
- [X] T028 [US1] Add `POST /auth/logout` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts) guarded by `@UseGuards(SessionAuthGuard)`,
      Swagger-documented, returning `200`/`401` per contracts/auth-api.md — depends on T019, T026
- [X] T029 [US1] Run T021/T022 and confirm they pass; fix any implementation gaps

**Checkpoint**: User Story 1 is fully functional and independently testable — basic login, logout,
and generic-error behavior work end-to-end.

---

## Phase 4: User Story 2 - Additional Email Verification at Login (Priority: P2)

**Goal**: When `signInConfirmationEnabled` is on, correct credentials trigger an emailed
code/link that must be confirmed before a session is issued.

**Independent Test**: Enable sign-in confirmation, log in with correct credentials, confirm no
session is issued until the emailed code/link is verified (quickstart.md Scenario 2).

### Tests for User Story 2

- [X] T030 [P] [US2] E2E tests in [test/auth-login.e2e-spec.ts](../../test/auth-login.e2e-spec.ts): describe block "Sign-in
      verification" covering enabled-flow (login returns `verificationRequired:true`, no cookie),
      correct code within window (200, cookie set), expired code (400), exhausted attempts (400),
      and disabled-flow (login completes immediately) (spec.md US2 Acceptance Scenarios 1–4)
- [X] T031 [P] [US2] `LoginChallengeService` unit spec in
      src/modules/auth/login-challenge.service.spec.ts covering issue, verify-by-code,
      verify-by-link, expiry, and attempt exhaustion

### Implementation for User Story 2

- [X] T032 [US2] Create `LoginChallengeService` in src/modules/auth/login-challenge.service.ts
      reusing `generateConfirmationTokens`/`hashSecret`/`CONFIRMATION_TTL_MS` from
      [src/modules/auth/utils/confirmation-token.ts](../../src/modules/auth/utils/confirmation-token.ts): `issue(user)` (invalidates any prior
      pending challenge for the user), `verifyByCode(email, code)`, `verifyByLinkToken(token)`,
      each decrementing `attempts_remaining` and marking `consumed_at`/`invalidated_at` as
      appropriate — depends on T011 (research.md §2; FR-005)
- [X] T033 [P] [US2] Create `LoginVerifyRequestDto` (email, code) in
      src/modules/auth/dto/login-verify-request.dto.ts
- [X] T034 [US2] Extend `AuthService.login` (from T025) in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts): when `SystemSettings.signInConfirmationEnabled`
      is true, call `LoginChallengeService.issue` and send the code/link via
      `ConfirmationMailService` (or a sibling mail call) instead of issuing a session, returning
      `verificationRequired:true` — depends on T032, T025 (FR-005)
- [X] T035 [US2] Implement `AuthService.verifyLogin(dto)` in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts): call `LoginChallengeService.verifyByCode`,
      on success call `SessionService.issue` + set cookie, log via `LoginAuditService`
      (`login_verification_attempt`) — depends on T032, T017, T015
- [X] T036 [US2] Implement `AuthService.verifyLoginByLink(token)` in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts) analogous to T035 using
      `LoginChallengeService.verifyByLinkToken` — depends on T032, T017, T015
- [X] T037 [US2] Add `POST /auth/login/verify` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts) with `@Throttle({ default: { limit: 5, ttl:
      60000 } })`, mapping to `200`/`400`/`404` per contracts/auth-api.md — depends on T035
- [X] T038 [US2] Add `GET /auth/login/verify/link` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts), matching the existing
      `register/confirm/link` convention — depends on T036
- [X] T039 [US2] Run T030/T031 and confirm they pass; fix any implementation gaps

**Checkpoint**: User Stories 1 and 2 both work independently; sign-in verification correctly gates
session issuance.

---

## Phase 5: User Story 3 - Protection Against Credential Guessing (Priority: P3)

**Goal**: Repeated failed logins for an account trigger a temporary lockout with a generic
message, and every login attempt is captured in the audit trail.

**Independent Test**: Submit 5 wrong passwords for one account, confirm the 6th attempt (even with
the correct password) is rejected with `423`, and confirm all 6 attempts appear in
`login_audit_events` (quickstart.md Scenario 3).

### Tests for User Story 3

- [X] T040 [P] [US3] E2E tests in [test/auth-login.e2e-spec.ts](../../test/auth-login.e2e-spec.ts): describe block "Lockout"
      covering 5 consecutive failed attempts followed by a 6th (correct-password) attempt
      returning `423`, and lockout clearing after `locked_until` elapses (spec.md US3 Acceptance
      Scenarios 1–2)
- [X] T041 [P] [US3] `UsersService` unit spec additions in
      [src/modules/users/users.service.spec.ts](../../src/modules/users/users.service.spec.ts) for lockout helpers: increment on failure,
      lock at threshold, reset on success
- [X] T042 [P] [US3] `LoginAuditService`/`AuthService` unit spec additions confirming every
      outcome (success, failure, locked_out) is recorded with the correct `event_type`/`outcome`/
      `failure_reason` (spec.md US3 Acceptance Scenario 3; FR-009; SC-003)

### Implementation for User Story 3

- [X] T043 [US3] Add lockout read/update helpers to
      [src/modules/users/users.service.ts](../../src/modules/users/users.service.ts): `recordFailedLogin(user)` (increments
      `failed_login_attempts`, sets `locked_until = now() + LOCKOUT_DURATION_MS` at threshold 5)
      and `recordSuccessfulLogin(user)` (resets both to 0/null) — depends on T002, T009
      (research.md §3; FR-008)
- [X] T044 [US3] Wire lockout checks into `AuthService.login` (T025/T034) in
      [src/modules/auth/auth.service.ts](../../src/modules/auth/auth.service.ts): reject with `423` (generic message, no
      duration/attempt-count leak) when `locked_until` is in the future, call
      `recordFailedLogin`/`recordSuccessfulLogin` on the corresponding outcomes, log every branch
      (success/failure/locked_out) via `LoginAuditService` including unknown-email attempts
      (`user_id: null`) — depends on T043, T015 (FR-007, FR-008, FR-009; contracts/auth-api.md
      `423`)
- [X] T045 [US3] Apply `@Throttle({ default: { limit: 5, ttl: 60000 } })` to `POST /auth/login`
      and `POST /auth/login/verify` (already present from T027/T037 — verify values match
      research.md §8) and confirm global `ThrottlerModule` remains the floor elsewhere (FR-007)
- [X] T046 [US3] Run T040–T042 and confirm they pass; fix any implementation gaps

**Checkpoint**: User Stories 1–3 all work independently; brute-force attempts are throttled,
locked out, and fully audited.

---

## Phase 6: User Story 4 - Recover a Forgotten Password (Priority: P4)

**Goal**: A user can request a password reset, confirm a time-limited code/link, set a new
password, and the old password stops working while other sessions are invalidated.

**Independent Test**: Request a reset for a known account, confirm with the emailed code, set a
new password, confirm the old password fails and the new one logs in (quickstart.md Scenario 4).

### Tests for User Story 4

- [X] T047 [P] [US4] E2E tests in [test/auth-login.e2e-spec.ts](../../test/auth-login.e2e-spec.ts): describe block "Password
      reset" covering request (200, identical generic body for existing vs non-existing email),
      confirm with valid code (200, password changed), confirm with expired/used code (400, no
      change), old password failing post-reset, new password succeeding, and other active sessions
      being invalidated after reset (spec.md US4 Acceptance Scenarios 1–4; FR-015)
- [X] T048 [P] [US4] `PasswordResetService` unit spec in
      src/modules/auth/password-reset.service.spec.ts covering issue, verify+apply, expiry,
      reuse-after-consumption, and the `passwordRecoveryConfirmationEnabled=false` kill-switch path
      (research.md §6)

### Implementation for User Story 4

- [X] T049 [P] [US4] Create `PasswordResetRequestDto` (email) in
      src/modules/auth/dto/password-reset-request.dto.ts
- [X] T050 [P] [US4] Create `PasswordResetConfirmDto` (email, code, newPassword) in
      src/modules/auth/dto/password-reset-confirm.dto.ts, applying the existing
      `validatePassword` policy validation used by `/auth/register`
- [X] T051 [US4] Create `PasswordResetService` in src/modules/auth/password-reset.service.ts
      reusing `generateConfirmationTokens`/`hashSecret`/`CONFIRMATION_TTL_MS`: `requestReset(email)`
      (no-op-but-200 when `passwordRecoveryConfirmationEnabled` is false or email unknown, else
      invalidates prior challenges and issues a new one + sends email), `confirmReset(email, code,
      newPassword)` (validates challenge, updates the user's password hash via bcryptjs, marks
      `consumed_at`, resets lockout columns via `UsersService.recordSuccessfulLogin`, calls
      `SessionService.invalidateAllForUser`), `exchangeLinkToken(token)` for the link variant —
      depends on T012, T017, T043 (research.md §2, §6; FR-010, FR-011, FR-012, FR-013, FR-015)
- [X] T052 [US4] Add `POST /auth/password-reset/request` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts) with `@Throttle({ default: { limit: 1, ttl:
      60000 } })`, always returning the generic `200` body per contracts/auth-api.md — depends on
      T051
- [X] T053 [US4] Add `POST /auth/password-reset/confirm` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts) mapping to `200`/`400` per
      contracts/auth-api.md, reusing the password-policy error array shape from `/auth/register`
      — depends on T051
- [X] T054 [US4] Add `GET /auth/password-reset/confirm/link` route to
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts): exchanges the link token for the
      underlying reset token via `PasswordResetService.exchangeLinkToken` without accepting
      `newPassword` as a query parameter, per contracts/auth-api.md's implementation note —
      depends on T051
- [X] T055 [US4] Log `password_reset_requested`/`password_reset_attempt` events via
      `LoginAuditService` from `PasswordResetService` (T051) for every request/confirm outcome —
      depends on T015
- [X] T056 [US4] Run T047/T048 and confirm they pass; fix any implementation gaps

**Checkpoint**: User Stories 1–4 all work independently; forgotten-password recovery is fully
self-service and invalidates other sessions.

---

## Phase 7: User Story 5 - Access Restricted to Authenticated Users (Priority: P5)

**Goal**: Authenticated-only routes (RBAC controllers, admin settings) reject requests without a
valid session; `AdminGuard` is rebuilt on real session + role checks.

**Independent Test**: Call a protected route with no session (401), a valid session (success or
403 by role), and an expired/invalidated session (401) (quickstart.md Scenario 5).

### Tests for User Story 5

- [X] T057 [P] [US5] E2E tests in [test/auth-login.e2e-spec.ts](../../test/auth-login.e2e-spec.ts) (or a new
      test/rbac-session-guard.e2e-spec.ts): describe block "Route protection" covering `/rbac/roles`
      with no session (401), with a valid non-admin session (403), and with an expired/invalidated
      session (401) (spec.md US5 Acceptance Scenarios 1–3)
- [X] T058 [P] [US5] `AdminGuard` unit spec update in
      src/modules/settings/guards/admin.guard.spec.ts covering: no session (401/403), valid
      session without `admin` role (403), valid session with `admin` role (allowed) — replacing
      the current always-`true` placeholder behavior

### Implementation for User Story 5

- [X] T059 [US5] Apply `@UseGuards(SessionAuthGuard, PermissionGuard)` to
      [src/modules/rbac/roles.controller.ts](../../src/modules/rbac/roles.controller.ts) — depends on T019 (research.md §5; FR-014)
- [X] T060 [P] [US5] Apply `@UseGuards(SessionAuthGuard, PermissionGuard)` to
      [src/modules/rbac/permissions.controller.ts](../../src/modules/rbac/permissions.controller.ts) — depends on T019
- [X] T061 [P] [US5] Apply `@UseGuards(SessionAuthGuard, PermissionGuard)` to
      [src/modules/rbac/grants.controller.ts](../../src/modules/rbac/grants.controller.ts) — depends on T019
- [X] T062 [US5] Reimplement [src/modules/settings/guards/admin.guard.ts](../../src/modules/settings/guards/admin.guard.ts) on top of
      `SessionAuthGuard`'s session lookup, additionally requiring the `admin` role (seeded by
      `RbacSeedAdmin1756730200000`), removing the placeholder always-`true` behavior — depends on
      T019 (research.md §5)
- [X] T063 [US5] Evaluate whether test/support/rbac-test-auth.module.ts is still needed for any
      RBAC-only fixtures that don't exercise login; remove or scope it down if fully superseded by
      real session-based e2e auth setup (plan.md Project Structure note) — still needed by
      rbac-access-check.e2e-spec.ts and the synthetic PermissionGuard-only fixtures in
      rbac-grants.e2e-spec.ts, which don't go through SessionAuthGuard; the real `/rbac/*` and
      `/admin/settings/*` CRUD e2e specs were migrated to real login-issued session cookies
- [X] T064 [US5] Run T057/T058 and confirm they pass; fix any implementation gaps

**Checkpoint**: All five user stories are independently functional; authenticated-only routes are
finally enforced end-to-end.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across all stories.

- [X] T065 [P] Add/verify `@ApiOperation`/`@ApiOkResponse`/`@ApiResponse` Swagger decorators for
      every new route (`login`, `login/verify`, `login/verify/link`, `logout`,
      `password-reset/request`, `password-reset/confirm`, `password-reset/confirm/link`) in
      [src/modules/auth/auth.controller.ts](../../src/modules/auth/auth.controller.ts), matching existing `register` route style
- [X] T066 [P] `auth.controller.spec.ts` additions in [src/modules/auth/auth.controller.spec.ts](../../src/modules/auth/auth.controller.spec.ts)
      for the new routes' request/response wiring (status mapping, DTO validation)
- [X] T067 Run `npm run verify` (typecheck + lint + unit tests) and fix any failures
- [X] T068 Run `npm run test:e2e` and fix any failures across all `auth-login.e2e-spec.ts`
      scenarios
- [X] T069 Walk through quickstart.md Scenarios 1–5 manually against the local dev stack
      (Postgres + Mailpit) and confirm each documented `curl` sequence behaves as specified —
      Scenario 1 (login/logout/cookie invalidation) and Scenario 5 (401/403 route protection)
      verified live via curl against the running dev server; generic-401 and throttling behavior
      confirmed live; full coverage of all 5 scenarios (incl. sign-in verification, lockout,
      password reset) already exercised end-to-end by `test/auth-login.e2e-spec.ts`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001–T002 constants) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — no dependency on other stories
- **User Story 2 (Phase 4)**: Depends on Foundational; extends `AuthService.login` from US1
  (T025) — implement after US1 or integrate carefully if done in parallel
- **User Story 3 (Phase 5)**: Depends on Foundational; extends `AuthService.login` from US1/US2
  (T025/T034) — implement after US1 (and ideally US2)
- **User Story 4 (Phase 6)**: Depends on Foundational (`SessionService`, `LoginAuditService`,
  `UsersService` lockout helpers from US3) — independently testable once those exist
- **User Story 5 (Phase 7)**: Depends on Foundational (`SessionAuthGuard`, T019) only — can be
  implemented in parallel with US2–US4 once Phase 2 is done
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- US1 has no dependency on other stories (true MVP)
- US2 integrates with US1's `AuthService.login` (extends the same method) but is independently
  testable via the `signInConfirmationEnabled` toggle
- US3 integrates with US1/US2's `AuthService.login` (adds lockout checks) but is independently
  testable via repeated failed attempts
- US4 depends only on Foundational primitives (`SessionService`, `LoginAuditService`); reuses
  US3's `UsersService` lockout-reset helper but does not require US2/US3 to be implemented first
- US5 depends only on Foundational (`SessionAuthGuard`); fully independent of US2–US4

### Within Each User Story

- Tests before implementation (write first, confirm they fail)
- Entities/DTOs before services
- Services before controller routes
- Story complete and its tests passing before moving to the next priority

### Parallel Opportunities

- T001/T002 (Setup) in parallel
- T009–T013 (entities) in parallel after migration T003–T007 lands; T015/T016 in parallel;
  T018/T020 in parallel with each other but after their respective services (T017/T019)
- Once Phase 2 completes, US5 (Phase 7) can be worked in parallel with US2–US4 by a different
  developer, since it only touches guards/controllers, not `AuthService.login`
- Within each story, all tasks marked [P] (different files) can run in parallel

---

## Parallel Example: Foundational Phase

```bash
# Launch entity creation together once the migration (T003-T007) is applied:
Task: "Create Session entity in src/modules/auth/entities/session.entity.ts"
Task: "Create LoginChallenge entity in src/modules/auth/entities/login-challenge.entity.ts"
Task: "Create PasswordResetChallenge entity in src/modules/auth/entities/password-reset-challenge.entity.ts"
Task: "Create LoginAuditEvent entity in src/modules/auth/entities/login-audit-event.entity.ts"
```

## Parallel Example: User Story 1

```bash
# Launch both test tasks for User Story 1 together:
Task: "E2E test scaffold test/auth-login.e2e-spec.ts — Login describe block"
Task: "AuthService unit spec additions for login/logout in src/modules/auth/auth.service.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (schema, entities, `SessionService`, `SessionAuthGuard`,
   `LoginAuditService`) — CRITICAL, blocks all stories
3. Complete Phase 3: User Story 1 (login, logout, generic errors)
4. **STOP and VALIDATE**: Run quickstart.md Scenario 1 against the local stack
5. Deploy/demo if ready — this alone makes the existing registration/RBAC infrastructure usable

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → validate (Scenario 1) → MVP
3. Add US2 → validate (Scenario 2) — sign-in verification
4. Add US3 → validate (Scenario 3) — lockout + audit trail
5. Add US4 → validate (Scenario 4) — password recovery
6. Add US5 → validate (Scenario 5) — route protection closes the loop
7. Phase 8 → full `npm run verify` + `npm run test:e2e` + quickstart walkthrough gate before PR

### Parallel Team Strategy

With multiple developers, after Phase 2 (Foundational) is done:

- Developer A: US1 → US2 → US3 (all extend `AuthService.login` sequentially, same file)
- Developer B: US5 (guards/controllers only, no shared-file conflicts with A)
- Developer C: US4 (new `PasswordResetService`, own files) — can start once T017/T015/T043 exist

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- FR-002/FR-003/SC-002 (indistinguishable failures) and FR-010 (no email enumeration on reset)
  are cross-cutting correctness requirements — verify them explicitly in the US1 and US4 test
  tasks (T021, T047), not just implicitly
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently
- Avoid: vague tasks, same-file conflicts (note `auth.service.ts` and `auth.controller.ts` are
  touched by US1, US2, and US3 — sequence those within a story rather than parallelizing across
  stories on the same file)
