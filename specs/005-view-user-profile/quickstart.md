# Quickstart: View User Profile

Validates the feature end-to-end against a running local backend + Postgres.
See [contracts/get-users-userId.md](./contracts/get-users-userId.md) for the
full response contract and [data-model.md](./data-model.md) for field
definitions.

## Prerequisites

1. Backend running locally with migrations applied (includes the new
   `photo_url` column and `users` permission seed added by this feature):
   ```bash
   npm run migration:run
   npm run start:dev
   ```
2. Two test users already exist (via the registration flow, 001), both
   `active`:
   - **Self user** (`alice@example.com`) — no special roles.
   - **Target user** (`bob@example.com`) — no special roles.
3. A third user (**privileged**, `carol@example.com`) with a role granted
   `users:read` (create the grant via `POST /rbac/grants` per the RBAC feature,
   002, after this feature's migration seeds the `users` permission).

## Scenario 1 — Self view (Story 1)

```bash
curl -i -b alice_cookies.txt https://localhost:PORT/users/<alice-id>
```

**Expect**: `200`, body contains `id`, `email`, `photo`, `status`, `createdAt`
for Alice — regardless of Alice's roles.

## Scenario 2 — Privileged view (Story 2)

```bash
curl -i -b carol_cookies.txt https://localhost:PORT/users/<bob-id>
```

**Expect**: `200`, body contains only `id` and `photo` — no `email`, no other
field, even though Bob has them.

## Scenario 3 — Denied (Story 3)

```bash
curl -i -b alice_cookies.txt https://localhost:PORT/users/<bob-id>
curl -i -b alice_cookies.txt https://localhost:PORT/users/<random-nonexistent-uuid>
```

**Expect**: Both `403`. The second call (nonexistent target) MUST also be
`403`, not `404` — existence is never disclosed to an unauthorized viewer.

## Scenario 4 — Unauthenticated / not found (Story 4)

```bash
curl -i https://localhost:PORT/users/<alice-id>          # no cookie
curl -i -b carol_cookies.txt https://localhost:PORT/users/<random-nonexistent-uuid>
curl -i -b carol_cookies.txt https://localhost:PORT/users/not-a-uuid
```

**Expect**: First call `401`. Second and third (Carol has `users:read`) →
`404` for both — malformed and nonexistent ids are indistinguishable.

## Scenario 5 — Audit trail (Story 5, best-effort)

After running scenarios 1–4, inspect the `user_profile_audit_events` table:

```sql
SELECT viewer_id, target_id, outcome, created_at
FROM user_profile_audit_events
ORDER BY created_at DESC
LIMIT 10;
```

**Expect**: One row per request above, `outcome` matching the response
(`SELF_VIEW`, `PRIVILEGED_VIEW`, `DENIED`, `NOT_FOUND`), and no column
containing `email`/`photo` values.

## Automated coverage

Run the full automated suite instead of manual curl once implemented:

```bash
npm run test          # unit: UsersService field-filtering + access decision
npm run test:e2e -- users-profile   # e2e: all scenarios above
```
