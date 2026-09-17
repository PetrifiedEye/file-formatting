# Phase 1 Data Model: Image Conversion

Entities from [spec.md](./spec.md), mapped onto the schema feature
`010-file-format-conversion` already owns. Decisions are in
[research.md](./research.md).

**The headline**: this feature adds **no table and no column**. Image
attempts are rows in `conversion_records`; retained images are rows in
`conversion_stored_files`. The only schema change is widening one enum type
([research.md §9](./research.md)).

---

## Enums

### `ImageFormat` — new (TypeScript)

```ts
export enum ImageFormat {
  PNG = 'png',
  JPEG = 'jpeg',
  SVG = 'svg',
}
```

The only place the image format set is enumerated. The set of supported
*directions* is never written down — it is derived from which handlers
implement `decode` and which implement `encode`
([research.md §2](./research.md)).

### `ConversionFormat` — unchanged

`csv | json | xml | yaml`. Deliberately untouched, so the text handlers and
their exhaustive `Record<ConversionFormat, …>` maps keep compiling.

### `RecordedFormat` — new (TypeScript)

```ts
export type RecordedFormat = ConversionFormat | ImageFormat;
export const RecordedFormat = { ...ConversionFormat, ...ImageFormat };
```

What the two persisted format columns accept. Both features write it; neither
owns it.

### `conversion_format` — widened (PostgreSQL)

| Before | After |
|---|---|
| `('csv','json','xml','yaml')` | `('csv','json','xml','yaml','png','jpeg','svg')` |

Widened by the transactional type-swap in
[research.md §9](./research.md), not `ALTER TYPE … ADD VALUE`.

### `conversion_outcome`, `conversion_error_category`, `conversion_retention_outcome`

Unchanged, and shared verbatim. `conversion_error_category` in particular
**must** be shared: it is one column, so both features speak one vocabulary
([research.md §10](./research.md)).

---

## Entity: Image Conversion Attempt → `conversion_records`

Spec entity "Image Conversion Attempt" maps to the existing table with **no
structural change**. Every field the spec names already has a column:

| Spec field (FR-025) | Column | Notes |
|---|---|---|
| Requesting user | `user_id` | FK to `users`, `ON DELETE CASCADE` |
| Original file name | `original_file_name` | `varchar(255)`, truncated. A name, never content |
| Detected source format | `source_format` | `conversion_format`, nullable — detection may fail first |
| Requested target format | `target_format` | `conversion_format`, nullable — the request may name an unsupported one |
| Upload size | `input_size_bytes` | `bigint`. For a 413 this is where the budget was hit, not the true file size |
| Outcome | `outcome` | `success` \| `failure` |
| Failure reason | `failure_reason` | A fixed code plus an optional position. **Never a library message** |
| Error category | `error_category` | One of the seven shared categories |
| Start time | `started_at` | `timestamptz(3)` |
| Duration | `duration_ms` | `integer`, wall-clock, including time spent failing |
| Retention requested | `retention_requested` | `boolean` |
| Retention outcome | `retention_outcome` | `not_requested` \| `stored` \| `failed` (FR-031) |
| Reference to Retained Image | `stored_file_id` | Nullable FK (FR-029) |
| — | `output_size_bytes` | Written on success; a byte count, required by the schema's CHECK |

**No discriminator column.** An attempt is an image attempt exactly when its
format is an image format. A `kind` column would be derived data that can
disagree with the data it is derived from.

### Validation rules (already enforced in the schema)

Inherited unchanged, and all of them hold for image rows:

| Constraint | Meaning |
|---|---|
| `CHK_conversion_records_success_complete` | A success has both formats, an output size, and no error category |
| `CHK_conversion_records_failure_categorized` | A failure has a category and no output size |
| `CHK_conversion_records_stored_has_file` | A linked file implies `retention_outcome = 'stored'` |
| `CHK_conversion_records_retention_requested` | A retention outcome other than `not_requested` implies it was asked for |
| `CHK_conversion_records_stored_only_on_success` | Nothing is retained for an attempt that failed (FR-029) |

**The FR-026 / SC-012 guarantee is structural**: the table has no column
capable of holding image content. It is not a rule the image path has to
remember — there is nowhere to put pixels.

### Indexes

Unchanged and already correct for image rows:

- `idx_conversion_records_user_started (user_id, started_at DESC)` — "this
  user's history", and the SC-011 verification query.
- `idx_conversion_records_outcome_started (outcome, started_at DESC)` —
  failure rates.

No image-specific index is added. A "my image conversions" query filters on
`source_format IN ('png','jpeg','svg')`, which is a low-selectivity predicate
on top of an already-indexed user scan; adding an index for a read path this
feature does not expose (spec: history read-back is out of scope) would be
speculative.

---

## Entity: Retained Image → `conversion_stored_files`

Spec entity "Retained Image" maps to the existing table with **no structural
change**:

| Spec field | Column | Notes |
|---|---|---|
| Owning user | `user_id` | FK, `ON DELETE CASCADE`. The only principal permitted to read it (FR-030) |
| Conversion attempt it came from | `conversion_record_id` | Unique FK — a file never exists without its conversion |
| Format | `format` | `conversion_format`, now able to hold `png` / `jpeg` |
| Size | `size_bytes` | `integer` |
| When stored | `created_at` | `timestamptz(3)` |
| Where it resides | `storage_path` | `<userId>/<id>.<ext>`, relative to `CONVERSION_STORAGE_DIR` |

`format` can only ever be `png` or `jpeg` for an image row: SVG has no
encoder, so no SVG result can exist to retain.

`CONVERSION_STORAGE_DIR` is reused deliberately — it sits **outside**
`ASSETS_DIR`, which `@fastify/static` serves unauthenticated, which is what
makes FR-030 true. Retained images are not served over HTTP by this feature
at all.

---

## Runtime model (not persisted)

### `RasterImage` — the canonical hub

```ts
interface RasterImage {
  data: Buffer;      // raw, row-major, 8 bits per channel
  width: number;     // post-orientation
  height: number;    // post-orientation
  channels: 3 | 4;
  hasAlpha: boolean;
}
```

Every conversion is `decode(source) → RasterImage → encode(target)`, so N
decoders and M encoders give N×M−|both| directions with no pairwise code
([research.md §2](./research.md)).

**Validation rules**:

- `data.length === width * height * channels` — asserted at construction;
- `width ≥ 1`, `height ≥ 1`;
- `hasAlpha` implies `channels === 4`;
- `width * height ≤ limits.maxPixels` — the budget is checked from the header
  before this object can exist (FR-019).

**It has no metadata field.** EXIF, GPS, camera data, and colour profiles
cannot cross the hub, which is how FR-026's "no embedded metadata in the
result" is enforced by shape.

### `ImageFormatHandler` — the capability contract

```ts
interface ImageFormatHandler {
  readonly format: ImageFormat;
  readonly mediaType: string;          // image/png, image/jpeg, image/svg+xml
  readonly extension: string;          // png, jpg, svg
  readonly detectionPriority: number;
  readonly sniffIsConclusive: boolean;

  sniff(prefix: Buffer, namedByFileName: boolean): boolean;

  decode?(input: Buffer, context: ImageConversionContext): Promise<RasterImage>;
  encode?(image: RasterImage, context: ImageConversionContext): Promise<Buffer>;
}
```

| Handler | `decode` | `encode` | Consequence |
|---|---|---|---|
| `PngHandler` | ✓ | ✓ | Source and target |
| `JpegHandler` | ✓ | ✓ | Source and target |
| `SvgHandler` | ✓ | **absent** | Source only — vectorisation is unrepresentable (FR-003) |

### `ImageConversionLimits` — the resolved limit set

```ts
interface ImageConversionLimits {
  maxInputBytes: Record<ImageFormat, number>;  // per source format (FR-017)
  maxOutputWidth: number;                       // FR-018
  maxOutputHeight: number;                      // FR-018
  maxPixels: number;                            // FR-019
  maxOutputBytes: number;
  backgroundColor: string;                      // #rrggbb (FR-009, FR-010)
  jpegQuality: number;
  timeoutMs: number;                            // FR-022
  maxConcurrent: number;                        // FR-023
  svgFontDir: string | null;
}
```

Resolved **once** from `ConfigService` in the module factory and injected.
Handlers never read configuration themselves — that keeps each unit-testable
against arbitrary limits and stops one inventing a ceiling of its own.

### `ImageConversionContext`

```ts
interface ImageConversionContext {
  limits: ImageConversionLimits;
  signal?: AbortSignal;   // expires with the conversion deadline
}
```

---

## Image Format Limit Configuration (spec entity → environment)

The spec's "Image Format Limit Configuration" is not a table: it is validated
environment configuration, so an administrator retunes it without a code
change or a migration (spec Assumptions).

| Spec field | Setting | Default |
|---|---|---|
| Max upload size per source format | `IMAGE_MAX_BYTES_PNG` / `_JPEG` / `_SVG` | 10 MiB / 10 MiB / 2 MiB |
| Max output width / height | `IMAGE_MAX_OUTPUT_WIDTH` / `_HEIGHT` | 8192 / 8192 |
| Max decoded pixel count | `IMAGE_MAX_PIXELS` | 16000000 |
| Rasterisation background | `IMAGE_BACKGROUND_COLOR` | `#ffffff` |
| Conversion time budget | `IMAGE_CONVERSION_TIMEOUT_MS` | 30000 |
| Concurrency bound | `IMAGE_MAX_CONCURRENT` | 2 |
| *(output ceiling)* | `IMAGE_MAX_OUTPUT_BYTES` | 20971520 |
| *(fixed output quality)* | `IMAGE_JPEG_QUALITY` | 85 |
| *(optional fonts)* | `IMAGE_SVG_FONT_DIR` | *(empty)* |

Reused unchanged: `CONVERSION_STORAGE_DIR`.

---

## Existing entities

`User` is referenced by both tables and is **not modified**. Image conversion
introduces no new permission: any authenticated user may convert (spec
Assumptions), so no RBAC entity is touched either.
