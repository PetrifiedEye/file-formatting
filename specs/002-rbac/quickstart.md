# Quickstart: Validating RBAC

## Prerequisites

- Local stack running (Postgres + app) via the existing dev setup (`docker compose up`, then
  `npm run start:dev`), same as for `001-user-registration`.
- Migrations applied (`npm run migration:run` or `POSTGRES_MIGRATIONS_RUN=true`) so `roles`,
  `permissions`, `grants`, `user_roles`, `rbac_audit_events` exist.
- A seeded admin user with a role granting `rbac`:`manage` (see data-model.md — bootstrap is via
  migration/seed script, not an API call, per spec Assumptions). For local validation, insert
  directly:

```sql
INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'admin') RETURNING id;
INSERT INTO permissions (id, name, actions) VALUES (gen_random_uuid(), 'rbac', ARRAY['manage']) RETURNING id;
-- link the two ids above via grants, and link the admin role id to a test user id via user_roles
```

## Scenario 1 — Startup load (User Story 2)

1. Seed a role, a permission with actions `['read','write']`, and a grant linking them with
   `actions = ['read']`.
2. Start the app.
3. Call a route guarded by `@RequirePermission('that-permission', 'read')` as a user with that
   role → expect `200`.
4. Call the same route requiring action `write` → expect `403`.

## Scenario 2 — Access check allow/deny (User Story 1)

1. As a user with no roles, call any `@RequirePermission`-guarded route → expect `403`.
2. As an unauthenticated request (no `request.user`), call the same route → expect `401`.
3. Assign the user two roles, only one of which grants the required permission+action → expect
   `200` (union across roles, FR-022).

## Scenario 3 — Dynamic update without restart (User Story 3)

1. With the app running, `POST /rbac/grants` adding a new role→permission grant.
2. Immediately (no restart) retry an access check for that permission+action as a user with that
   role → expect it to now succeed.
3. `DELETE` the grant → retry the same check → expect it to now fail.
4. Confirm an `rbac_audit_events` row with `event_type = config_reloaded` exists for each change.

## Scenario 4 — Admin CRUD + conflict handling (User Stories 4–6)

1. `POST /rbac/roles` with a new name → `201`. Repeat with the same name → `409`.
2. `POST /rbac/permissions` with `actions: []` → `422`.
3. `POST /rbac/grants` with `actions` containing a value not in the permission's actions → `422`.
4. `POST /rbac/grants` twice for the same `(roleId, permissionId)` → second call `409`.
5. `DELETE /rbac/roles/:id` for a role referenced by a grant → `409`; delete the grant first, then
   retry → `204`.
6. Repeat all of the above as a non-admin user → every call `403`.

## Scenario 5 — Audit trail (User Story 7)

1. Perform one create, one update, one delete across roles/permissions/grants.
2. Query `rbac_audit_events` ordered by `created_at` → verify each row has `actor_user_id`,
   `event_type`, `entity_type`, `entity_id`, and `outcome = success`.
3. Attempt a management call as a non-admin → verify a `management_access_denied` row with
   `outcome = failure`.

## Running the automated checks

```bash
npm run test -- rbac
npm run test:e2e
```

See [contracts/rbac-api.md](./contracts/rbac-api.md) for the full endpoint list and
[data-model.md](./data-model.md) for entity/validation details.
