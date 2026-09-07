# Contract: `GET /users/:userId`

## Auth

- Requires a valid `access_token` cookie (`JwtAuthGuard`). Missing/invalid/expired → `401`, no body other than the standard Nest error shape.

## Path Parameters

| Name | Type | Notes |
|---|---|---|
| `userId` | `string` (UUID) | Syntactically invalid values are treated as not-found (see 404/403 rules below), never a distinct 400. |

## Response: `200 OK` — self view

Returned when `userId === <authenticated caller's id>` and that user exists (it does, since the caller is authenticated as them).

```json
{
  "id": "3f1b2c4a-...-uuid",
  "email": "user@example.com",
  "photo": "https://cdn.example.com/photos/3f1b2c4a.jpg",
  "status": "active",
  "createdAt": "2026-01-15T10:00:00.000Z"
}
```

`photo` is `null` if unset. Returned regardless of the caller's roles/permissions (FR-001).

## Response: `200 OK` — privileged view

Returned when `userId !== <caller's id>`, the caller holds `users:read`, and the target user exists.

```json
{
  "id": "9a8b7c6d-...-uuid",
  "photo": "https://cdn.example.com/photos/9a8b7c6d.jpg"
}
```

Only `id` and `photo` — no other field is ever present, even if present internally (FR-011, SC-003).

## Response: `403 Forbidden`

Returned when `userId !== <caller's id>` and the caller does NOT hold `users:read` — regardless of whether the target user exists (FR-003, Story 3 Scenario 2). No profile fields in the body.

```json
{
  "statusCode": 403,
  "message": "Insufficient permissions",
  "error": "Forbidden"
}
```

## Response: `404 Not Found`

Returned when the caller is authorized to know existence (self, or `users:read` holder) but the target `userId` does not correspond to an existing user, OR `userId` is syntactically malformed and the caller would otherwise be authorized to view it.

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```

## Response: `401 Unauthorized`

No/invalid/expired access token. Evaluated before any of the above (FR-004, SC-004).

```json
{
  "statusCode": 401,
  "message": "Authentication required",
  "error": "Unauthorized"
}
```

## Response: `429 Too Many Requests`

Standard global-throttler response when the caller exceeds the configured rate limit (FR-007). Shape matches `@nestjs/throttler`'s default.

## Decision Order (server-side, per request)

1. `JwtAuthGuard` → 401 if not authenticated.
2. Compare `userId` to caller id.
   - If equal (self) → look up user by id; if found, return self view (200); if somehow not found (deleted mid-session), 404.
   - If not equal → check `users:read` via `AccessConfigService.hasPermission`.
     - Not held → 403 (existence of target is never disclosed).
     - Held → look up target; not found (or malformed id) → 404; found → privileged view (200).
3. Audit record written for every terminal outcome (200-self, 200-privileged, 403, 404), best-effort, never blocking the response.
