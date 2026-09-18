# Contract: Transformation History API

Two routes on one controller, `TransformationHistoryController`
(`@Controller('api/transformations')`), both behind `JwtAuthGuard`. Full
detail on *why* each shape was chosen is in [research.md](../research.md);
this document is the contract itself.

---

## `GET /api/transformations/history`

Self-service: the caller's own transformation history. No permission beyond
being signed in (FR-001).

### Query parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer, 1–100 | no (default 20) | FR-006 |
| `cursor` | opaque string | no | From a previous page's `nextCursor` |
| `type` | `file` \| `image` | no | |
| `sourceFormat` | `csv`\|`json`\|`xml`\|`yaml`\|`png`\|`jpeg`\|`svg` | no | |
| `targetFormat` | same set as `sourceFormat` | no | |
| `status` | `success` \| `error` | no | |
| `createdAtFrom` | ISO 8601 datetime | no | Inclusive |
| `createdAtTo` | ISO 8601 datetime | no | Inclusive; MUST NOT be before `createdAtFrom` |

All filters are combinable (AND semantics — FR-010).

### Responses

| Status | When | Body |
|---|---|---|
| 200 | Always, for a valid authenticated request | `TransformationHistoryPageDto` |
| 400 | `limit` out of range; unrecognized `type`/`sourceFormat`/`targetFormat`/`status`; malformed `createdAtFrom`/`createdAtTo`; `createdAtTo` before `createdAtFrom`; `cursor` malformed, forged, or minted under different filters/caller | `{ message, statusCode: 400 }` |
| 401 | No/invalid/expired access cookie, revoked session, inactive/deleted user | `{ message, statusCode: 401 }` |
| 429 | Rate limit exceeded (30/min) | `{ message, statusCode: 429 }` |

### Response body — `TransformationHistoryPageDto`

```json
{
  "items": [
    {
      "id": "b6e6c8b0-....",
      "type": "file",
      "sourceFormat": "csv",
      "targetFormat": "json",
      "status": "success",
      "fileSize": 20480,
      "durationMs": 42,
      "createdAt": "2026-09-18T10:15:30.123Z"
    },
    {
      "id": "0b1f2e40-....",
      "type": "image",
      "sourceFormat": "png",
      "targetFormat": "jpeg",
      "status": "error",
      "fileSize": 1048576,
      "durationMs": 118,
      "errorCode": "timeout",
      "createdAt": "2026-09-18T09:58:02.900Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJmcCI6Ii4uLiJ9.c2lnbmF0dXJl"
}
```

`errorCode` is present if and only if `status === "error"`. `nextCursor` is
`null` on the last page, never an empty string, and always present
(FR-007). An account with no matching transformations, or filters matching
nothing, returns `{ "items": [], "nextCursor": null }` with 200 — never an
error (Edge Cases).

---

## `GET /api/transformations/history/:userId`

Admin oversight: another user's transformation history, by account id.
Same query parameters, same response shape, same pagination and filtering
semantics as the self route (FR-002, User Story 4 Scenario 6). Requires the
`transformation-history:read-any` permission.

### Path parameter

| Name | Type | Notes |
|---|---|---|
| `userId` | UUID | The account whose history is requested |

### Responses

| Status | When |
|---|---|
| 200 | Caller holds the permission, `userId` exists |
| 400 | Malformed `userId` (not a UUID); any of the self-route 400 causes |
| 401 | Same as the self route |
| 403 | Caller lacks `transformation-history:read-any` — returned **regardless of whether `userId` exists** (User Story 3 Scenario 1); no records disclosed |
| 404 | Caller holds the permission, but `userId` does not correspond to an existing user (including a permanently deleted account — Edge Cases) |
| 429 | Rate limit exceeded (20/min — stricter than the self route, FR-016) |

Precedence when more than one condition applies: 401 → 400 (malformed
`userId`/query) → 403 → 404 → 200. See
[research.md §9](../research.md) for why 400 (a framework pipe) precedes 403
(handler logic).

---

## Cross-cutting

- **Idempotency** (FR-009): identical `(caller or target, filters, cursor)`
  returns identical results as long as the underlying rows are unchanged —
  a property of keyset pagination over an immutable-once-written table, not
  a separate mechanism.
- **Audit** (FR-017, FR-018): every request to either route produces exactly
  one `transformation_history_audit_events` row, for every status code above
  — see [data-model.md](../data-model.md).
- **No caller-selectable sort**: results are always most-recent-first
  (`createdAt` descending). Not a query parameter.
