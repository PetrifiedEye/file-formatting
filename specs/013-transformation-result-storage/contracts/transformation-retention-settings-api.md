# Contract: Transformation Retention Settings API

Both routes are under the existing `AdminGuard` and require
`settings:manage`.

## `GET /admin/settings/transformation-retention`

Returns the system-wide lifetime applied when new transformation-history
records are created.

### Response `200`

```json
{
  "retentionDays": 90
}
```

| Field | Type | Range |
|---|---|---|
| `retentionDays` | integer | 1–3650 |

Errors follow the existing admin settings authentication/authorization
contract (`401` unauthenticated, `403` insufficient permission).

## `PATCH /admin/settings/transformation-retention`

Updates the system-wide lifetime for newly created transformation-history
records and their optional saved files.

### Request

```json
{
  "retentionDays": 180
}
```

`retentionDays` is required, must be an integer, and must be from 1 through
3650. Unknown body fields are removed/rejected according to the global
validation-pipe configuration.

### Responses

| Status | When |
|---|---|
| 200 | Setting persisted (including idempotent same-value updates) |
| 400 | Missing, non-integer, or out-of-range `retentionDays` |
| 401 | Authentication/session validation fails |
| 403 | Caller lacks `settings:manage` |

The 200 body is the same shape as the GET response.

## Effective-date rule

The setting is read when a new `conversion_records` row is written:

```text
expires_at = record creation time + retentionDays
```

Changing the setting does not update existing `expires_at` values and does
not immediately delete existing records. The recurring cleanup service removes
each record when its own frozen deadline is reached.

## Audit

Each PATCH attempt that reaches `SettingsService` uses the existing
`settings_audit_events` mechanism with event type
`transformation_retention_updated`, outcome, actor/request metadata, and:

```json
{
  "retentionDays": {
    "from": 90,
    "to": 180
  }
}
```

