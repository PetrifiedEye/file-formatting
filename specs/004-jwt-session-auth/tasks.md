---

description: "Task list template for feature implementation"
---

# Tasks: JWT Cookie-Based Session Authorization

**Input**: Design documents from `/specs/004-jwt-session-auth/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auth-endpoints.md, quickstart.md (all present)

**Tests**: Test tasks are included — the constitution's Test Coverage principle (NON-NEGOTIABLE) and the plan's Testing section require unit coverage for `TokenService`/`JwtAuthGuard` and e2e coverage for the login → protected-resource → expiry → refresh → logout flow.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- File paths are exact and relative to the repository root

## Path Conventions

Single NestJS backend project — `src/modules/auth/`, `src/modules/rbac/`, `src/modules/settings/`, `src/core/config/`, `src/database/migrations/`. Test files are colocated `*.spec.ts`; e2e specs live under the existing e2e project config (`test/`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the new dependency and configuration surface needed before any JWT code can be written.

- [X] T001 Add `@nestjs/jwt` to `package.json` dependencies and install it (`npm install @nestjs/jwt`)
- [X] T002 [P] Add `JWT_ACCESS_SECRET: string` and `JWT_REFRESH_SECRET: string` to the `Config` interface in `src/core/config/config.types.ts`
- [X] T003 [P] Add required Joi string validators for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `src/core/config/config.validation.ts`
- [X] T004 [P] Add `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` placeholder entries to `.env.example` and `.env`

**Checkpoint**: App boots with the two new required env vars validated; no behavior change yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core token-signing/verification infrastructure, the DB migration, and the login flow's switch to issuing JWTs — every user story depends on a user being able to sign in and receive an `access_token`/`refresh_token` pair.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Create migration `src/database/migrations/<timestamp>-JwtSessionAuth.migration.ts`: `up()` drops index `idx_sessions_active` and table `sessions`, then `ALTER TYPE login_audit_events_event_type_enum ADD VALUE 'access_check_failed'` and `ADD VALUE 'token_refresh_attempt'`; `down()` recreates the `sessions` table/index (mirroring `1757000000000-AuthLogin.migration.ts`'s `up`) — Postgres cannot drop enum values, so `down()` documents that the two enum values are left in place
- [X] T006 [P] Add `ACCESS_CHECK_FAILED = 'access_check_failed'` and `TOKEN_REFRESH_ATTEMPT = 'token_refresh_attempt'` members to `LoginAuditEventType` in `src/modules/auth/entities/login-audit-event.entity.ts`
- [X] T007 [P] Implement `TokenService` in `src/modules/auth/token.service.ts`: `signAccessToken(userId)` / `signRefreshToken(userId)` (payload `{ sub, typ }`, 15m/30d expiry via `@nestjs/jwt`, separate `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`), `verifyAccessToken(token)` / `verifyRefreshToken(token)` (checks signature, `exp`, `typ`, `clockTolerance: 5`, returns `{ sub }` or throws)
- [X] T008 [P] Unit tests for `TokenService` in `src/modules/auth/token.service.spec.ts`: sign/verify round-trip for both token kinds, expired token rejected, tampered/wrong-secret token rejected, wrong-`typ` token rejected on each verify method, clock-skew tolerance accepted within 5s
- [X] T009 Register `JwtModule` (no default config — secrets passed per-call) and `TokenService` as a provider in `src/modules/auth/auth.module.ts`; remove `Session` entity from `TypeOrmModule.forFeature`, remove `SessionService` and `SessionAuthGuard` from `providers`/`exports`
- [X] T010 Delete `src/modules/auth/entities/session.entity.ts`, `src/modules/auth/session.service.ts`, and `src/modules/auth/session.service.spec.ts` (superseded by `TokenService`; the table drop is handled by T005)
- [X] T011 Update `AuthService` in `src/modules/auth/auth.service.ts`: replace the `SessionService` dependency with `TokenService`; change `LoginResult`'s `session?: IssuedSession` to `tokens?: { accessToken: string; refreshToken: string }`; update `login`, `finalizeLoginVerification` (used by `verifyLogin`/`verifyLoginByLink`) to call `tokenService.signAccessToken`/`signRefreshToken` instead of `sessionService.issue`
- [X] T012 Update `AuthController` in `src/modules/auth/auth.controller.ts`: replace `setSessionCookie`/`SESSION_COOKIE_NAME` with `setAuthCookies(reply, tokens)` that sets `access_token` (`path=/`, `maxAge=900`) and `refresh_token` (`path=/auth`, `maxAge=2592000`), both `httpOnly`, `secure` in production, `sameSite=lax`; wire it into `login`, `verifyLogin`, `verifyLoginByLink` in place of `setSessionCookie`
- [X] T013 [P] Update `src/modules/auth/auth.service.spec.ts` and `src/modules/auth/auth.controller.spec.ts` for the `tokens` shape instead of `session`/`IssuedSession` across login/verify test cases

**Checkpoint**: Login, verify-by-code, and verify-by-link issue `access_token`/`refresh_token` cookies; no route can yet consume them (guard comes in US1).

---

## Phase 3: User Story 1 - Access a protected resource with a valid session (Priority: P1) 🎯 MVP

**Goal**: A valid `access_token` cookie authenticates a request to a protected resource; missing/tampered/expired tokens and inactive users are rejected.

**Independent Test**: Sign in, call any protected endpoint with the resulting cookies — succeeds. Call it with no cookies, or a tampered cookie — rejected as unauthenticated.

### Tests for User Story 1

- [X] T014 [P] [US1] Unit tests for `JwtAuthGuard` in `src/modules/auth/guards/jwt-auth.guard.spec.ts`: happy path populates `request.user = { id, roles }`; each rejection (missing cookie, malformed, wrong `typ`, bad signature, expired, user not found, user inactive) throws `UnauthorizedException` and triggers an `ACCESS_CHECK_FAILED` audit record with the matching `failureReason` category

### Implementation for User Story 1

- [X] T015 [US1] Implement `JwtAuthGuard` in `src/modules/auth/guards/jwt-auth.guard.ts`: reads `request.cookies.access_token`, calls `TokenService.verifyAccessToken`, on any failure records `LoginAuditService.record(ACCESS_CHECK_FAILED, FAILURE, { failureReason })` and throws `UnauthorizedException('Authentication required')`; on success looks up the user by `sub` (reject if not found or `status !== ACTIVE`, same audit+throw pattern with `failureReason: 'user_not_found'`/`'user_inactive'`), loads `UserRole` memberships (same query `SessionAuthGuard` used) and sets `request.user = { id, roles }`
- [X] T016 [US1] Delete `src/modules/auth/guards/session-auth.guard.ts` and `src/modules/auth/guards/session-auth.guard.spec.ts` (superseded by `JwtAuthGuard`)
- [X] T017 [US1] Add `JwtAuthGuard` to `providers` and `exports` in `src/modules/auth/auth.module.ts`
- [X] T018 [P] [US1] Replace `SessionAuthGuard` with `JwtAuthGuard` in `src/modules/rbac/roles.controller.ts`, `src/modules/rbac/permissions.controller.ts`, and `src/modules/rbac/grants.controller.ts` (`@UseGuards(SessionAuthGuard, PermissionGuard)` → `@UseGuards(JwtAuthGuard, PermissionGuard)`, update the import)
- [X] T019 [P] [US1] Replace `SessionAuthGuard` with `JwtAuthGuard` in `src/modules/settings/guards/admin.guard.ts` (constructor-injected guard, same `forwardRef` pattern)
- [X] T020 [P] [US1] Update `src/modules/rbac/roles.controller.spec.ts`, `permissions.controller.spec.ts`, `grants.controller.spec.ts`, and `src/modules/settings/guards/admin.guard.spec.ts` for the `JwtAuthGuard` rename
- [X] T021 [US1] e2e test in existing auth e2e spec: login → call a protected endpoint (e.g. `GET /rbac/roles`) with cookies succeeds; no cookies → 401; tampered `access_token` cookie → 401; deactivated user's still-valid access token → 401

**Checkpoint**: User Story 1 fully functional — protected resources authenticate via `access_token` cookie independent of refresh/logout.

---

## Phase 4: User Story 2 - Session renews automatically without re-entering credentials (Priority: P2)

**Goal**: `POST /auth/refresh` exchanges a valid `refresh_token` for a fresh access/refresh pair (rotation), without a password.

**Independent Test**: Let the access token expire, call `/auth/refresh` with only the refresh cookie — a fresh working session is issued and immediately usable against a protected resource.

### Tests for User Story 2

- [X] T022 [P] [US2] Unit tests in `src/modules/auth/auth.service.spec.ts` for `AuthService.refresh`: valid refresh token + active user → new token pair returned, `TOKEN_REFRESH_ATTEMPT`/`SUCCESS` audited

### Implementation for User Story 2

- [X] T023 [US2] Add `refresh(rawRefreshToken, meta): Promise<{ accessToken, refreshToken }>` to `AuthService` in `src/modules/auth/auth.service.ts`: verify via `TokenService.verifyRefreshToken`, look up user by `sub`, require `status === ACTIVE`, on success issue a new access+refresh pair via `TokenService` and record `TOKEN_REFRESH_ATTEMPT`/`SUCCESS`
- [X] T024 [US2] Add `POST /auth/refresh` to `AuthController` in `src/modules/auth/auth.controller.ts`: `@Throttle({ default: { limit: 5, ttl: 60000 } })`, no guard, reads `req.cookies.refresh_token`, calls `authService.refresh`, sets both cookies via `setAuthCookies` on success, returns `{ message: 'Session refreshed.' }`; add Swagger annotations (`@ApiOperation`, `@ApiOkResponse`, `@ApiUnauthorizedResponse`, `@ApiTooManyRequestsResponse`)
- [X] T025 [US2] e2e test: login → simulate/wait for access-token expiry → protected call returns 401 → `POST /auth/refresh` with refresh cookie returns 200 and sets fresh `access_token`+`refresh_token` cookies → protected call with the new cookies succeeds

**Checkpoint**: Users can renew an expired 15-minute session for up to 30 days without re-entering a password.

---

## Phase 5: User Story 3 - Expired or invalid session requires signing in again (Priority: P2)

**Goal**: `/auth/refresh` cleanly rejects a missing, malformed, or expired refresh token, issuing no cookies, so the client knows to redirect to sign-in.

**Independent Test**: Call `/auth/refresh` with an expired, missing, or malformed refresh cookie — rejected with no new cookies set, and the next protected-resource call is treated as signed out.

### Tests for User Story 3

- [X] T026 [P] [US3] Unit tests in `src/modules/auth/auth.service.spec.ts` for `AuthService.refresh` rejection paths: missing/malformed/bad-signature/expired/wrong-`typ` refresh token and user-not-found/user-inactive all throw `UnauthorizedException`, set no cookies, and record `TOKEN_REFRESH_ATTEMPT`/`FAILURE` with the matching `failureReason`

### Implementation for User Story 3

- [X] T027 [US3] Harden `AuthService.refresh` and the `/auth/refresh` controller handler (from T023/T024) so every rejection path returns `401` with body `{ "statusCode": 401, "message": "Authentication required" }` and calls neither `setAuthCookies` nor any cookie-clearing method
- [X] T028 [US3] e2e test: `POST /auth/refresh` with no `refresh_token` cookie → 401, no `Set-Cookie` headers; with `refresh_token=garbage` → 401, no `Set-Cookie` headers; subsequent protected-resource call with the original (now-expired) cookies still returns 401

**Checkpoint**: The renewal boundary condition is fully covered — invalid renewal always fails closed with a consistent, cookie-free 401.

---

## Phase 6: User Story 4 - User signs out (Priority: P3)

**Goal**: `/auth/logout` clears both cookies unconditionally and requires no valid session, matching the "no server-side revocation" design.

**Independent Test**: While signed in, call logout — cookies cleared client-side, next protected call is unauthenticated. Calling logout with no cookies at all is a 200 no-op.

### Tests for User Story 4

- [X] T029 [P] [US4] Unit tests for the simplified `AuthService.logout` (no `SessionService` dependency) in `src/modules/auth/auth.service.spec.ts`: always resolves `{ message: 'Signed out.' }` regardless of cookie presence

### Implementation for User Story 4

- [X] T030 [US4] Simplify `AuthService.logout` in `src/modules/auth/auth.service.ts`: drop the `SessionService`/audit-lookup-by-session logic entirely (no server-side state exists to invalidate); method takes no token argument and unconditionally returns `{ message: 'Signed out.' }`
- [X] T031 [US4] Remove `@UseGuards(SessionAuthGuard)` from `POST /auth/logout` in `src/modules/auth/auth.controller.ts`; always call `clearAuthCookies(reply)` (clears `access_token` at `path=/` and `refresh_token` at `path=/auth` via `Max-Age=0`) before returning the service's message; update Swagger annotations to drop the `@ApiUnauthorizedResponse` (no longer possible) per contracts/auth-endpoints.md
- [X] T032 [P] [US4] Update `src/modules/auth/auth.controller.spec.ts` for the no-guard, always-200 `/auth/logout` contract
- [X] T033 [US4] e2e test: sign in → logout → 200 with both cookies cleared → protected call with the (cleared) cookie jar → 401; logout again with an empty cookie jar → 200 no-op

**Checkpoint**: All four user stories independently functional — sign-in, protected access, renewal, renewal rejection, and sign-out.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final correctness, documentation, and manual verification across all stories.

- [X] T034 [P] Add/update Swagger annotations across `src/modules/auth/auth.controller.ts` so `POST /auth/refresh` and `POST /auth/logout` match `contracts/auth-endpoints.md` exactly (response DTOs/bodies, status codes)
- [X] T035 [P] Search `src/modules/auth`, `src/modules/rbac`, `src/modules/settings` for any remaining references to `Session`, `SessionService`, `SessionAuthGuard`, or the `session` cookie name and remove them
- [X] T036 Run `npm run test` and `npm run test:e2e`; fix any regression surfaced by the guard/token swap
- [X] T037 Run `npm run lint` and fix any violations introduced by this feature
- [X] T038 Execute `quickstart.md` end-to-end against a local stack (`docker compose` + `npm run start:dev`), including step 6's `psql "\dt sessions"` check confirming the table is gone

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (login must issue JWT cookies before any story can be tested)
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational only (does not depend on US1's guard, but shares `TokenService`)
- **User Story 3 (Phase 5)**: Depends on Foundational + US2 (T023/T024 implement the `AuthService.refresh`/controller method that US3 hardens and tests)
- **User Story 4 (Phase 6)**: Depends on Foundational only
- **Polish (Phase 7)**: Depends on all four user stories being complete

### User Story Dependencies

- **US1 (P1)**: No dependency on other stories — independently testable after Foundational
- **US2 (P2)**: No dependency on other stories — independently testable after Foundational
- **US3 (P2)**: Builds directly on US2's `refresh` implementation (same method/endpoint, negative paths) — implement after US2
- **US4 (P3)**: No dependency on other stories — independently testable after Foundational

### Within Each User Story

- Tests written before/alongside implementation (per Constitution Principle IV)
- Guard/service implementation before controller wiring before e2e verification
- Story complete before moving to the next priority

### Parallel Opportunities

- Setup tasks T002–T004 in parallel (different files)
- Foundational tasks T006–T008 in parallel; T013 after T011/T012 land
- Once Foundational is complete: US1, US2, and US4 can be worked in parallel (different files); US3 must follow US2
- T018–T020 (US1 guard-consumer updates) in parallel across `rbac`/`settings`

---

## Parallel Example: User Story 1

```bash
# After T015 (JwtAuthGuard) and T017 (module export) land:
Task: "Replace SessionAuthGuard with JwtAuthGuard in src/modules/rbac/roles.controller.ts, permissions.controller.ts, grants.controller.ts"
Task: "Replace SessionAuthGuard with JwtAuthGuard in src/modules/settings/guards/admin.guard.ts"
Task: "Update rbac/settings guard specs for the JwtAuthGuard rename"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — login must issue JWT cookies)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Sign in, hit a protected endpoint, confirm rejection of missing/tampered cookies and inactive users
5. Deploy/demo if ready — this alone restores full request authentication on the new mechanism

### Incremental Delivery

1. Setup + Foundational → login issues `access_token`/`refresh_token` cookies
2. Add US1 → protected resources authenticate via `access_token` (MVP!)
3. Add US2 → seamless renewal via `/auth/refresh`
4. Add US3 → renewal's failure boundary is airtight
5. Add US4 → explicit sign-out
6. Polish → docs, cleanup, full verification

### Parallel Team Strategy

With multiple developers, once Foundational (Phase 2) is done:
- Developer A: User Story 1 (guard + consumer repointing)
- Developer B: User Story 2 → then User Story 3 (shared `refresh` code path)
- Developer C: User Story 4 (logout simplification)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- No new database tables are created — only a migration that drops `sessions` and extends an enum (T005)
- FR-010 (no server-side refresh-credential storage) means no task in this list should ever add a lookup/index/table keyed on the refresh token itself — verify this explicitly during T036/T038
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
