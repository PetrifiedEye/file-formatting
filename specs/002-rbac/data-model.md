# Phase 1 Data Model: RBAC

## Role

Table: `roles`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, generated |
| name | citext | unique, not null |
| description | varchar(500) | nullable |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

- Index: unique on `name` (FR-007).
- Relationships: referenced by `grants.role_id`, `user_roles.role_id`.
- Deletion rule: reject delete if any `grants` row references this role (FR-008) — checked in a
  transaction before delete.

## Permission

Table: `permissions`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, generated |
| name | citext | unique, not null |
| description | varchar(500) | nullable |
| actions | text[] | not null, non-empty (validated at API layer) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

- Index: unique on `name` (FR-010).
- Relationships: referenced by `grants.permission_id`.
- Deletion rule: reject delete if any `grants` row references this permission (FR-012).
- Update rule: updating `actions` to remove an action that an existing grant lists does not fail
  the update (grants aren't cascaded); the *next* `AccessConfigService.reload()` intersects each
  grant's stored actions with the permission's current actions, so the removed action stops being
  grantable (spec edge case).

## Grant

Table: `grants`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, generated |
| role_id | uuid | not null, FK → roles(id), ON DELETE RESTRICT |
| permission_id | uuid | not null, FK → permissions(id), ON DELETE RESTRICT |
| actions | text[] | nullable — NULL/empty = all actions on the linked permission (FR-004) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

- Unique index on `(role_id, permission_id)` — no duplicate grants for the same pair (FR-014).
- Index on `role_id` and on `permission_id` for lookup/reload queries and FK checks.
- Validation (service-layer, at create/update): if `actions` is non-empty, every element MUST be a
  member of the linked permission's `actions` (FR-015); otherwise reject as invalid (422).
- `ON DELETE RESTRICT` on both FKs enforces FR-008/FR-012 at the DB layer as a backstop to the
  service-layer check.

## UserRole (membership — no dedicated CRUD API per spec Assumptions)

Table: `user_roles`

| Column | Type | Constraints |
|--------|------|-------------|
| user_id | uuid | not null, FK → users(id), ON DELETE CASCADE |
| role_id | uuid | not null, FK → roles(id), ON DELETE CASCADE |
| created_at | timestamptz | not null, default now() |

- Composite PK `(user_id, role_id)` — a user cannot hold the same role twice.
- Index on `role_id` (reverse lookups, e.g. "which users have role X" for admin tooling later).
- Out of scope for this feature: endpoints to assign/revoke a user's roles. This table exists so
  `AccessConfigService`/`PermissionGuard` and future user-management work have a place to read
  from; seeding/assignment happens via migration/seed script or a follow-up feature.

## AuditEvent (RBAC-specific)

Table: `rbac_audit_events`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, generated |
| event_type | enum | not null — see values below |
| outcome | enum | not null — `success` \| `failure` |
| actor_user_id | uuid | nullable (FK → users(id), no cascade — audit rows outlive user deletion intent, so `ON DELETE SET NULL`) |
| entity_type | enum | nullable — `role` \| `permission` \| `grant` \| `config` |
| entity_id | uuid | nullable |
| reason | varchar(255) | nullable — denial/failure reason category |
| metadata | jsonb | not null, default `{}` — no secrets |
| created_at | timestamptz | not null, default now() |

`event_type` values: `role_created`, `role_updated`, `role_deleted`, `permission_created`,
`permission_updated`, `permission_deleted`, `grant_created`, `grant_updated`, `grant_deleted`,
`config_reloaded`, `config_reload_failed`, `management_access_denied`.

- Index on `(event_type, created_at)` for SC-004 retrieval.
- Index on `actor_user_id` for per-actor audit review.

## In-memory Access Configuration (not persisted)

Built by `AccessConfigService` from the above tables:

```text
AccessSnapshot {
  roles: Map<roleId, { name, description }>
  permissions: Map<permissionId, { name, actions: Set<string> }>
  // effective grants, keyed by role NAME (what request.user.roles carries) then permission NAME
  grantsByRole: Map<roleName, Map<permissionName, Set<action> | 'ALL'>>
}
```

`hasPermission(roleNames: string[], permission: string, action: string): boolean` — for each role
name in the user's roles, look up `grantsByRole`; if a grant entry exists for `permission` and
either it is `'ALL'` or its action set contains `action`, return `true` (union across roles per
FR-022). If `permission` isn't a key in `permissions` at all, deny (FR-021).

## Validation Rules Summary

- Role name: required, unique, 1–100 chars.
- Permission name: required, unique, 1–100 chars; actions: required, non-empty array of 1–50 char
  strings, each unique within the permission.
- Grant: role and permission must exist; actions (if provided) must be a non-empty subset of the
  permission's actions; (role_id, permission_id) must be unique.
- All management DTOs validated via `class-validator` + global `ValidationPipe({ whitelist: true })`
  per constitution Principle II.

## State Transitions

- Role/Permission: none beyond existence (no soft-delete/status field required by spec).
- Grant: create → (optional) update actions → delete. No partial states.
- Access Configuration: `UNINITIALIZED → LOADED` at startup; `LOADED → LOADED` on each successful
  reload (atomic swap); on reload failure, stays on the previous `LOADED` snapshot and records
  `config_reload_failed`.
