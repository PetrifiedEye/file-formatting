# Quickstart: Validate Transformation Result Storage & Download

This guide validates the feature after implementation. API details are in
[the download contract](./contracts/transformation-result-download-api.md)
and [retention settings contract](./contracts/transformation-retention-settings-api.md).

## Prerequisites

1. Install dependencies: `npm install`
2. Create `.env` and `.env.test` from their examples.
3. Ensure dev and test database names differ.
4. Start PostgreSQL: `docker compose up -d postgres`
5. Apply migrations: `npm run migration:run`
6. Seed admin fixtures if needed: `npm run seed:e2e`
7. Confirm `CONVERSION_STORAGE_DIR` is outside `ASSETS_DIR`.

## Automated validation

Run the mandatory gate and HTTP/database integration suite:

```bash
npm run verify
npm run test:e2e
```

Expected: TypeScript, ESLint, unit tests, and all e2e suites pass with zero
errors.

## Scenario 1: Save a document result

1. Sign in as a normal user and retain the access cookie.
2. Send a valid multipart `POST /api/convert` with a file, target format, and
   `store=true`.
3. Save the response body locally.

Expected:

- conversion status/body/content headers match the same request with
  `store=false`;
- `X-Conversion-Retention: stored`;
- one history row has a frozen future `expires_at`;
- one linked `conversion_stored_files` row exists;
- the private file exists beneath `CONVERSION_STORAGE_DIR`;
- one successful save audit exists and contains size/duration but no bytes.

Repeat with `POST /api/images/convert` and verify
`X-Image-Conversion-Retention: stored`.

## Scenario 2: Default, invalid, failed, and oversized save paths

- Omit `store`, then send `store=false`: no stored-file row; header is
  `not-requested`.
- Send an unrecognized store value: 400 `invalid_store_flag`; conversion does
  not run.
- Force conversion failure with `store=true`: no saved file.
- Unit-call the retention boundary with a buffer above the applicable pipeline
  output maximum: it refuses storage and audits `size_exceeded`.
- Make the storage directory unwritable and convert with `store=true`: the
  conversion remains successful, the retention header is `failed`, no link is
  left, and audit outcome is `storage_failed`.

## Scenario 3: Self download and IDOR protection

1. Save a transformation for user A and capture its history item id.
2. As user A, call
   `GET /api/transformations/history/{itemId}/download`.
3. Compare downloaded bytes with the original conversion response.
4. Repeat and issue concurrent requests.
5. As user B, request user A's item id.

Expected:

- user A receives 200, exact bytes, correct media type, result filename,
  content length, and private/no-store caching;
- repeated/concurrent downloads are byte-identical;
- user B receives the same 404 used for an unknown/unsaved id, with zero file
  bytes;
- unauthenticated access receives 401 before record/file lookup;
- every attempt has exactly one audit event.

## Scenario 4: Admin download and permission ordering

1. As seeded admin, call
   `GET /admin/users/{userAId}/transformations/history/{itemId}/download`.
2. Repeat as a user without `transformation-history:download-any`.
3. Revoke the admin grant, reload RBAC state, and retry.
4. Try a nonexistent user and a real item under the wrong user id.

Expected:

- authorized admin receives the same bytes/headers as self download;
- missing permission returns 403 before user/item existence is evaluated;
- nonexistent user and owner/item mismatch return uniform 404;
- revocation takes effect according to the existing RBAC snapshot contract.

## Scenario 5: Retention setting snapshot

1. Read `GET /admin/settings/transformation-retention`.
2. PATCH it to a short test value.
3. Create a history record and note `expires_at`.
4. PATCH the setting to a different value.

Expected:

- valid updates return the persisted value and create settings audit events;
- values below 1, above 3650, or non-integers return 400;
- the existing record's deadline does not change;
- a later record uses the new value.

## Scenario 6: Expiry gate and cleanup

1. Create saved and unsaved history rows with deadlines in the past.
2. Before cleanup runs, request the saved result.
3. Trigger/wait one configured cleanup cycle.

Expected:

- download is already uniform 404 before physical cleanup;
- expired `conversion_records` rows are deleted;
- linked `conversion_stored_files` rows cascade-delete;
- backing files are gone;
- an injected deletion error for one item leaves it for retry but does not
  prevent later expired items from being processed.

## Scenario 7: Storage drift and read failure

- Remove a backing file while leaving metadata, then download: uniform 404 and
  `unavailable` audit.
- Inject an unexpected open error before headers: 500 with no file bytes.
- Inject a stream read error: connection is incomplete/aborted and audit is
  `read_failed`; it must not be recorded as a successful download.

## Privacy checks

For a saved file:

- `/assets/...` and guessed direct API/static paths do not expose it;
- API responses never include `storage_path` or stored-file ids;
- application/audit logs contain ids, outcomes, byte counts, and durations,
  but no file payload;
- traversal-like stored paths are rejected by the storage service.

