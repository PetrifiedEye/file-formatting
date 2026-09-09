# Contract: `GET /users`

Administrator user-directory listing. See [data-model.md](../data-model.md)
for field definitions and [research.md](../research.md) for pagination,
RBAC, and audit decisions.

## Auth and authorization

1. Valid `access_token` cookie (`JwtAuthGuard`). Missing / invalid / expired
   → **401**, no items. Evaluated before permissions or any user query
   (FR-003).
2. Caller MUST hold `users.list` (evaluated at request time via
   `AccessConfigService.hasPermission`). Otherwise **403**, no items
   (FR-002). Holding `users.read` (or any other `users.*` action) is not
   sufficient (FR-020).
3. The Admin role is granted `users.list` by default (FR-019).

## Query parameters

| Name | Type | Default | Rules |
|---|---|---|---|
| `limit` | integer | `20` | Inclusive range 1–100. Outside range → 400. |
| `cursor` | string | omitted | Opaque continuation token from a previous page. Optional on the first request. Malformed, tampered, or fingerprint-mismatched → 400. |
| `search` | string | omitted | Trimmed. Blank → treated as omitted. Matches email (`ILIKE` partial, case-insensitive) **or** account id (exact UUID). |
| `status` | string | omitted (all listable) | `active` or `pending_confirmation`. Other values → 400. |
| `sort` | string | `createdAt` | `createdAt`, `lastLoginAt`, or `email`. Other values → 400. |
| `direction` | string | `desc` | `asc` or `desc`. Other values → 400. |

All supplied filters are AND-combined. Pagination is always applied
(FR-004). Sort by `lastLoginAt`:

- `desc` (newest first): known timestamps first, unknowns last
  (`NULLS LAST`).
- `asc` (oldest first): unknowns first, then oldest known
  (`NULLS FIRST`).

## Response: `200 OK`

Returned when the caller holds `users.list`. Body is always a page object
(never a bare array). `items.length` is never greater than `limit`.
`nextCursor` is a non-empty string when more matching listable accounts
exist; `null` when this is the last page (including zero matches).

```json
{
  "items": [
    {
      "id": "3f1b2c4a-1111-4222-8333-444444444444",
      "email": "alice@example.com",
      "photo": "https://example.test/assets/alice.jpg",
      "createdAt": "2026-01-15T10:00:00.000Z",
      "status": "active",
      "lastLoginAt": "2026-09-01T08:30:00.000Z"
    },
    {
      "id": "9a8b7c6d-5555-4666-8777-888888888888",
      "email": "bob@example.com",
      "photo": null,
      "createdAt": "2026-02-01T12:00:00.000Z",
      "status": "pending_confirmation",
      "lastLoginAt": null
    }
  ],
  "nextCursor": "eyJ2IjoxLCJzb3J0IjoiY3JlYXRlZEF0Ii4uLn0.hmac"
}
```

Allow-listed item fields only. Secrets (`passwordHash`, tokens, 2FA
material, `failedLoginAttempts`, `lockedUntil`, internal flags) MUST NOT
appear. Email is unmasked.

Repeating the same listing options with the same `cursor` MUST return the
same ordered set of account ids while those accounts remain listable
(FR-006).

## Response: `400 Bad Request`

Invalid `limit`, `status`, `sort`, `direction`, or `cursor`. No items.

```json
{
  "statusCode": 400,
  "message": "Invalid cursor",
  "error": "Bad Request"
}
```

Validation failures on enum/range fields use the standard ValidationPipe
message array. Cursor failures use a generic message and MUST NOT echo the
token or its decoded payload.

## Response: `401 Unauthorized`

No/invalid/expired access token. No items.

```json
{
  "statusCode": 401,
  "message": "Authentication required",
  "error": "Unauthorized"
}
```

## Response: `403 Forbidden`

Authenticated caller without `users.list`. No items.

```json
{
  "statusCode": 403,
  "message": "Insufficient permissions",
  "error": "Forbidden"
}
```

## Response: `429 Too Many Requests`

Per-route throttle (`limit: 30`, `ttl: 60000`) or global throttler exceeded.
Shape matches `@nestjs/throttler`. No items.

## Decision order (server-side, per request)

1. Global + per-route throttler → 429 (audit `rate_limited`).
2. `JwtAuthGuard` → 401 (audit `unauthenticated`).
3. Validate query DTO → 400 (audit `invalid`).
4. `hasPermission(..., 'users', 'list')` → 403 (audit `denied`).
5. Decode/verify `cursor` if present → 400 (audit `invalid`).
6. Query listable users (`deletion_started_at IS NULL`) with search/status/
   sort/keyset/`limit+1`.
7. Shape allow-listed items; mint `nextCursor` or `null`.
8. Audit `success` with `resultCount` and option-kind flags (no search text,
   no emails). Best-effort; must not fail the 200.

Outcomes `invalid`, `unauthenticated`, and `rate_limited` are written by
`UserDirectoryAuditFilter` (`APP_FILTER`, path-gated to `GET /users`).
`success` and `denied` are written by the list handler. The handler MUST
NOT record `invalid` (rethrow cursor `BadRequestException` for the filter).

## Audit record (not in the HTTP body)

Every attempt writes `user_directory_audit_events` as specified in
[data-model.md](../data-model.md). Reviewers can query:

```sql
SELECT actor_id, outcome, result_count, search_used, status_filter_used,
       sort_field, created_at
FROM user_directory_audit_events
ORDER BY created_at DESC;
```
