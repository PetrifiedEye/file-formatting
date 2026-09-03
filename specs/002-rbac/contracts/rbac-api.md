# RBAC API Contract

Base path: `/rbac`. All endpoints below require an authenticated request whose resolved roles grant
`rbac` permission with action `manage` (see [research.md](../research.md#decision-admin-authorization-for-rbac-management-endpoints)),
enforced by `PermissionGuard` + `@RequirePermission('rbac', 'manage')`. Unauthenticated → `401`.
Authenticated but not authorized → `403` (and an `management_access_denied` audit record).

Response envelopes follow the existing convention in `auth`/`settings` (plain DTO objects, Swagger
`@Api...Response` decorators mirroring the DTOs).

## Roles — `/rbac/roles`

| Method | Path | Description | Success | Errors |
|--------|------|--------------|---------|--------|
| GET | `/rbac/roles` | List all roles | 200, `RoleResponseDto[]` | — |
| POST | `/rbac/roles` | Create role (`name`, `description?`) | 201, `RoleResponseDto` | 409 duplicate name, 422 validation |
| PATCH | `/rbac/roles/:id` | Update role (`name?`, `description?`) | 200, `RoleResponseDto` | 404 not found, 409 duplicate name, 422 validation |
| DELETE | `/rbac/roles/:id` | Delete role | 204 | 404 not found, 409 has dependent grants |

## Permissions — `/rbac/permissions`

| Method | Path | Description | Success | Errors |
|--------|------|--------------|---------|--------|
| GET | `/rbac/permissions` | List all permissions | 200, `PermissionResponseDto[]` | — |
| POST | `/rbac/permissions` | Create (`name`, `description?`, `actions: string[]`) | 201, `PermissionResponseDto` | 409 duplicate name, 422 empty/invalid actions |
| PATCH | `/rbac/permissions/:id` | Update (`name?`, `description?`, `actions?`) | 200, `PermissionResponseDto` | 404 not found, 409 duplicate name, 422 validation |
| DELETE | `/rbac/permissions/:id` | Delete | 204 | 404 not found, 409 has dependent grants |

## Grants — `/rbac/grants`

| Method | Path | Description | Success | Errors |
|--------|------|--------------|---------|--------|
| GET | `/rbac/grants` | List all grants (optionally `?roleId=` / `?permissionId=`) | 200, `GrantResponseDto[]` | — |
| POST | `/rbac/grants` | Create (`roleId`, `permissionId`, `actions?: string[]`) | 201, `GrantResponseDto` | 404 role/permission not found, 409 duplicate role+permission pair, 422 actions not subset of permission actions |
| PATCH | `/rbac/grants/:id` | Update (`actions?: string[]`) | 200, `GrantResponseDto` | 404 not found, 422 actions not subset |
| DELETE | `/rbac/grants/:id` | Delete | 204 | 404 not found |

Every successful create/update/delete above triggers `AccessConfigService.reload()` synchronously
before the response is returned, and writes an `rbac_audit_events` row (`*_created`/`*_updated`/
`*_deleted` + `config_reloaded`, or `config_reload_failed` if the reload's DB read fails).

## Access check (internal contract, not an HTTP endpoint)

`AccessConfigService.hasPermission(roleNames: string[], permission: string, action: string): boolean`
— consumed by `PermissionGuard`, usable directly by other modules that need a programmatic check
outside of a guarded route.

`@RequirePermission(permission: string, action: string)` — method/class decorator setting route
metadata read by `PermissionGuard`.

### Example: protecting an existing route

```ts
@RequirePermission('users', 'read')
@UseGuards(PermissionGuard)
@Get()
findAll() { ... }
```

- `PermissionGuard` order: 401 if `request.user` missing → 403 if `hasPermission(...)` is false →
  otherwise allow (Acceptance Scenario 6; FR-001/FR-003).
