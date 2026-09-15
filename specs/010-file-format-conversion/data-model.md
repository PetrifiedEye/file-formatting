# Phase 1 Data Model: File Format Conversion

Two new tables, one new enum-bearing module, no changes to existing tables.
Decisions behind these shapes are in [research.md](./research.md).

## Enums (TypeScript + PostgreSQL)

```ts
enum ConversionFormat { CSV = 'csv', JSON = 'json', XML = 'xml', YAML = 'yaml' }

enum ConversionOutcome { SUCCESS = 'success', FAILURE = 'failure' }

enum ConversionErrorCategory {
  BAD_REQUEST              = 'bad_request',               // 400: missing/empty file, bad targetFormat, same format
  UNSUPPORTED_MEDIA_TYPE   = 'unsupported_media_type',    // 415: source undetectable / target unknown
  PAYLOAD_TOO_LARGE        = 'payload_too_large',         // 413
  PARSE_ERROR              = 'parse_error',               // 400: malformed input, bad UTF-8, DOCTYPE
  STRUCTURE_LIMIT_EXCEEDED = 'structure_limit_exceeded',  // 400: depth / node count / CSV columns
  TIMEOUT                  = 'timeout',                   // 400: exceeded the time budget
  INTERNAL_ERROR           = 'internal_error',            // 500
}

enum ConversionRetentionOutcome {
  NOT_REQUESTED = 'not_requested',
  STORED        = 'stored',
  FAILED        = 'failed',
}
```

`ConversionFormat` is the **only** place the format set is enumerated for
persistence. The runtime set of *directions* is never stored — it is derived
from the handler registry at request time (FR-030).

## Entity: Conversion Record

`src/modules/conversion/entities/conversion-record.entity.ts` → table
`conversion_records`. One row per authenticated conversion attempt,
successful or not (FR-021).

| Field | Column | Type | Notes |
|---|---|---|---|
| `id` | `id` | `uuid` PK | generated |
| `userId` | `user_id` | `uuid` NOT NULL | FK → `users.id`, `ON DELETE CASCADE`. This is the user's own history, not a security audit trail, so it goes with the account (unlike `*_audit_events`, which deliberately omit the FK). |
| `originalFileName` | `original_file_name` | `varchar(255)` NOT NULL | As supplied in the multipart part; truncated to 255. A **name**, never content. |
| `sourceFormat` | `source_format` | enum `conversion_format` | Nullable: detection may fail before a format is known. |
| `targetFormat` | `target_format` | enum `conversion_format` | Nullable: the request may name an unknown target. |
| `inputSizeBytes` | `input_size_bytes` | `bigint` NOT NULL | Bytes actually received. For a 413 this is the point at which the budget was exceeded, not the true file size — the rest is never read (SC-006). |
| `outputSizeBytes` | `output_size_bytes` | `integer` NULL | Set only on success. |
| `outcome` | `outcome` | enum `conversion_outcome` NOT NULL | |
| `errorCategory` | `error_category` | enum `conversion_error_category` NULL | Set iff `outcome = failure`. |
| `failureReason` | `failure_reason` | `varchar(255)` NULL | A fixed code plus optional line/column. **Never a library message** — those quote input (FR-023). |
| `retentionRequested` | `retention_requested` | `boolean` NOT NULL DEFAULT false | What the caller asked for. |
| `retentionOutcome` | `retention_outcome` | enum `conversion_retention_outcome` NOT NULL DEFAULT `'not_requested'` | What actually happened (FR-028). |
| `storedFileId` | `stored_file_id` | `uuid` NULL | FK → `conversion_stored_files.id`, `ON DELETE SET NULL`. Non-null only when `retention_outcome = 'stored'`; see the validation rules for why this is an implication and not an equivalence. |
| `startedAt` | `started_at` | `timestamptz(3)` NOT NULL | When processing began. |
| `durationMs` | `duration_ms` | `integer` NOT NULL | Wall-clock, including a failed attempt's time. |
| `createdAt` | `created_at` | `timestamptz(3)` NOT NULL | Row insert time. |

**No column can hold file content** (FR-023 / SC-005) — this is enforced by
the shape of the table, not by discipline at the call site.

### Validation rules

- `outcome = 'success'` ⇒ `source_format`, `target_format`, and
  `output_size_bytes` are all non-null, and `error_category` is null.
- `outcome = 'failure'` ⇒ `error_category` is non-null and
  `output_size_bytes` is null.
- `stored_file_id IS NOT NULL` ⇒ `retention_outcome = 'stored'`.
  *(Implemented as this implication rather than the biconditional originally
  planned: `stored_file_id` is `ON DELETE SET NULL`, so deleting a retained
  file — an expiry sweep, say — would clear the link and immediately violate a
  biconditional, making that FK action one that could only ever fail. The
  implication keeps the invariant that matters, and reads correctly afterwards:
  the result *was* retained, and the file is now gone.)*
- `retention_outcome <> 'not_requested'` ⇒ `retention_requested = true`.
- `retention_outcome = 'stored'` ⇒ `outcome = 'success'` (FR-026: nothing is
  stored for a failed conversion).

The first three are `CHECK` constraints in the migration; the last two are
too, since they are cheap and encode FR-026 / FR-028 in the schema.

### Indexes

| Index | Columns | Why |
|---|---|---|
| `idx_conversion_records_user_started` | `(user_id, started_at DESC)` | The access path for "this user's history" — the read feature that follows, and the SC-004 verification query. |
| `idx_conversion_records_outcome_started` | `(outcome, started_at DESC)` | Operational queries: failure rates and recent failures. |

`stored_file_id` gets an index implicitly from its unique FK relation.

## Entity: Stored Conversion File

`src/modules/conversion/entities/conversion-stored-file.entity.ts` → table
`conversion_stored_files`. One row per retained result (FR-025 – FR-027).

| Field | Column | Type | Notes |
|---|---|---|---|
| `id` | `id` | `uuid` PK | Also the on-disk file's base name. |
| `userId` | `user_id` | `uuid` NOT NULL | FK → `users.id`, `ON DELETE CASCADE`. The owner; the only principal permitted to read it (FR-027). |
| `conversionRecordId` | `conversion_record_id` | `uuid` NOT NULL UNIQUE | FK → `conversion_records.id`, `ON DELETE CASCADE`. One stored file per conversion. |
| `format` | `format` | enum `conversion_format` NOT NULL | The target format it was written in. |
| `sizeBytes` | `size_bytes` | `integer` NOT NULL | |
| `storagePath` | `storage_path` | `varchar(512)` NOT NULL | Path **relative to `CONVERSION_STORAGE_DIR`**: `<userId>/<id>.<ext>`. |
| `createdAt` | `created_at` | `timestamptz(3)` NOT NULL | |

**`storage_path` is relative to `CONVERSION_STORAGE_DIR`, which is not
`ASSETS_DIR`.** `ASSETS_DIR` is served unauthenticated at `/assets/` by
`@fastify/static`; retained files must not be reachable that way
(FR-027, [research.md §8](./research.md)). Nothing in this feature serves
these files over HTTP at all.

`conversion_records.stored_file_id` and
`conversion_stored_files.conversion_record_id` are deliberately both
present: the record is written on every attempt and must be able to point at
nothing, while the file must never exist without the conversion that
produced it.

### Index

| Index | Columns | Why |
|---|---|---|
| `idx_conversion_stored_files_user_created` | `(user_id, created_at DESC)` | "My retained files", and the sweep an expiry feature would need. |

## Existing entities

**`User`** (`users`) — unchanged. Gains two inverse relations
(`conversionRecords`, `storedConversionFiles`), both lazy and unused by this
feature's queries.

**`SystemSettings`** — unchanged. Conversion limits live in environment
configuration, not in this table ([research.md §4](./research.md)).

## Runtime model (not persisted)

### `DocumentNode` — the canonical document

```ts
type DocumentNode =
  | null | boolean | number | string
  | DocumentNode[]
  | { [key: string]: DocumentNode };
```

The RFC 8259 data model, used as the hub every format reads into and writes
from. The mapping between each wire format and this model is specified in
[contracts/conversion-mapping-rules.md](./contracts/conversion-mapping-rules.md).

### `ConversionLimits` — the resolved limit set

```ts
interface ConversionLimits {
  maxInputBytes: Record<ConversionFormat, number>;
  maxOutputBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxCsvColumns: number;
  timeoutMs: number;
}
```

Resolved once from `ConfigService` and injected; handlers receive it rather
than reading configuration themselves, so a handler is unit-testable with
arbitrary limits and cannot invent its own.

### Format Limit Configuration (spec entity → env)

The spec's **Format Limit Configuration** entity is realized as the
Joi-validated environment variables in
[research.md §4](./research.md), not as a table. It has no identity, no
history, and no per-row lifecycle — it is startup configuration.
