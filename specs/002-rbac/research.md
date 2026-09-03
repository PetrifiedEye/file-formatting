# Phase 0 Research: RBAC

## Decision: Access configuration caching strategy

**Decision**: A single injectable `AccessConfigService` holds an in-memory snapshot
(`Map<roleId, Map<permissionName, Set<action> | 'ALL'>>`, plus lookup maps for role/permission
metadata) built by one query on `onModuleInit()`. Mutations (create/update/delete on role,
permission, or grant) call `reload()` on the same service inside the same transaction's
after-commit step, replacing the snapshot reference atomically (new object swapped in, never
mutated in place) so concurrent readers never see a partial rebuild.

**Rationale**: FR-002/FR-017/FR-018 require load-once-use-many with synchronous invalidation and no
partial/mixed state (edge case in spec). Swapping an immutable snapshot reference is the simplest
way to guarantee readers see either the old or the new configuration, never a mix, without locks.
No distributed cache is needed — this is a single-process NestJS service; no `cache-manager`/Redis
dependency exists in the repo and none is required by the spec (SC-001's 5s budget is trivially met
by an in-process rebuild).

**Alternatives considered**:
- Redis-backed shared cache: rejected — adds an infra dependency not present in the stack (see
  constitution's Technical Stack table) and not needed for a single-instance deployment; would only
  become relevant for horizontal scaling, which is out of scope.
- Query DB on every access check: rejected — explicitly disallowed by FR-002 ("rather than querying
  persistent storage on every request").
- Mutating the existing map in place under a lock: rejected — more complex than reference-swap and
  risks readers observing partial state during rebuild.

## Decision: Reload trigger mechanism

**Decision**: Reload is triggered synchronously, in-process, immediately after a successful
role/permission/grant mutation commits (service calls `accessConfigService.reload()` right after
the repository write). No polling, no pub/sub, no file watcher.

**Rationale**: Single-instance deployment (per constitution's stack — no message broker or Redis is
part of this backend). Synchronous in-process reload trivially satisfies "without restart" (FR-017)
and the 5-second SLA (SC-001) since it completes before the HTTP response is sent. If the deployment
later becomes multi-instance, cross-instance invalidation (e.g., LISTEN/NOTIFY or a pub/sub) would
be a separate follow-up feature — flagged as a future concern, not a blocker here.

**Alternatives considered**: Postgres `LISTEN/NOTIFY` for cross-instance invalidation — rejected as
premature: no multi-instance requirement exists in the spec or current deployment.

## Decision: Reload failure handling

**Decision**: `reload()` builds the new snapshot from a DB query *before* swapping it in. If the
query throws (storage unavailable), the swap is skipped, the previous snapshot remains active, and
an audit record is written with a failure outcome and reason.

**Rationale**: Matches the spec's edge case directly ("system retains the last known good
configuration ... records a reload failure in audit logs").

## Decision: Permission/action data shape

**Decision**: `permissions.actions` is a Postgres `text[]` column (validated non-empty via
`class-validator` at the API boundary). `grants.actions` is a nullable `text[]`; `NULL`/empty means
"all actions on the linked permission" (FR-004). Grant actions are validated as a subset of the
permission's actions at create/update time (FR-015) and re-validated implicitly on every reload
build (if a permission's actions shrink after a grant was created, the in-memory snapshot only
includes the intersection, satisfying the "removed action" edge case without a migration/backfill
step).

**Rationale**: `text[]` keeps the schema simple and avoids a separate `permission_actions` table
for what the spec treats as an atomic list attribute of a permission. Enforcing the subset rule at
both write-time and snapshot-build-time (not just write-time) handles the edge case where a
permission's actions are narrowed after a grant already exists.

**Alternatives considered**: Normalized `permission_actions` table — rejected as unnecessary
complexity; actions are never queried independently of their owning permission.

## Decision: Current-user resolution seam for `PermissionGuard`

**Decision**: `PermissionGuard` (paired with a `@RequirePermission(permission, action?)` decorator)
reads `request.user` and expects the shape `{ id: string; roles: string[] }` (role *names*, matching
what `AccessConfigService` indexes). If `request.user` is absent, the guard denies with 401
(unauthenticated) — matching Acceptance Scenario 6 ("unauthenticated user ... denied before RBAC
evaluation"). The guard itself does not authenticate; it only evaluates roles already resolved onto
the request.

**Rationale**: The spec's Assumptions state "User authentication is already in place; RBAC runs
after the user is identified" — but this repository currently has no login/session/JWT feature
(`AuthModule` only covers registration/confirmation; `AdminGuard` in `settings` is an explicit
`// TODO: Replace with real admin authentication` placeholder that always returns `true`). Building
a full auth session mechanism is out of scope for this feature. Defining the `request.user` contract
now lets RBAC be implemented and tested (with a test-only request-user shim) independently, and lets
a future auth feature satisfy the contract by populating `request.user` (e.g., via a session/JWT
guard run earlier in the chain) without any RBAC-side changes.

**Alternatives considered**:
- Build minimal session auth as part of this feature: rejected — explicitly out of scope per spec
  Assumptions ("User authentication is already in place").
- Have `PermissionGuard` query `user_roles` directly by a user id pulled from an unspecified source:
  rejected — same problem, just deferred; still needs a real "who is the current user" source that
  doesn't exist yet. Keeping the seam at `request.user` is the smallest, most explicit contract.

## Decision: Admin authorization for RBAC management endpoints

**Decision**: RBAC management endpoints (`/rbac/roles`, `/rbac/permissions`, `/rbac/grants`) are
protected by a `PermissionGuard` check against a reserved built-in permission `rbac` with actions
`manage` (or per-entity actions `manage-roles`/`manage-permissions`/`manage-grants` — resolved below
as a single `rbac:manage` gate for simplicity), rather than a separate hardcoded `AdminGuard`. This
makes "administrator" itself just "a user whose role(s) grant `rbac` `manage`" — RBAC governs its
own management surface, consistent with FR-016 and avoiding a second, parallel authorization
mechanism.

**Rationale**: Avoids maintaining two competing authorization systems (a hardcoded admin check vs.
RBAC). It also means the bootstrap admin (spec Assumption: "a designated Admin role ... exists ...
Initial bootstrap of the first administrator is handled by existing deployment or setup processes")
is just a seeded role/permission/grant/user-role row, which a migration or seed script can create.

**Alternatives considered**: Keep a separate `AdminGuard` (boolean, non-RBAC) purely for RBAC's own
CRUD endpoints — rejected as a redundant, parallel privilege model that FR-016 doesn't require and
that would need its own bootstrap/audit story.

## Decision: Audit log storage

**Decision**: New `rbac_audit_events` table, following the existing `registration_audit_events`
pattern (`RegistrationAuditService` in `src/modules/auth/`): enum `eventType`
(`ROLE_CREATED`/`ROLE_UPDATED`/`ROLE_DELETED`/`PERMISSION_CREATED`/.../`GRANT_CREATED`/.../
`CONFIG_RELOADED`/`CONFIG_RELOAD_FAILED`/`ACCESS_DENIED_MANAGEMENT`), enum `outcome`
(`SUCCESS`/`FAILURE`), `actorUserId`, `entityType`, `entityId` (nullable), `metadata` (jsonb, no
secrets), `createdAt`. Indexed on `(eventType, createdAt)` for retrieval (SC-004).

**Rationale**: Reuses an established, constitution-compliant pattern already in the codebase rather
than inventing a new audit shape.
