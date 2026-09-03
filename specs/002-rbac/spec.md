# Feature Specification: Role-Based Access Control (RBAC)

**Feature Branch**: `002-rbac`

**Created**: 2026-09-02

**Status**: Draft

**Input**: User description: "RBAC — centralized access control based on roles and permissions. Configuration (roles, permissions, grants) stored in the database and applied without application restart. Access checks use permission + action; admin manages roles, permissions, and grants; cache invalidation on changes; audit logging."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Access check for protected actions (Priority: P1)

An authenticated user attempts an action that requires a specific permission (for example, viewing a list of users). The system evaluates the user's assigned roles against the loaded access configuration. If any role grants the required permission and action, the request proceeds. Otherwise, the user is denied access with a clear forbidden outcome.

**Why this priority**: Access enforcement is the core purpose of RBAC. Without it, roles and permissions have no effect.

**Independent Test**: Assign a user a role with a known grant, attempt an allowed action and a disallowed action, and verify allow/deny outcomes without changing any admin configuration.

**Acceptance Scenarios**:

1. **Given** a user with a role that grants permission `users` with action `read`, **When** the user requests an action requiring `users` + `read`, **Then** access is allowed and the requested operation proceeds.
2. **Given** a user whose roles do not grant permission `users` with action `delete`, **When** the user requests an action requiring `users` + `delete`, **Then** access is denied with a forbidden outcome.
3. **Given** a user with multiple roles where at least one role grants the required permission and action, **When** the user requests that action, **Then** access is allowed.
4. **Given** a grant that assigns a permission without specifying actions (full permission), **When** the user requests any valid action defined for that permission, **Then** access is allowed.
5. **Given** a grant that assigns a permission with specific actions only, **When** the user requests an action not listed in the grant, **Then** access is denied even if the permission exists.
6. **Given** an unauthenticated user, **When** any protected action is requested, **Then** access is denied before RBAC evaluation (authentication required).

---

### User Story 2 - Load access configuration at startup (Priority: P1)

When the application starts, the system loads all roles, permissions, and grants from persistent storage into an in-memory access configuration ready for enforcement. Administrators and users can rely on consistent access decisions immediately after startup.

**Why this priority**: Enforcement depends on a complete, initialized configuration. Startup load is required for any access check to work correctly.

**Independent Test**: Seed the database with known roles, permissions, and grants, restart the application, and verify access decisions match the seeded configuration without manual intervention.

**Acceptance Scenarios**:

1. **Given** roles, permissions, and grants exist in persistent storage, **When** the application starts, **Then** the full access configuration is loaded and ready for checks.
2. **Given** the configuration is loaded, **When** an access check runs, **Then** it uses the loaded configuration rather than querying persistent storage on every request.
3. **Given** persistent storage contains no roles or grants, **When** the application starts, **Then** the system starts with an empty configuration and all permission checks deny access (except where explicitly exempt).

---

### User Story 3 - Dynamic configuration update without restart (Priority: P2)

An administrator changes roles, permissions, or grants in persistent storage. The system detects the change, clears any cached configuration, reloads from storage, and applies the new rules to subsequent access checks — without restarting the application.

**Why this priority**: Dynamic updates are a primary business benefit (change permissions without deployment). Depends on P1 enforcement and startup load being in place.

**Independent Test**: Change a grant while the application is running, then immediately retry an access check and verify the new rule applies.

**Acceptance Scenarios**:

1. **Given** a running application with a loaded configuration, **When** an administrator adds a new grant for a role, **Then** users with that role gain the new access on the next check without restart.
2. **Given** a running application, **When** an administrator removes or narrows a grant, **Then** affected users lose that access on the next check without restart.
3. **Given** a configuration change, **When** the cache is invalidated and configuration reload completes, **Then** an audit record is created for the reload event.
4. **Given** a configuration reload is in progress, **When** access checks occur, **Then** the system uses a consistent configuration snapshot (no partial or mixed rules).

---

### User Story 4 - Admin manages roles (Priority: P2)

An administrator with management privileges creates, views, updates, and deletes roles. Role names are unique. Roles cannot be deleted while active grant assignments still reference them.

**Why this priority**: Roles are the foundation of the role-permission model; admin management enables ongoing governance.

**Independent Test**: Create a role, list roles, update its description, attempt duplicate creation, attempt deletion with and without dependent grants.

**Acceptance Scenarios**:

1. **Given** an administrator with management access, **When** they create a role with a unique name, **Then** the role is persisted and appears in the role list.
2. **Given** a role name already exists, **When** the administrator attempts to create another role with the same name, **Then** the operation is rejected with a conflict outcome.
3. **Given** a role with no grant assignments, **When** the administrator deletes it, **Then** the role is removed from persistent storage and subsequent configuration reloads exclude it.
4. **Given** a role referenced by one or more grants, **When** the administrator attempts to delete it, **Then** the operation is rejected and the role remains.
5. **Given** a non-administrator user, **When** they attempt any role management operation, **Then** access is denied.

---

### User Story 5 - Admin manages permissions (Priority: P2)

An administrator defines permissions — each with a unique identifier and a list of valid actions (for example `create`, `update`, `delete`). Permissions cannot be deleted while grant assignments still reference them.

**Why this priority**: Permissions define what can be controlled; grants attach them to roles.

**Independent Test**: Create a permission with defined actions, update its action list, attempt duplicate creation, attempt deletion with and without dependent grants.

**Acceptance Scenarios**:

1. **Given** an administrator with management access, **When** they create a permission with a unique name and a non-empty actions list, **Then** the permission is persisted and available for grants.
2. **Given** a permission name already exists, **When** the administrator attempts to create a duplicate, **Then** the operation is rejected with a conflict outcome.
3. **Given** a permission referenced by grants, **When** the administrator attempts to delete it, **Then** the operation is rejected.
4. **Given** an administrator updates a permission's actions list, **When** configuration reloads, **Then** access checks validate actions against the updated list.
5. **Given** a non-administrator user, **When** they attempt any permission management operation, **Then** access is denied.

---

### User Story 6 - Admin manages grants (assignments) (Priority: P2)

An administrator links roles to permissions through grants. A grant may specify all actions for a permission (when actions are omitted or empty) or a subset of actions. Duplicate grants for the same role-permission pair are not allowed.

**Why this priority**: Grants are the binding layer that gives roles their effective permissions.

**Independent Test**: Create a grant with full and partial actions, list grants, update action scope, reject duplicates, delete grants.

**Acceptance Scenarios**:

1. **Given** an existing role and permission, **When** the administrator creates a grant without specifying actions, **Then** the role receives all actions defined on that permission.
2. **Given** an existing role and permission, **When** the administrator creates a grant with specific actions, **Then** the role receives only those actions for that permission.
3. **Given** a grant already exists for a role-permission pair, **When** the administrator attempts to create another grant for the same pair, **Then** the operation is rejected with a conflict outcome.
4. **Given** a grant with actions outside the permission's allowed actions, **When** the administrator creates or updates the grant, **Then** the operation is rejected as invalid.
5. **Given** a non-administrator user, **When** they attempt any grant management operation, **Then** access is denied.

---

### User Story 7 - Audit RBAC changes and access reloads (Priority: P3)

The system records who performed RBAC management operations and the outcome, as well as configuration cache invalidation and reload events. Audit records support security review without exposing secrets.

**Why this priority**: Auditability supports compliance and troubleshooting but is not required for basic enforcement.

**Independent Test**: Perform create/update/delete on roles, permissions, and grants; trigger a configuration reload; verify audit entries contain actor, operation, entity type, and result.

**Acceptance Scenarios**:

1. **Given** an administrator creates, updates, or deletes a role, permission, or grant, **When** the operation completes, **Then** an audit entry records the actor, operation type, entity type, and success or failure outcome.
2. **Given** a configuration reload after a change, **When** reload completes, **Then** an audit entry records the reload event.
3. **Given** a denied management attempt (forbidden or validation failure), **When** the attempt occurs, **Then** an audit entry records the actor, attempted operation, and denial reason category.

---

### Edge Cases

- What happens when a user's assigned role no longer exists in the configuration after a reload? Access checks treat unknown roles as having no grants for that role; other valid roles may still grant access.
- What happens when a permission is updated to remove an action that an existing grant relied on? After reload, checks for that removed action are denied even if the grant still lists it (grant actions must stay within permission actions).
- What happens when two administrators change configuration concurrently? The system applies a consistent final state after reload; no grant duplicates or orphaned references are persisted.
- What happens when persistent storage is temporarily unavailable during reload? The system retains the last known good configuration for checks and records a reload failure in audit logs.
- What happens when a user has no roles assigned? All permission checks result in denial unless the requested action is explicitly public (out of RBAC scope).
- What happens when an access check references a permission that does not exist? Access is denied.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST evaluate access for authenticated users based on their assigned roles, the requested permission identifier, and the requested action.
- **FR-002**: System MUST load roles, permissions, and grants from persistent storage into an access configuration when the application starts.
- **FR-003**: System MUST deny access with a forbidden outcome when no matching grant exists for the user's roles, permission, and action.
- **FR-004**: System MUST treat a grant with no specified actions (or empty actions) as granting all actions defined on the linked permission.
- **FR-005**: System MUST treat a grant with specified actions as granting only those actions for the linked permission.
- **FR-006**: System MUST allow an administrator to list, create, update, and delete roles.
- **FR-007**: System MUST enforce unique role names.
- **FR-008**: System MUST prevent deletion of a role that is referenced by one or more grants.
- **FR-009**: System MUST allow an administrator to list, create, update, and delete permissions.
- **FR-010**: System MUST enforce unique permission names.
- **FR-011**: Each permission MUST define the set of valid actions that can be granted (for example `create`, `update`, `delete`).
- **FR-012**: System MUST prevent deletion of a permission that is referenced by one or more grants.
- **FR-013**: System MUST allow an administrator to list, create, update, and delete grants linking roles to permissions.
- **FR-014**: System MUST prevent duplicate grants for the same role-permission pair.
- **FR-015**: System MUST validate that grant actions are a subset of the linked permission's allowed actions.
- **FR-016**: System MUST restrict role, permission, and grant management operations to administrators only.
- **FR-017**: System MUST invalidate cached access configuration and reload from persistent storage when RBAC data changes, without requiring application restart.
- **FR-018**: System MUST apply reloaded configuration to all access checks that occur after reload completes.
- **FR-019**: System MUST log audit records for RBAC management operations including actor identity, operation (create/update/delete), entity type (role/permission/grant), and outcome.
- **FR-020**: System MUST log audit records when access configuration cache is cleared and reloaded.
- **FR-021**: System MUST reject access checks for permissions or actions that do not exist in the loaded configuration.
- **FR-022**: System MUST support users carrying one or more roles when evaluating access (union of grants across all assigned roles).

### Key Entities

- **Role**: A named access profile (identifier, display name, optional description). Users are assigned one or more roles. Roles do not directly encode permissions — grants provide that linkage.
- **Permission**: A named resource capability with a defined set of valid actions. The permission name is the identifier used during access checks (for example `users`, `reports`).
- **Grant (Assignment)**: A link between a role and a permission, optionally scoped to specific actions. When actions are omitted, all actions on the permission are granted.
- **Access Configuration**: The in-memory snapshot of all roles, permissions, and grants used for enforcement. Refreshed at startup and after administrative changes.
- **Audit Record**: A log entry capturing who changed RBAC data or triggered a configuration reload, what changed, and whether the operation succeeded or failed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Administrators can add or revoke a role's access to a permission and have the change take effect for subsequent requests within 5 seconds, without restarting the application.
- **SC-002**: 100% of access checks for users without a matching grant result in denial; 100% of checks with a valid matching grant result in allowance, in repeatable test scenarios.
- **SC-003**: Administrators can complete full CRUD workflows for roles, permissions, and grants (create, list, update, delete where allowed) in under 2 minutes per entity type in acceptance testing.
- **SC-004**: Every RBAC management operation and configuration reload produces an audit record retrievable for security review within 1 minute of the operation.
- **SC-005**: After application restart, access decisions match the persistent configuration with zero manual reconfiguration steps.
- **SC-006**: Duplicate role names, duplicate permission names, and duplicate role-permission grants are rejected 100% of the time in validation testing.

## Assumptions

- User authentication is already in place; RBAC runs after the user is identified. Unauthenticated requests are handled by the authentication layer, not RBAC.
- Assigning roles to users (user-role membership) is managed outside this feature's CRUD scope but MUST be available so that access checks receive the user's role list.
- A designated **Admin** role (or equivalent) exists with privileges to manage roles, permissions, and grants. Initial bootstrap of the first administrator is handled by existing deployment or setup processes.
- Permission identifiers and action names follow a consistent naming convention agreed by the product team; invalid formats are rejected at management time.
- Optional caching of the access configuration is permitted for performance; cache invalidation on RBAC data change is mandatory regardless of caching strategy.
- Deleting roles or permissions with dependent grants is blocked (not cascaded) to prevent accidental loss of access rules; administrators must remove grants first.
- Public or unauthenticated endpoints are explicitly excluded from RBAC and documented separately.
- Rate limiting and input validation on management operations follow platform-wide standards already defined for admin APIs.
