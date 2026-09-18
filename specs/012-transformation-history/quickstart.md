# Quickstart: Transformation History

Validates the feature end-to-end against a running instance. Full contract:
[contracts/transformation-history-api.md](./contracts/transformation-history-api.md).
Field/entity detail: [data-model.md](./data-model.md).

## Prerequisites

- Local stack running per the project `README.md` (Postgres reachable,
  migrations applied — `npm run migration:run`).
- Two accounts: a plain user (`user@example.com`) and one whose role holds
  the default `admin` grant (`admin@example.com`) — the seeded admin from
  `RbacSeedAdmin` migration, or any account granted the `admin` role via the
  RBAC API.
- At least one completed file conversion (`POST /api/convert`) and one
  completed image conversion (`POST /api/images/convert`) run as the plain
  user beforehand, so there is history to read back. A failed attempt of
  each (e.g. an unsupported `targetFormat`) is useful too, to exercise the
  `status=error`/`errorCode` path.

## Setup

```bash
npm run migration:run
npm run start:dev
```

Sign in as each account to obtain the `access_token` cookie:

```bash
curl -i -c user.cookies -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"<password>"}'

curl -i -c admin.cookies -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<password>"}'
```

## Scenario 1 — Self history, unfiltered (User Story 1)

```bash
curl -s -b user.cookies http://localhost:3000/api/transformations/history | jq
```

**Expect**: 200, `items` containing the file and image attempts made by this
user (most recent first), `nextCursor: null` if fewer than 20 records exist.
Each item has `id`, `type`, `sourceFormat`, `targetFormat`, `status`,
`fileSize`, `durationMs`, `createdAt`, and `errorCode` only on the failed one.

## Scenario 2 — Admin reads a specific user's history (User Story 2)

```bash
USER_ID="<user@example.com's account id>"
curl -s -b admin.cookies http://localhost:3000/api/transformations/history/$USER_ID | jq
```

**Expect**: 200, same shape as Scenario 1, scoped to that user's own
records only.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -b admin.cookies \
  http://localhost:3000/api/transformations/history/00000000-0000-0000-0000-000000000000
```

**Expect**: `404` — a well-formed but non-existent account id.

## Scenario 3 — Denied without the oversight permission (User Story 3)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -b user.cookies \
  http://localhost:3000/api/transformations/history/$USER_ID
```

**Expect**: `403`, regardless of whether `$USER_ID` exists.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/transformations/history
```

**Expect**: `401` (no cookie sent).

## Scenario 4 — Filtering (User Story 4)

```bash
curl -s -b user.cookies \
  'http://localhost:3000/api/transformations/history?type=image&status=error' | jq
```

**Expect**: 200, only image-type, error-status records — or an empty
`items` array with 200 if none match, never an error.

## Scenario 5 — Invalid requests rejected (User Story 5)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -b user.cookies \
  'http://localhost:3000/api/transformations/history?limit=500'
curl -s -o /dev/null -w '%{http_code}\n' -b user.cookies \
  'http://localhost:3000/api/transformations/history?type=archive'
curl -s -o /dev/null -w '%{http_code}\n' -b user.cookies \
  'http://localhost:3000/api/transformations/history?cursor=not-a-real-cursor'
curl -s -o /dev/null -w '%{http_code}\n' -b user.cookies \
  'http://localhost:3000/api/transformations/history?createdAtFrom=2026-09-18T00:00:00Z&createdAtTo=2026-09-01T00:00:00Z'
```

**Expect**: `400` for all four.

## Scenario 6 — Pagination is idempotent (FR-009)

```bash
PAGE1=$(curl -s -b user.cookies 'http://localhost:3000/api/transformations/history?limit=1')
CURSOR=$(echo "$PAGE1" | jq -r .nextCursor)
curl -s -b user.cookies "http://localhost:3000/api/transformations/history?limit=1&cursor=$CURSOR" | jq
```

Repeat the second call: it MUST return the same page both times (as long as
no new transformation completes in between).

## Scenario 7 — Audit trail (User Story 6)

After running Scenarios 1–3, inspect
`transformation_history_audit_events` directly (e.g. via `psql`):

```sql
SELECT actor_user_id, target_user_id, outcome, result_count, created_at
FROM transformation_history_audit_events
ORDER BY created_at DESC
LIMIT 10;
```

**Expect**: one row per request above, `outcome` matching the HTTP result
(`success`, `denied`, `not_found`, `unauthenticated`), `target_user_id`
populated only for the admin-route rows, and no column containing file or
image content.
