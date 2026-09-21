# Phase 1 Data Model: Transformation Result Storage & Download

This feature extends the shared conversion history and stored-file model
created by features 010–012. It adds one policy field, one history expiry
column, and one audit table; no file bytes are stored in PostgreSQL.

## Entity: Transformation History Record

Maps to existing `conversion_records`.

### New field

| Column | Type | Nullable | Rules |
|---|---|---|---|
| `expires_at` | `timestamptz(3)` | No | Set once at insertion to current time plus the then-active `transformation_history_retention_days`; never recalculated |

Existing rows are backfilled as `created_at + 90 days`. New index:
`idx_conversion_records_expires_at (expires_at ASC)` for cleanup scans.

### Relevant existing fields

| Column | Role in this feature |
|---|---|
| `id` | Download `itemId`; audit correlation |
| `user_id` | Ownership predicate; never accepted from the self route |
| `transformation_type` | Chooses output filename/media family |
| `target_format` | Determines media type and extension |
| `outcome` | Only successful transformations can be downloaded |
| `output_size_bytes` | Expected result size |
| `retention_requested` | Whether a save attempt existed |
| `retention_outcome` | `not_requested`, `stored`, or `failed` |
| `stored_file_id` | Optional one-to-one saved-file link |
| `created_at` | Start of the frozen retention lifetime |

### Validation/invariants

- `expires_at > created_at` for every newly written record.
- A downloadable record has `outcome = success`,
  `retention_outcome = stored`, a non-null `stored_file_id`, and
  `expires_at > now()`.
- Every history record expires, including failed and non-saved attempts.
- Expiry is immutable after insertion.
- Deleting a record cascades to its `conversion_stored_files` row.

### State transitions

```text
recorded, not requested ──expires──> deleted
recorded, save failed   ──expires──> deleted
recorded, save pending  ──attach───> stored and downloadable
stored                  ──expires──> unavailable ──cleanup──> deleted
```

`save pending` is an internal, same-request interval represented
pessimistically by `retention_outcome = failed` and no `stored_file_id`.
It is never advertised as downloadable.

## Entity: Saved Transformation File

Maps to existing `conversion_stored_files`; no new column is required.

| Existing column | Type | Rules |
|---|---|---|
| `id` | UUID | Unique file reference and on-disk basename |
| `user_id` | UUID | Must equal the linked record owner |
| `conversion_record_id` | UUID, unique | Exactly one history record |
| `format` | `conversion_format` | Result format |
| `size_bytes` | integer | Exact saved byte count |
| `storage_path` | varchar(512) | Relative path under `CONVERSION_STORAGE_DIR` |
| `created_at` | timestamptz | Save time |

The file's expiry is `conversion_record.expires_at`; it is intentionally not
duplicated. `storage_path` is never exposed by an API or written to the result
audit.

### Filesystem rules

- Path shape remains `<userId>/<storedFileId>.<extension>`.
- The configured root must remain outside `ASSETS_DIR`.
- Read and delete operations resolve and verify containment under the root.
- Missing files are idempotent for cleanup but unavailable for download.
- File bytes are read through a pre-opened descriptor and streamed.

## Entity: Retention Period Configuration

Maps to the singleton `system_settings` row (`id = 1`).

| New column | Type | Nullable | Default | Validation |
|---|---|---|---|---|
| `transformation_history_retention_days` | smallint | No | `90` | Integer, 1–3650 |

Changes apply only when new `conversion_records.expires_at` values are
computed. Existing deadlines remain unchanged. Updates are audited through
the existing `settings_audit_events` table using a new
`transformation_retention_updated` event type.

## Entity: Download Oversight Permission

Uses existing RBAC tables; there is no new entity.

| Permission | Action | Default grant |
|---|---|---|
| `transformation-history` | `download-any` | `admin` |

The action is independent from existing `read-any`. Admin-route authorization
is evaluated before target user or record lookup.

## Entity: Transformation Result Audit Entry

New table: `transformation_result_audit_events`.

| Column | Type | Nullable | Rules |
|---|---|---|---|
| `id` | UUID PK | No | Generated |
| `actor_user_id` | UUID | Yes | Null only when authentication never identified an actor |
| `target_user_id` | UUID | Yes | Admin download target; null for save/self |
| `conversion_record_id` | UUID | Yes | No FK so audit survives cleanup |
| `stored_file_id` | UUID | Yes | Present when known; no FK |
| `action` | enum | No | `save` or `download` |
| `outcome` | enum | No | See below |
| `file_size_bytes` | integer | Yes | Save input size; download size on success |
| `duration_ms` | integer | No | Non-negative elapsed wall-clock time |
| `created_at` | timestamptz | No | Default `now()` |

### Audit outcomes

| Outcome | Save | Download |
|---|---:|---:|
| `success` | Stored and attached | Stream completed |
| `conversion_failed` | Save requested, but no successful result existed | — |
| `size_exceeded` | Retention limit refused | — |
| `storage_failed` | Disk write failed | Open/storage backend failed before streaming |
| `attach_failed` | DB linkage failed and file discarded | — |
| `history_unavailable` | No record id was available; file discarded | — |
| `denied` | — | Admin permission missing |
| `not_found` | — | Owner-scoped record absent or not saved |
| `expired` | — | Deadline passed |
| `unavailable` | — | Metadata exists but backing file is missing |
| `read_failed` | — | Stream failed or closed prematurely |
| `unauthenticated` | — | Guard rejected request |
| `invalid` | — | UUID/path validation failed |
| `rate_limited` | — | Throttler rejected request |

No audit column accepts file bytes, filename, storage path, parser/library
message, or other raw file content.

Indexes:

- `(actor_user_id, created_at DESC)`
- `(target_user_id, created_at DESC)`
- `(conversion_record_id, created_at DESC)`

## Runtime model: Download Descriptor

Not persisted. Produced only after authorization and availability checks.

```ts
interface TransformationResultDownload {
  conversionRecordId: string;
  storedFileId: string;
  storagePath: string; // service-internal only
  fileName: string;
  mediaType: string;
  expectedSizeBytes: number;
  expiresAt: Date;
}
```

The controller receives an opened stream plus trusted response metadata; it
never receives raw file bytes.

## Cleanup model

Cleanup selects only:

```text
conversion_records.id
conversion_records.expires_at
conversion_stored_files.storage_path (nullable)
```

Rows are ordered by `expires_at`, processed in bounded batches, and isolated
per item. Filesystem removal precedes record deletion; deleting the record
cascades stored-file metadata. Errors are logged without paths escaping the
private storage context and do not stop later items.

