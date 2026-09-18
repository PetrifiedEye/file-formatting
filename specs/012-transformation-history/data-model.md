# Phase 1 Data Model: Transformation History

Entities from [spec.md](./spec.md), mapped onto `conversion_records`
(owned by feature 010, widened by feature 011) plus one new column and one
new audit table this feature adds. Decisions are in [research.md](./research.md).

---

## Schema change 1: `conversion_records.transformation_type` (NEW COLUMN)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `transformation_type` | `transformation_type` (new enum: `'file'`, `'image'`) | NOT NULL | Set by the writer (`ConversionService` → `'file'`, `ImageConversionService` → `'image'`), never derived from `source_format`/`target_format` ([research.md §2](./research.md)) |

Backfill for pre-existing rows (dev-only, no production data):
`CASE WHEN source_format IN ('png','jpeg','svg') OR target_format IN
('png','jpeg','svg') THEN 'image' ELSE 'file' END` — then `SET NOT NULL`.

New index: `idx_conversion_records_user_created` on
`(user_id, created_at DESC)` — the access path every query in this feature
uses ([research.md §8](./research.md)).

This is the only structural change to an existing table. Everything else
this feature needs already has a column.

---

## Enums

### `TransformationType` — new (TypeScript, in `conversion.enums.ts`)

```ts
export enum TransformationType {
  FILE = 'file',
  IMAGE = 'image',
}
```

Owned by `conversion.enums.ts` (not the new module) because it is persisted
on `conversion_records`, alongside `ConversionOutcome` and `RecordedFormat`.

### `transformation_type` — new (PostgreSQL)

`ENUM('file', 'image')`.

### `TransformationHistoryStatus` — new (TypeScript, API-facing only)

```ts
export enum TransformationHistoryStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}
```

Not persisted. Translated to/from the existing `ConversionOutcome`
(`success`/`failure`) at the query boundary ([research.md §3](./research.md)).
Lives in the new module (`transformation-history.enums.ts`) since it is a
contract concept, not a column type.

### Existing enums, unchanged and reused

- `RecordedFormat` (`ConversionFormat | ImageFormat` — csv/json/xml/yaml/png/jpeg/svg) — the `sourceFormat`/`targetFormat` filter and response values.
- `ConversionOutcome`, `ConversionErrorCategory` — read, translated, never written by this feature.

---

## Entity: Transformation History Record → `conversion_records` (read-only)

Spec entity "Transformation History Record" maps onto the existing table
plus the one new column:

| Spec field (FR-013) | Source | Notes |
|---|---|---|
| Record id | `id` | |
| Transformation type | `transformation_type` (new) | `'file'` \| `'image'` |
| Source format | `source_format` | Nullable — null when detection never completed (a failure before any byte was recognized). Exposed as-is, `null`, not omitted |
| Target format | `target_format` | Nullable, same reason |
| Status | `outcome`, translated | `success` \| `error` (was `success`/`failure`) |
| Source file size | `input_size_bytes` | `bigint` → `number` in the response. Safe at this feature's scale: values are bounded by the conversion features' own configured per-format byte ceilings (megabytes), far under `Number.MAX_SAFE_INTEGER` |
| Duration | `duration_ms` | Passed through unchanged |
| Error code | `error_category`, translated | Present only when `status = 'error'` (mirrors the existing `CHK_conversion_records_failure_categorized` invariant: a failure always has a category, a success never does — so "only when error" falls out of the schema, not a runtime branch) |
| Creation time | `created_at` | The row's write time, i.e. when the (synchronous) transformation finished — **not** `started_at`. This is also the sort and range-filter column (FR-007, FR-010) |

**Fields deliberately never exposed** (FR-014): `original_file_name`,
`failure_reason`, `retention_requested`, `retention_outcome`,
`stored_file_id`, `started_at`, `user_id` of any row other than the one the
history belongs to. The query service selects an explicit column list
(constitution III: no `SELECT *`) that excludes all of these.

**No new validation rules** — `conversion_records`' existing CHECK
constraints (success ⇒ formats + output size + no category; failure ⇒
category + no output size) already guarantee the record shape this feature's
read contract depends on.

---

## Entity: Transformation History Page (response shape, not persisted)

```ts
class TransformationHistoryItemDto {
  id: string;
  type: TransformationType;
  sourceFormat: RecordedFormat | null;
  targetFormat: RecordedFormat | null;
  status: TransformationHistoryStatus;
  fileSize: number;
  durationMs: number;
  errorCode?: ConversionErrorCategory;
  createdAt: string; // ISO 8601
}

class TransformationHistoryPageDto {
  items: TransformationHistoryItemDto[];
  nextCursor: string | null;
}
```

Shape matches `UserDirectoryPageDto` exactly (`items` + `nextCursor`,
`nextCursor` always present, `null` on the last page) — FR-007.

---

## Entity: Transformation History Oversight Permission → RBAC tables (existing)

No new entity. Realized as one row in `permissions`
(`name = 'transformation-history'`, `actions = ['read-any']`) and one row in
`grants` (role `admin` → that permission, `actions = ['read-any']`), seeded
by migration ([research.md §5](./research.md)). Checked at request time via
`AccessConfigService.hasPermission(roles, 'transformation-history',
'read-any')` — never cached past the snapshot's own refresh cycle, so FR-015
("evaluate... at the time of each request") is inherited for free from the
existing `AccessConfigService` design.

---

## Entity: Transformation History Access Audit Entry → `transformation_history_audit_events` (NEW TABLE)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | | |
| `actor_user_id` | uuid | NOT NULL, no FK | The authenticated caller. No FK to `users`, matching `user_directory_audit_events`/`profile_audit_events` — an audit row must outlive the account it describes |
| `target_user_id` | uuid | nullable | Populated only for the admin-path route; `null` on the self path (spec: "targetUserId (для админ-доступа)") |
| `outcome` | enum: `success`, `denied`, `not_found`, `unauthenticated`, `invalid`, `rate_limited` | NOT NULL | Every reachable outcome of either route |
| `result_count` | integer | nullable | Populated only on `success` |
| `type_filter_used` | boolean | NOT NULL, default false | |
| `source_format_filter_used` | boolean | NOT NULL, default false | |
| `target_format_filter_used` | boolean | NOT NULL, default false | |
| `status_filter_used` | boolean | NOT NULL, default false | |
| `date_range_filter_used` | boolean | NOT NULL, default false | |
| `created_at` | timestamptz | default now() | |

Indexes: `idx_transformation_history_audit_actor_created (actor_user_id,
created_at DESC)`, `idx_transformation_history_audit_target_created
(target_user_id, created_at DESC)` — "who accessed this, and who did user X's
history get read by" are both plausible reviewer queries (SC-009).

No column can hold file/image content or another user's identifying detail
beyond an account id — satisfying FR-018 by the same "the schema has nowhere
to put it" mechanism `conversion_records` itself uses for FR-023 in feature
010.

---

## Runtime model (not persisted)

### `TransformationHistoryQueryDto`

```ts
class TransformationHistoryQueryDto {
  limit?: number;             // 1–100, default 20
  cursor?: string;
  type?: TransformationType;
  sourceFormat?: RecordedFormat;
  targetFormat?: RecordedFormat;
  status?: TransformationHistoryStatus;
  createdAtFrom?: string;     // ISO 8601
  createdAtTo?: string;       // ISO 8601
}
```

Validated with `class-validator` (`@IsInt/@Min/@Max`, `@IsEnum`,
`@IsISO8601`), matching `ListUsersQueryDto`'s style exactly. Cross-field
checks (date range order, cursor ownership/fingerprint) are service-level,
not DTO-level, matching `UserDirectoryService`'s own split.

### `CursorPayload` (internal to the service, mirrors `UserDirectoryService`)

```ts
interface CursorPayload {
  v: number;
  fp: string;   // sha256 of {subjectUserId, ...effective filters, limit}
  id: string;
  createdAt: string;
}
```

`subjectUserId` is the caller's own id on the self route, or the target
`userId` on the admin route — binding a cursor to whose history it paginates,
not just the filters ([research.md §4](./research.md)).

---

## Existing entities, unchanged

`User` — referenced for the admin route's existence check
(`UsersService.findById`), not modified. `Role`/`Permission`/`Grant` — one
new row each, no schema change.
