# Phase 0 Research: Transformation Result Storage & Download

All Technical Context unknowns are resolved. Decisions extend the existing
`store` implementation shared by file and image conversion and follow the
authorization, audit, settings, and interval patterns already present in the
repository.

## 1. Existing save contract

**Decision**: Keep the external multipart field name `store`, with the existing
accepted values `"true"` and `"false"` and default `false`.

**Rationale**: Both `POST /api/convert` and `POST /api/images/convert` already
validate this field before conversion, write successful results under
`CONVERSION_STORAGE_DIR`, and link them through `conversion_stored_files`.
Renaming it to `save` would break a shipped contract without adding behavior.

The existing output headers remain authoritative:

- `X-Conversion-Retention`
- `X-Image-Conversion-Retention`
- values: `not-requested`, `stored`, or `failed`

Save failures remain isolated from the conversion response. Persistence is
completed before the handler returns so that `stored` is truthful and SC-001
(immediate download after a completed conversion request) is deterministic.
Disk and database work may run concurrently where safe, but no detached
in-memory job is introduced.

**Alternatives considered**:

- Rename the field to `save`: rejected as an unnecessary breaking change.
- Fire-and-forget save after sending the response: rejected because a process
  restart could lose accepted work, the response header could not report the
  final outcome, and an immediate download could race the save.
- Add a queue: rejected because the repository has no durable job
  infrastructure and the feature does not require one.

## 2. Save-size limit

**Decision**: Reuse the applicable conversion pipeline's existing output limit
(`CONVERSION_MAX_OUTPUT_BYTES` or `IMAGE_MAX_OUTPUT_BYTES`) and enforce it
again at the retention boundary as defense in depth. Do not add a second save
limit.

**Rationale**: The specification explicitly says saved results reuse existing
output limits. Normal endpoint flow cannot produce an oversized successful
result because conversion already checks the buffer before retention runs. The
retention service still accepts an explicit maximum and refuses an oversized
buffer so direct/internal callers cannot bypass the invariant; this path is
unit-tested and audited as `size_exceeded`.

**Alternatives considered**: A new `SAVED_RESULT_MAX_BYTES` setting was
rejected because it would contradict the feature assumption and create two
independent limits for the same output.

## 3. Retention policy and immutable expiry

**Decision**: Add
`system_settings.transformation_history_retention_days` with default `90` and
an admin settings API. Validate the value as an integer from 1 through 3650
days. Add non-null `conversion_records.expires_at`, computed when each history
row is inserted.

**Rationale**:

- Retention is administrator-controlled policy, so it belongs in the existing
  DB-backed `SettingsModule`, not an environment variable.
- `expires_at` snapshots the active policy. Later settings changes affect new
  records only, as required.
- Every history row gets an expiry, whether or not its result was saved. A
  stored file inherits the deadline through its one-to-one conversion record,
  guaranteeing equal history/file lifetimes without duplicate timestamps.
- Existing rows are backfilled as `created_at + 90 days`.

The settings endpoints use the existing `AdminGuard`
(`settings:manage`) and settings audit table.

**Alternatives considered**:

- Store expiry only on `conversion_stored_files`: rejected because unsaved
  history must also expire.
- Store expiry on both tables: rejected because two copies can diverge.
- Environment-only retention: rejected because an administrator could not
  change it through the existing management API.
- Recalculate existing deadlines after a settings change: rejected by the
  specification's immutable-expiry rule.

## 4. Module ownership

**Decision**: Add `TransformationResultStorageModule` under
`src/modules/transformation-result-storage/`.

It owns:

- self and admin download controllers;
- download eligibility and streaming orchestration;
- save/download audit entity and service;
- expiry cleanup service;
- retention-policy adapter over `SettingsService`.

`ConversionModule` imports this module for policy and result-audit services;
the image pipeline continues to consume the shared conversion history and
retention services through `ConversionModule`. The new module registers
`ConversionRecord` and `ConversionStoredFile` directly with TypeORM and does
not import `ConversionModule`, avoiding a circular dependency.

**Rationale**: Download, lifecycle, and audit span both conversion families and
belong to neither one individually. A dedicated module satisfies the
constitution's module/controller/service boundary while preserving the
existing one-way `image-conversion -> conversion` dependency.

**Alternatives considered**: Putting all behavior in
`TransformationHistoryModule` was rejected because save auditing and cleanup
are lifecycle/mutation concerns, while that module is deliberately a
read/reporting feature with a distinct audit contract.

## 5. Download routes and authorization

**Decision**: Implement the specification's exact routes:

- `GET /api/transformations/history/:itemId/download`
- `GET /admin/users/:userId/transformations/history/:itemId/download`

Both use `JwtAuthGuard`. Self download derives the owner exclusively from
`request.user.id`. Admin download checks
`transformation-history:download-any` before looking up the target user or
history row. The migration adds this distinct action to the existing
`transformation-history` permission and grants it to `admin` by default.

The database query always includes both record id and expected owner id.
There is no fetch-by-id followed by an externally distinguishable ownership
error. Missing records, wrong ownership, no saved file, expiry, and missing
backing file all return the same 404 contract.

**Rationale**: This directly satisfies the specified API and prevents IDOR.
Keeping `download-any` separate from `read-any` avoids granting file content
access to roles that may only inspect metadata.

**Alternatives considered**:

- Reuse `read-any`: rejected because metadata oversight and file disclosure
  are materially different privileges.
- Place admin download under `/api/transformations/history/...`: rejected
  because the feature explicitly specifies an `/admin/users/...` operation.
- Return 403 for a self cross-owner request: rejected because it confirms the
  history id exists.

## 6. Download query and filename/media metadata

**Decision**: Query a `ConversionRecord` by `(id, user_id)` with its
one-to-one `ConversionStoredFile`, selecting only the fields needed for the
decision and response. Evaluate in this order:

1. ownership-scoped record exists;
2. record is unexpired;
3. outcome is successful and retention is `stored`;
4. linked stored-file metadata exists;
5. the storage service can securely open and stat the backing file.

The download filename is derived from the same deterministic names as the
original conversion response (`converted.<ext>` for documents and
`converted-image.<ext>` for images). Media type and extension come from the
existing format maps; user input is never copied into response headers.

**Rationale**: The current conversion response already defines the result's
name, so another filename column is redundant. Owner scoping in SQL is the
primary IDOR defense.

## 7. Safe streaming on Fastify

**Decision**: Extend `ConversionFileStorageService` with a path-contained
`openForRead()` operation that:

- rejects any stored path escaping `CONVERSION_STORAGE_DIR`;
- opens a file handle before response headers are sent;
- obtains size from the open handle;
- returns a read stream backed by that same handle.

Controllers set `Content-Type`, `Content-Disposition`, `Content-Length`,
`Content-Encoding: identity`, and `Cache-Control: private, no-store`, then send
the stream through Fastify. Opening first removes the pathname race: on POSIX,
cleanup may unlink the path while an already-open descriptor continues to
serve the same bytes.

Missing files map to the uniform 404 `unavailable` result. Unexpected open/read
errors map to 500 when headers have not been sent. If a device error occurs
after bytes have been sent, HTTP cannot replace the already-sent 200 status;
the stream/socket is destroyed and the advertised `Content-Length` makes the
transfer incomplete rather than a valid corrupt file. Audit finalization
records `read_failed`.

**Alternatives considered**:

- Read the complete file into a `Buffer`: rejected by FR-015 and SC-009.
- Create a stream from the path without pre-opening/stat: rejected because a
  missing file would be discovered after headers and could yield a partial
  response.
- Return a direct filesystem/static URL: rejected because it bypasses auth and
  exposes guessable paths.

## 8. Cleanup scheduling and consistency

**Decision**: Add an in-process interval service using the established
`OnModuleInit`/`OnModuleDestroy`, `setInterval(...).unref()` pattern from
`AccessConfigService`. Add Joi-validated
`TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS` (default one hour, `0`
disables). This controls operations scheduling, not the admin retention
policy.

Each cycle reads expired records in bounded batches ordered by
`expires_at`, selecting only ids and storage paths, and continues until no
expired rows remain. Each item is isolated:

1. remove the stored file if present (`ENOENT` counts as already removed);
2. delete the `conversion_records` row;
3. rely on `ON DELETE CASCADE` to delete `conversion_stored_files`.

An unexpected file-removal failure leaves the expired DB row in place for the
next cycle; expiry checks already make it unreachable. A database failure
after unlink is logged and retried, at which point the missing file is treated
as already removed. One item never aborts the cycle.

**Rationale**: Deleting the complete history row enforces the same lifetime for
history and saved data. The repository has no scheduler dependency, while the
interval lifecycle pattern is already production code. Local filesystem and
PostgreSQL cannot participate in one atomic transaction, so ordered,
idempotent operations plus retry are the achievable consistency model; no
inconsistent item is downloadable after expiry.

**Alternatives considered**:

- Delete only the stored-file row/clear the link: rejected because history
  itself must expire.
- `@nestjs/schedule`: rejected as an unnecessary runtime dependency for one
  interval.
- Lazy cleanup on reads: rejected because records never read again would
  remain forever.
- One large transaction: rejected because filesystem deletion cannot join the
  PostgreSQL transaction and one failure would violate per-item isolation.

## 9. Audit model and completion timing

**Decision**: Add a dedicated `transformation_result_audit_events` table.
Every request that reaches a recognized `store=true` intent (including one
whose transformation later fails) and every download request creates one
event. `ConversionRetentionService` exposes one shared finalization operation
used by both conversion families, so save outcome/audit logic is not
duplicated.

Fields are actor id, optional target user id, optional conversion-record id,
optional stored-file id, action, outcome, optional file size, duration, and
timestamp. Save outcomes include `conversion_failed` when no successful result
exists to retain. There are no filename, path, payload, or free-form content
columns. Audit writes are best-effort and never change the primary response.

Download audit is finalized exactly once:

- handler/filter records pre-stream refusal outcomes;
- response `finish` records success;
- stream error or premature response close records `read_failed`.

The route-scoped audit filter handles 401, UUID-validation 400, and 429 paths
that do not reach a controller handler.

**Rationale**: The existing transformation-history audit cannot represent
save/download ids, bytes, duration, or streaming completion. A separate
schema guarantees that content cannot be logged accidentally and preserves
events after account/history deletion by omitting foreign keys.

**Alternatives considered**: Extending
`transformation_history_audit_events` was rejected because list access and
binary result access have different required fields and lifecycles.

## 10. Database migration and indexes

**Decision**: One reversible feature migration will:

- add `system_settings.transformation_history_retention_days`;
- add/backfill/constrain `conversion_records.expires_at`;
- create `idx_conversion_records_expires_at`;
- append `download-any` to the permission's declared actions;
- append `download-any` only to the default `admin` grant;
- create audit action/outcome enums, the audit table, and actor/target/record
  timestamp indexes.

The down migration removes only feature-013 additions and preserves feature
012's permission and `read-any` grants.

**Rationale**: Expiry sweeps need an index on their predicate/order column.
Audit indexes support investigations by actor, target, and transformation
record. All schema changes remain versioned; synchronize stays disabled.

## 11. Testing strategy

**Decision**: Add colocated Jest tests for policy, storage open/path
containment, download eligibility, authorization ordering, audit
finalization, cleanup batching/failure isolation, retention size re-check, and
both controller contracts. Extend file/image conversion tests for expiry and
save audit. Add e2e coverage for both download routes, settings updates,
IDOR/uniform 404 behavior, permission revocation, expiry-before-cleanup,
cleanup, repeat/concurrent downloads, storage drift, and audit rows.

Run `npm run verify` and `npm run test:e2e` during implementation because the
feature changes HTTP, RBAC, settings, filesystem, and database contracts.

