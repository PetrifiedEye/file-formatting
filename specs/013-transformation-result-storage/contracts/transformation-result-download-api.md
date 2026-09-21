# Contract: Transformation Result Save & Download API

## Existing transformation operations

### `POST /api/convert`

### `POST /api/images/convert`

Both authenticated multipart operations retain their existing response body,
status, content type, and content-disposition behavior.

Optional multipart field:

| Name | Type | Required | Default | Accepted values |
|---|---|---:|---|---|
| `store` | string boolean | No | `"false"` | `"true"`, `"false"` |

An unrecognized value returns the existing 400 `invalid_store_flag` response
before conversion. Saving is attempted only after a successful conversion.
Saving failure never changes a successful conversion into an error.

Existing result headers:

- file conversion: `X-Conversion-Retention`
- image conversion: `X-Image-Conversion-Retention`
- value: `not-requested`, `stored`, or `failed`

`stored` means the backing file and database link are complete before the
request finishes; it can be downloaded immediately.

## `GET /api/transformations/history/:itemId/download`

Downloads the authenticated caller's own saved transformation result.

### Path parameter

| Name | Type | Description |
|---|---|---|
| `itemId` | UUID | Transformation-history record id |

### Responses

| Status | When |
|---|---|
| 200 | The owner-scoped record is saved, unexpired, and readable |
| 400 | `itemId` is not a UUID |
| 401 | Authentication/session validation fails before record lookup |
| 404 | Record absent, belongs to another user, was not saved, is expired, or its backing file is missing |
| 429 | Self-download rate limit exceeded (30/minute) |
| 500 | Storage/open/read fails unexpectedly |

All 404 cases use the same body and message:

```json
{
  "statusCode": 404,
  "message": "Transformation result not available"
}
```

### Successful headers/body

```text
Content-Type: <media type for target format>
Content-Disposition: attachment; filename="<converted result name>"
Content-Length: <exact stored byte count>
Content-Encoding: identity
Cache-Control: private, no-store
```

The body is the byte-identical saved conversion result, streamed from an
already-open file descriptor. Document names use `converted.<ext>`; image
names use `converted-image.<ext>`.

## `GET /admin/users/:userId/transformations/history/:itemId/download`

Downloads a saved result for a specified user. Requires
`transformation-history:download-any`.

### Path parameters

| Name | Type | Description |
|---|---|---|
| `userId` | UUID | Owner account id |
| `itemId` | UUID | Transformation-history record id |

### Responses

| Status | When |
|---|---|
| 200 | Permission present; user and owner-scoped saved result are available |
| 400 | Either path id is not a UUID |
| 401 | Authentication/session validation fails |
| 403 | Caller lacks `transformation-history:download-any`; checked before target lookup |
| 404 | Target user absent, or record absent/mismatched/not saved/expired/missing on disk |
| 429 | Admin-download rate limit exceeded (20/minute) |
| 500 | Storage/open/read fails unexpectedly |

Successful response headers and bytes are identical to the self operation.
Wrong `userId` for a real `itemId` returns the same 404 as a nonexistent item.

## Error and streaming semantics

- Authorization and database/storage preflight complete before headers.
- Missing storage paths are 404, while unexpected storage errors are 500.
- The server advertises exact `Content-Length`; clients must reject incomplete
  transfers.
- If an I/O failure occurs after headers/bytes have already left the server,
  the connection is aborted because HTTP cannot replace the sent status with
  500. Such a transfer is incomplete, never a successful corrupt download.
- Repeated and concurrent downloads open independent descriptors and return
  the same bytes while the record remains unexpired.
- Storage paths and direct static URLs never appear in any response.

## Audit

Every `store=true` attempt and every request to either download route produces
one best-effort `transformation_result_audit_events` row. Download success is
recorded only after the response stream finishes. Audit failure never changes
the primary API response and no event contains file content.

