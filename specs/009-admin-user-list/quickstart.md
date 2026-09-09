# Quickstart: Admin User Directory

Validates the feature end-to-end against a running local backend + Postgres.
See [contracts/user-directory.md](./contracts/user-directory.md) for the HTTP
contract and [data-model.md](./data-model.md) for fields and indexes.

## Prerequisites

1. Backend running locally with migrations applied (includes `last_login_at`,
   directory indexes, `users.list` on the `users` permission, and the Admin
   grant):

   ```bash
   npm run migration:run
   npm run start:dev
   ```

2. At least 21 listable users so a default page (`limit=20`) produces a
   continuation token. Include a mix of `active` / `pending_confirmation`,
   some with photos, some who have never signed in (`last_login_at` null).

3. Three callers:

   | Caller | Setup |
   |---|---|
   | **Admin** | Role `admin` (seeded grant includes `users.list`) |
   | **Reader** | A role granted `users.read` only — not `users.list` |
   | **Anonymous** | No cookie |

   Log Admin and Reader in via `POST /auth/login` and save cookies
   (`admin_cookies.txt`, `reader_cookies.txt`).

Replace `PORT` with the local listen port.

## Scenario 1 — First page (Story 1)

```bash
curl -i -b admin_cookies.txt "http://localhost:PORT/users"
```

**Expect**: `200`. `items` length is 20. Each item has `id`, `email`,
`photo` (string or `null`), `createdAt`, `status`, `lastLoginAt` (string or
`null`). `nextCursor` is a non-empty string. No `passwordHash` or other
secrets. Default order is `createdAt` newest-first.

```bash
curl -i -b admin_cookies.txt \
  "http://localhost:PORT/users?limit=20&cursor=<nextCursor-from-previous>"
```

**Expect**: `200`. Item ids are disjoint from page 1. Repeating the same
URL returns the same ids.

When the last page is reached, `nextCursor` is `null`. If total users ≤
`limit`, the first call already has `nextCursor: null`.

## Scenario 2 — Search, filter, sort (Story 2)

```bash
curl -s -b admin_cookies.txt \
  "http://localhost:PORT/users?search=alice@example.com"
```

**Expect**: only users whose email contains that phrase (case-insensitive).

```bash
curl -s -b admin_cookies.txt \
  "http://localhost:PORT/users?search=<alice-uuid>"
```

**Expect**: Alice is included (exact id match) when her account is listable.

```bash
curl -s -b admin_cookies.txt \
  "http://localhost:PORT/users?status=pending_confirmation&sort=email&direction=asc"
```

**Expect**: every item has `status=pending_confirmation`, ordered by email
ascending. Combining `search` and `status` returns rows matching **both**.

Omitting all options matches Scenario 1 defaults (no search, all listable
statuses, `createdAt desc`).

## Scenario 3 — Denied without listing rights (Story 3)

```bash
curl -i -b reader_cookies.txt "http://localhost:PORT/users"
curl -i "http://localhost:PORT/users"
```

**Expect**: Reader → `403` with no `items`. Anonymous → `401` with no
`items`. A caller who can `GET /users/<other-id>` via `users.read` still
cannot list.

## Scenario 4 — Invalid options (Story 4)

```bash
curl -i -b admin_cookies.txt "http://localhost:PORT/users?limit=0"
curl -i -b admin_cookies.txt "http://localhost:PORT/users?limit=101"
curl -i -b admin_cookies.txt "http://localhost:PORT/users?status=blocked"
curl -i -b admin_cookies.txt "http://localhost:PORT/users?sort=displayName"
curl -i -b admin_cookies.txt "http://localhost:PORT/users?direction=up"
curl -i -b admin_cookies.txt "http://localhost:PORT/users?cursor=not-a-token"
```

**Expect**: each is `400` with no listing payload.

Reuse page 1's `nextCursor` with a **different** `search` or `sort`:

```bash
curl -i -b admin_cookies.txt \
  "http://localhost:PORT/users?search=zzz&cursor=<page1-cursor>"
```

**Expect**: `400` (fingerprint mismatch).

## Scenario 5 — Audit trail (Story 5)

After scenarios 1–4:

```sql
SELECT actor_id, outcome, result_count, search_used, status_filter_used,
       sort_field, created_at
FROM user_directory_audit_events
ORDER BY created_at DESC
LIMIT 20;
```

**Expect**: one row per attempt. Successful lists have `outcome = success`
and `result_count` equal to `items.length`. Reader → `denied`. Anonymous →
`unauthenticated`. Invalid options → `invalid`. Columns never contain email
addresses or the search phrase.

## Scenario 6 — Rate limit

From a single client, exceed 30 `GET /users` calls within 60 seconds (or
the global throttler, whichever fires first).

**Expect**: `429` for the overflow. Further calls succeed after the window
resets. An audit row with `outcome = rate_limited` is recorded.

## Scenario 7 — Deletion while paging

1. Request page 1 as Admin; keep `nextCursor`.
2. Delete (or start deleting) one account that appeared on page 1.
3. Request page 2 with the saved cursor.

**Expect**: `200`, not an error. The deleted/mid-deletion account is absent
from page 2. No duplicate ids from page 1.

## Automated coverage

```bash
npm run test                 # unit: keyset, filters, allow-list, cursor HMAC, audit
npm run test:e2e -- users-directory
```
