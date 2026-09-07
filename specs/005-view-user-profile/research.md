# Phase 0 Research: View User Profile

All items from the spec's Technical Context / Assumptions are resolved below by
inspecting the existing codebase (no NEEDS CLARIFICATION remain).

## 1. Access-decision placement: guard vs. service

**Decision**: Implement the self/privileged/deny decision inside `UsersService`
(called from `UsersController`), not via the declarative `@RequirePermission()` +
`PermissionGuard` pair used elsewhere in the codebase (e.g. `grants.controller.ts`).

**Rationale**: `PermissionGuard` (`src/modules/rbac/guards/permission.guard.ts`)
unconditionally requires the configured permission for the whole route — it has no
concept of "allow if the target is the caller". Story 1 requires self-access to
succeed for every authenticated user regardless of `users:read`. Only the route
handler/service can compare `request.user.id` to the path `userId` before deciding
whether to consult `AccessConfigService.hasPermission()`.

**Alternatives considered**: A custom guard duplicating self-vs-other logic was
considered, but it would still need to read the route's target id and call the
service to know if the target exists (for the 403-vs-404 distinction), so the
logic ends up in the service layer regardless — keeping it there in one place
is simpler and matches `UsersService` already owning `findById`.

## 2. Authentication guard

**Decision**: Reuse `JwtAuthGuard` (`src/modules/auth/guards/jwt-auth.guard.ts`)
unmodified. It already validates the `access_token` cookie, loads the `User`,
rejects inactive users, and populates `request.user = { id, roles }` — exactly
the shape (`RequestUser`) needed to identify the caller and their roles for the
RBAC check. It throws `UnauthorizedException` (401) before any other logic runs,
satisfying FR-004.

**Alternatives considered**: None — this is the only JWT guard in the codebase
and is the established convention for authenticated endpoints (used by
`grants.controller.ts` etc.).

## 3. Permission check

**Decision**: Call `AccessConfigService.hasPermission(request.user.roles, 'users', 'read')`
directly from `UsersService` when the target id differs from the caller id.

**Rationale**: This is the same service `PermissionGuard` delegates to, so
behavior stays consistent with the rest of RBAC, but it's invoked conditionally
rather than as a blanket route guard (see #1).

**New permission required**: No `users` permission exists yet — only `rbac`
(seeded in `1756730200000-RbacSeedAdmin.migration.ts`). A new migration must
insert a `permissions` row `{ name: 'users', actions: ['read'] }` (no grants —
granting `users:read` to specific roles is an RBAC-admin operation out of scope
for this feature, done via the existing `/rbac/grants` endpoints after deploy).

**Alternatives considered**: Seeding an admin grant automatically was considered
and rejected — RBAC grant assignment is already self-service via
`POST /rbac/grants` (RBAC feature, 002); this feature only needs the permission
to exist so it can be granted.

## 4. Profile field storage — `photo`

**Decision**: Add a nullable `photo_url` (`varchar`) column to the `users` table
via migration. Per spec Assumptions, "photo" is a URL reference regardless of
underlying storage; no file-storage mechanics are in scope.

**Rationale**: The current `User` entity (`src/modules/users/entities/user.entity.ts`)
has no photo/avatar field at all — this is a gap the spec explicitly requires
(FR-011 lists `photo` in both self and privileged views). Nullable avoids a
backfill; existing users default to `null` (client renders a placeholder).

**Alternatives considered**: Storing photo metadata in a separate table was
rejected as unnecessary complexity — a single URL column matches the "URL
reference" assumption and needs no relational structure.

## 5. Response shaping / field filtering

**Decision**: Follow the existing manual-mapping convention (`SettingsController.toResponse()`
pattern) — a plain DTO class with `@nestjs/swagger` `@ApiProperty()`/`@ApiPropertyOptional()`
decorators, populated field-by-field in the service/controller depending on
access level. No `class-transformer` `@Exclude`/`@Expose` is used anywhere in
this codebase, so this feature won't introduce it either.

**Rationale**: Consistency with codebase conventions (constitution Principle I);
avoids a new serialization mechanism for one endpoint. Default-deny is enforced
by construction: the DTO is built by explicitly copying only the fields allowed
for the resolved access level (self → all profile fields; privileged → `id`,
`photo` only) — nothing is copied by default.

**Alternatives considered**: `class-transformer` groups (`@Expose({ groups })`)
would work but is an unused dependency pattern in this codebase; rejected to
avoid an inconsistent precedent.

## 6. Malformed `userId` handling

**Decision**: Use `ParseUUIDPipe` on the `:userId` path param, but catch/convert
its `BadRequestException` into the same 404 (or 403, if the caller lacks
`users:read`) response the "not found" branch produces — never let a raw 400
leak through, per spec Edge Cases ("malformed → not-found, without revealing
whether the format itself was the problem").

**Rationale**: `ParseUUIDPipe` is the standard Nest mechanism for this class of
check, but its default 400 response would violate the spec's information-hiding
requirement, so the controller/service must special-case it into the existing
403/404 branching rather than letting the pipe's exception bubble up.

**Alternatives considered**: Skipping `ParseUUIDPipe` and validating manually
inside the service was considered equally valid; `ParseUUIDPipe` is preferred
only because it documents the expected shape in one place (route decorator) —
either approach converges on the same 403/404 outcome.

## 7. Rate limiting

**Decision**: Rely on the existing global `ThrottlerGuard` (registered as
`APP_GUARD` in `AppModule`, backed by `THROTTLE_GLOBAL_TTL`/`THROTTLE_GLOBAL_LIMIT`).
No per-route `@Throttle()` override is added initially.

**Rationale**: No existing controller in the codebase overrides throttling
per-route — there is no established pattern to follow for a stricter limit, and
the spec's Assumptions explicitly permit reusing "standard abuse-prevention
thresholds already applied to other authenticated endpoints" unless a stricter
limit is later specified. FR-007/SC-005 are satisfied by the global guard.

**Alternatives considered**: A dedicated `@Throttle({ default: { limit, ttl } })`
for this route was considered (profile enumeration is a realistic abuse vector)
but deferred — it can be added later as a targeted follow-up without changing
the contract, and doing so now would require picking thresholds with no
existing precedent in this codebase to anchor them to.

## 8. Audit logging

**Decision**: Add a new `UsersAuditService` + `UserProfileAuditEvent` entity in
`src/modules/users/`, mirroring `LoginAuditService`/`LoginAuditEvent`
(`src/modules/auth/login-audit.service.ts`) and `RbacAuditService`. Records
`{ viewerId, targetId, outcome }` for every profile view attempt (200/403/404),
never the returned field values. Failure to write the audit record MUST NOT
fail the request (matches `LoginAuditService`'s fire-and-log pattern and spec
Assumption that Story 5 is best-effort).

**Rationale**: The codebase has no shared/generic audit service — every prior
feature (login, registration, RBAC) added its own domain-scoped audit
entity+service. Following that precedent keeps the pattern consistent
(constitution Principle V: log data-relevant/security events) rather than
introducing a new shared abstraction for one feature.

**Alternatives considered**: Reusing `RbacAuditService`'s `MANAGEMENT_ACCESS_DENIED`
event type was rejected — that event is scoped to RBAC-management actions
(grants/roles/permissions CRUD), not profile reads; conflating them would
misrepresent audit records.

## 9. Error handling

**Decision**: Use plain Nest exceptions — `UnauthorizedException` (401, via
`JwtAuthGuard`, unchanged), `ForbiddenException` (403, thrown from
`UsersService` when caller lacks `users:read` for another user's profile),
`NotFoundException` (404, thrown from `UsersService` when the resolved-viewable
target doesn't exist). No custom exception filter — matches existing
convention (`grants.service.ts` etc. throw built-ins directly).

**Rationale**: Constitution and codebase precedent; no feature in this repo
uses a custom filter.

## 10. Test placement

**Decision**: Unit tests colocated as `*.spec.ts` next to new/changed files in
`src/modules/users/`; e2e test at `test/users-profile.e2e-spec.ts`, following
the naming convention of `test/auth-login.e2e-spec.ts` /
`test/rbac-access-check.e2e-spec.ts`. Reuse `test/support/rbac-test-auth.module.ts`
(existing helper for stubbing authenticated requests in e2e) if its shape fits;
otherwise extend it minimally rather than duplicating a new auth-stub helper.

**Rationale**: Matches constitution Principle IV and existing repo layout.
