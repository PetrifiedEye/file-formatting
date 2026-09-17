# Phase 0 Research: Image Conversion

Decisions behind [plan.md](./plan.md). Each section states what was chosen,
why, and what was rejected. Requirement ids refer to [spec.md](./spec.md).

---

## 1. Module placement and route paths

**Decision**: a new `src/modules/image-conversion/` Nest module exposing
`POST /api/images/convert` and `GET /api/images/convert/formats`, both behind
the existing `JwtAuthGuard`. It **imports** `ConversionModule` to reuse that
feature's history, retention, upload reader, and error vocabulary.

**Rationale**: the spec is explicit that image conversion is a separate
capability on its own route (directions are an allow-list, not every pair)
but shares feature 010's durable history and storage "rather than
introducing a parallel mechanism" (FR-024, FR-029, Assumptions). A separate
module with an explicit import edge gives both: image code never enters the
text pipeline, and there is exactly one `conversion_records` table.

The dependency is one-directional — `image-conversion` → `conversion` — so
Constitution I's no-circular-imports rule holds.

**Alternatives rejected**:

- *Add image handlers to `ConversionModule`.* The text hub is
  `read → DocumentNode → write` over UTF-8 text. Images are bytes, have no
  document model, and support 4 of 6 directions rather than all of them.
  Forcing both through one registry would mean `DocumentNode | RasterImage`
  and a direction predicate in the middle of a module whose entire design
  point is that no such predicate exists.
- *A parallel `image_conversion_records` table.* Contradicts FR-024 and
  doubles every downstream history reader.
- *Extract a shared `conversion-core` module first.* Cleaner on paper, but it
  rewrites the imports of ~25 shipped files in feature 010 for no behavioural
  gain. Revisit if a third conversion family appears.

**Route shape**: `api/images/convert` as the controller path, matching 010's
reason — the application registers no global prefix, so the `api/` segment is
part of each controller path.

---

## 2. The extensibility mechanism: capabilities, not a direction table

**Decision**: one `ImageFormatHandler` per format, declaring its capabilities
by which methods it implements:

```ts
interface ImageFormatHandler {
  readonly format: ImageFormat;
  readonly mediaType: string;
  readonly extension: string;
  readonly detectionPriority: number;
  readonly sniffIsConclusive: boolean;

  sniff(prefix: Buffer, namedByFileName: boolean): boolean;

  /** Absent ⇒ this format can never be a source. */
  decode?(input: Buffer, context: ImageConversionContext): Promise<RasterImage>;
  /** Absent ⇒ this format can never be a target. */
  encode?(image: RasterImage, context: ImageConversionContext): Promise<Buffer>;
}
```

The registry computes directions as
`{formats with decode} × {formats with encode}, minus source === target`.

With PNG (decode + encode), JPEG (decode + encode), and SVG (**decode only**)
that yields exactly:

| | → png | → jpeg | → svg |
|---|---|---|---|
| **png** | — | ✓ | *no encoder* |
| **jpeg** | ✓ | — | *no encoder* |
| **svg** | ✓ | ✓ | — |

which is FR-002's four directions and nothing else.

**Rationale**: this is what makes FR-003 (never vectorise) and FR-034
(directions as data, not branching logic) true rather than aspirational.
There is no rule anywhere saying "refuse raster → SVG". The SVG handler has
no `encode`, so the direction is **unrepresentable** — discovery cannot
advertise it and the pipeline cannot reach it, because both read the same
capability set. Discovery and enforcement cannot diverge because they are the
same computation (FR-013, SC-009, SC-010).

Adding WebP is one file with both methods and one provider entry: four new
directions appear in discovery and in the pipeline with no edit to any
existing handler, to the request DTO, or to the response shape (FR-033,
SC-014). The worked example lives in the module README.

**Canonical intermediate** — `RasterImage`:

```ts
interface RasterImage {
  data: Buffer;          // raw, row-major, 8 bits per channel
  width: number;
  height: number;
  channels: 3 | 4;
  hasAlpha: boolean;     // channels === 4 and alpha is meaningful
}
```

Raw pixels rather than a `sharp` pipeline object, for three reasons: handlers
stay unit-testable without the library, the SVG decoder (a different library
entirely) produces raw RGBA natively, and **all metadata is structurally
dropped at the hub** — there is no field capable of carrying EXIF, GPS, or a
colour profile, which is how FR-026's "no embedded metadata in the result"
is enforced by shape rather than by discipline.

The cost is stated plainly in §8: a raw buffer is `width × height × channels`
bytes, so the pixel budget and the concurrency bound together are what cap
resident memory.

---

## 3. Image libraries

**Decision**: `sharp` (^0.35) for PNG and JPEG; `@resvg/resvg-js` (^2.6) for
SVG rasterisation. Both ship prebuilt native binaries for linux x64/arm64
(glibc and musl) and darwin; `sharp` requires Node ≥ 20.9.

### PNG / JPEG — `sharp`

Every raster requirement maps onto something sharp does natively:

| Requirement | Mechanism |
|---|---|
| FR-019 pixel budget before allocation | `sharp(buf).metadata()` parses the header only — no pixel buffer — and returns declared `width`/`height`; `limitInputPixels` then backstops the decode |
| FR-009 alpha composite | `.flatten({ background })` before JPEG encode |
| Edge case: greyscale, indexed, 16-bit PNG | libvips decodes all of them; `.raw()` normalises to 8-bit RGB/RGBA |
| Edge case: EXIF orientation | `.rotate()` with no argument auto-orients from EXIF |
| Edge case: metadata not carried | sharp writes no metadata unless `.withMetadata()` is called; and the hub cannot carry any regardless |
| Edge case: animated / multi-frame | `animated: false` is the default — the first frame is read |
| SC-013 concurrency | sharp's operations are **asynchronous on the libuv threadpool**, so decode and encode do not occupy the event loop |

That last row is a genuine improvement over feature 010, whose honest caveat
was that `JSON.parse` is synchronous and uninterruptible. Image work is not
on the event loop, so the time budget in §8 can actually be enforced and
unrelated requests are not blocked by a large decode.

**Alternatives rejected**: `jimp` and `pngjs` + `jpeg-js` are pure JS —
entirely synchronous, an order of magnitude slower, and `jpeg-js` has a
history of unbounded-allocation issues, which is exactly the class of bug
FR-019 exists to prevent. `@napi-rs/image` is younger and its PNG colour-type
coverage is thinner.

### SVG — `@resvg/resvg-js`, not sharp

**Rationale**: sharp *can* rasterise SVG, via libvips → **librsvg**, and that
is the wrong tool here for two reasons. First, librsvg resolves external
references (images, stylesheets) through its own I/O, so "no network request
is made" (FR-021, SC-006) would depend on a library's configuration rather
than on the absence of a code path. Second, SVG support in the prebuilt
libvips binaries is not contractual — it varies by platform build, so the
feature would silently work in development and 415 in production.

resvg is a pure-Rust renderer with **no scripting engine at all** and no HTTP
client compiled in; `@resvg/resvg-js` exposes no option to load remote
resources. Fonts are explicit: `loadSystemFonts: false` keeps rendering
deterministic and stops the renderer scanning the filesystem, with an
optional `IMAGE_SVG_FONT_DIR` for deployments that need text.

**Stated limitation**: with no font directory configured, `<text>` in an SVG
renders as nothing. This is documented in the module README and in the
contract rather than hidden — silently substituting an arbitrary system font
would make output non-reproducible across hosts.

**Implementation note to verify**: prefer `renderAsync` so rasterisation runs
off the event loop like the sharp path. If the installed version exposes only
the synchronous `Resvg#render`, the output-dimension cap (§6) is what bounds
how long it can block, and that must be called out in the module README
rather than assumed away.

---

## 4. Source-format detection (FR-004)

**Decision**: content first, magic bytes, on the same bounded 64 KiB prefix
feature 010 already reads. The file-name extension is a secondary hint only.

| Format | Signature | Priority | Conclusive |
|---|---|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | 10 | yes |
| JPEG | `FF D8 FF` | 20 | yes |
| SVG | BOM/whitespace, then `<`, with an `<svg` token in the prefix | 30 | yes |

**"Conclusive" matters**, and it is the same rule 010 applies to XML: a file
carrying PNG magic that is truncated or corrupt must be refused as an
**invalid image** (400), not fall through the scan and come back as
"unsupported media type" (415). Each signature is unambiguous, so all three
are conclusive — which also means the extension hint never changes the
outcome for a well-formed file, only for genuinely undecidable input.
Anything matching no signature is 415 before a single byte beyond the prefix
is read (FR-004, US5.6).

**Extension hints**: `.png` → png; `.jpg`/`.jpeg` → jpeg; `.svg` → svg. A
`.png` file containing JPEG bytes is detected as JPEG — content decides
(FR-004, Edge case "extension disagrees with content").

`FormatDetectorService` from feature 010 is **not** reused: it decodes UTF-8
and works on text, which is meaningless for binary input. The image detector
works on `Buffer` and shares only the `DETECTION_PREFIX_BYTES` constant.

---

## 5. SVG safety (FR-020, FR-021, SC-006)

**Decision**: a reject-only validator that runs before any renderer sees the
document, in this order:

1. **Byte cap** while the upload streams (§7) — SVG's own, much smaller limit.
2. **UTF-8 validation and BOM strip** (reusing 010's round-trip check).
3. **Raw-text scan**, case-insensitive, over the decoded document:
   `<!DOCTYPE`, `<!ENTITY`, `<script`, `javascript:`, `@import`, and any
   `on<name>=` attribute pattern → refused immediately.
4. **Structured walk** of the document parsed with `fast-xml-parser`
   (already a dependency; `processEntities: false`, `ignoreAttributes:
   false`), refusing:
   - elements `script`, `foreignObject`, `iframe`, `embed`, `object`,
     `handler`, `audio`, `video`;
   - any attribute whose name begins with `on`;
   - any URL-bearing attribute (`href`, `xlink:href`, `src`, `style`,
     `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-*`) whose value
     resolves to anything other than a same-document fragment (`#id`) or an
     inline `data:` URI — so `http:`, `https:`, `file:`, `//host`, and
     relative paths are all refused;
   - `<style>` element text containing `@import` or `url(` with a target
     failing the same test.
5. **Intrinsic size** resolved and checked (§6) — still before rendering.
6. Render.

**Why both a text scan and a structured walk**: they fail differently. The
structured walk understands namespaces, CDATA, and attribute nesting that a
regex cannot; the text scan catches anything the parser and the renderer
might disagree about — a parser differential is the classic way sanitizers
are bypassed. Neither alone is sufficient; together, a construct has to be
invisible to `fast-xml-parser` *and* invisible to a literal substring scan
*and* meaningful to resvg.

**The validator never rewrites.** It refuses or it passes the **original
bytes** to the renderer. A sanitizer that re-serializes creates exactly the
parse differential it is meant to close: what was checked would no longer be
what is rendered.

**DOCTYPE refusal is what closes billion-laughs** (Edge case, FR-021). No
entity expansion is performed at any point, so there is no expansion budget
to tune and no bomb to survive — the document is refused at step 3.

**No network by construction**: the module has no HTTP client, no
`fetch` call, and no filesystem read of anything the document names. The
guarantee is the absence of a code path; the validator and resvg's own
inability to fetch are defence in depth on top of it. SC-006's egress
observation verifies all three at once.

**Reused error code**: `<!DOCTYPE` in an SVG maps to feature 010's existing
`xml_doctype_forbidden` — the same rule, the same refusal, one code.

---

## 6. SVG intrinsic size — the deterministic rule (FR-010, FR-018)

**Decision**, applied to the root `<svg>` element and documented in the
contract:

1. Resolve `width` and `height` **independently**. A unitless value is
   CSS pixels; `px`, `pt`, `pc`, `mm`, `cm`, `in` convert at **96 dpi**
   (`1in = 96px`, `1pt = 96/72`, `1pc = 16px`, `1mm = 96/25.4`,
   `1cm = 96/2.54`). `em`, `ex`, `%`, and anything unparseable do not resolve.
2. A dimension that does not resolve is taken from `viewBox` — its third
   value for width, its fourth for height, in user units (= px).
3. If a dimension resolves from neither, the drawing is refused:
   `svg_no_intrinsic_size` (400, US2.4, Edge case "sized only by viewBox").
4. Fractional results are rounded **up** to whole pixels, minimum 1.
   Ceiling rather than rounding, so a `10.2px` drawing is never clipped
   (Edge case "fractional, percentage, or unit-bearing sizes").
5. A dimension resolving to zero or a negative value is refused as
   `svg_no_intrinsic_size`.
6. The whole-pixel result is checked against `IMAGE_MAX_OUTPUT_WIDTH`,
   `IMAGE_MAX_OUTPUT_HEIGHT`, and `IMAGE_MAX_PIXELS`. Over any of them →
   `image_dimensions_exceeded` (**400**, as FR-018 requires), naming the
   limit that was exceeded, **before the renderer is constructed** (US2.3).

Steps 4 and 6 are ordered deliberately: rounding happens first so the check
is against the size that will actually be produced.

`fitTo: { mode: 'original' }` is passed to resvg so the rendered raster is
exactly these dimensions and no scaling is applied (SC-001, US2.1).

---

## 7. Upload handling and per-format byte limits (FR-017, SC-008)

**Decision**: reuse feature 010's `UploadReader` unchanged.

It is already format-agnostic: it buffers a bounded prefix, lets the caller
detect the format, then consumes the remainder under that format's budget and
**destroys the stream the moment the budget is exceeded**. That is precisely
FR-017's "refused as too large before decoding, without the whole upload
being read" (SC-008), and it already translates
`@fastify/multipart`'s own `FST_REQ_FILE_TOO_LARGE` into the shared
`input_too_large` refusal.

The multipart call sets its limits **per request**
(`request.parts({ limits: { fileSize, files: 1 } })`) with the largest
configured image limit, exactly as 010 does — so the global registration in
`main.ts`, which serves the photo route under `PHOTO_MAX_SIZE_BYTES`, is
untouched.

**Per-format defaults** reflect what a byte costs in each format:

| Format | Default | Why |
|---|---|---|
| PNG | 10 MiB | Compressed pixels; bounded further by the pixel budget |
| JPEG | 10 MiB | As PNG |
| SVG | 2 MiB | Text that expands into pixels — a few KiB can demand gigabytes, so the real guard is §6, and this cap is about parse cost |

FR-017's "the limit applied is the one for the *detected* source format"
carries over from 010 verbatim, including its consequence: the same byte
count can be accepted as PNG and refused as SVG (US3.4).

**Inherited consequence, restated**: a request that is both oversized *and*
missing `targetFormat` is answered 413, not 400. The field may legitimately
arrive after the file part, and the file must be refused while the stream is
open, so no ordering makes both refusals take precedence.

---

## 8. Pixel budget, memory, timeout, concurrency (FR-019, FR-022, FR-023)

### Pixel budget (FR-019, SC-007)

`sharp(buffer).metadata()` parses the container header only and reports the
**declared** dimensions without allocating a pixel buffer. The product is
checked against `IMAGE_MAX_PIXELS` and refused as
`image_pixel_budget_exceeded` (400) before `.raw()` is ever reached.
`limitInputPixels: IMAGE_MAX_PIXELS` is set on the decode as a second line of
defence against a container whose header and payload disagree.

For SVG the equivalent check is §6, on the resolved intrinsic size.

SC-007 — a sub-100 KiB file declaring enormous dimensions, refused with no
measurable memory rise — is satisfied by the header-only read.

### Memory arithmetic, stated rather than hoped

The canonical raster is `width × height × channels` bytes. Peak resident
pixel memory is therefore bounded by

```
IMAGE_MAX_PIXELS × 4 bytes × IMAGE_MAX_CONCURRENT
```

Defaults of 16 MP and 2 give ≈ 128 MiB of raster, plus input and output
buffers bounded by the byte caps. `IMAGE_MAX_CONCURRENT` defaults **lower
than feature 010's 4** because an image's expanded form is far larger
relative to its upload than a parsed document's is.

### Timeout (FR-022, SC-005)

A deadline of `IMAGE_CONVERSION_TIMEOUT_MS` (default **30 000**, per the
spec) is taken once the upload is complete, checked at every `await`
boundary, and reported as the shared `timeout` code (400).

Unlike feature 010, this budget is genuinely enforceable: sharp's work is
asynchronous, so the deadline is checked between decode and encode and the
event loop is never held. The one caveat is a synchronous resvg render (§3),
where the output-dimension cap is the operative bound.

### Concurrency (FR-023, SC-013)

The same semaphore shape as 010 — waiters are subject to the same deadline,
so queueing does not buy a request extra time — but a **separate** counter
from the text pipeline. Sharing one would let a burst of text conversions
starve image conversions of slots, and the two have unrelated memory
profiles.

---

## 9. Sharing feature 010's history: the enum question (FR-024, FR-025)

**Decision**: widen the existing PostgreSQL `conversion_format` enum to
`('csv','json','xml','yaml','png','jpeg','svg')` and record image attempts in
the existing `conversion_records` / `conversion_stored_files` tables. **No
new column, and no discriminator.**

**Rationale**: FR-024 requires image attempts in "the same conversion history
used by other transformation features". The format value itself already says
which family an attempt belongs to, so a `kind` column would be derived data
— a second source of truth that can disagree with the first.

**How the type is widened**: not `ALTER TYPE ... ADD VALUE`, which cannot be
used in the same transaction that would exercise the new values and behaves
differently across PostgreSQL versions. Instead the standard transactional
swap:

```sql
CREATE TYPE "conversion_format_new" AS ENUM (…7 values…);
ALTER TABLE "conversion_records"
  ALTER COLUMN "source_format" TYPE "conversion_format_new"
  USING "source_format"::text::"conversion_format_new";
-- …target_format, conversion_stored_files.format…
DROP TYPE "conversion_format";
ALTER TYPE "conversion_format_new" RENAME TO "conversion_format";
```

Three columns across two tables, fully inside the migration's transaction.

**`down` refuses rather than destroys.** Narrowing the type would require
deleting every image attempt. The down migration counts rows carrying an
image format and throws a message naming the count if any exist; with none,
it reverses cleanly. A migration that silently deletes a user's history to
make itself reversible is the worse outcome.

**TypeScript side**: `ConversionFormat` (csv/json/xml/yaml) is left exactly
as it is — the text handlers, their exhaustive `Record<ConversionFormat, …>`
maps, and every 010 test keep compiling untouched. A new `ImageFormat` enum
and a `RecordedFormat = ConversionFormat | ImageFormat` union are added
alongside, and only the two entities and the two shared services widen to the
union. That widening is additive: no existing call site changes meaning.

**Alternatives rejected**: a `varchar` format column (throws away the
database's own validation); a second pair of image tables (contradicts
FR-024); merging image formats into `ConversionFormat` itself (breaks the
totality of the text module's format-keyed maps and would let a text
direction be computed for `png`).

---

## 10. Error vocabulary and status codes

**Decision**: reuse `ConversionException`, `ConversionErrorCategory`, and the
single code → status → category table from feature 010, adding image codes to
it. `ConversionErrorParams` gains `width`, `height`, `maxWidth`, `maxHeight`,
and `pixels` — **all numbers**, preserving the invariant that no caller can
put file content into a message, a log line, or `failure_reason` (FR-026,
SC-012).

Sharing the category enum is not a convenience: `conversion_records.
error_category` is one column, so both features must speak one vocabulary.

### New codes

| Code | Status | Category | Cause |
|---|---|---|---|
| `image_invalid` | 400 | parse_error | Bytes are not a valid image of the detected format, or are truncated (US1.5) |
| `image_pixel_budget_exceeded` | 400 | structure_limit_exceeded | Declared pixel count over `IMAGE_MAX_PIXELS` (US3.5) |
| `image_dimensions_exceeded` | 400 | structure_limit_exceeded | Rendered size over the configured maximum width/height (US2.3, FR-018) |
| `svg_no_intrinsic_size` | 400 | bad_request | Size resolvable from neither width/height nor viewBox (US2.4) |
| `svg_active_content` | 400 | bad_request | Script, event handler, or other executable construct (US3.1) |
| `svg_external_reference` | 400 | bad_request | External entity or external resource reference (US3.2) |
| `svg_render_failed` | 400 | parse_error | The renderer could not process the drawing (US2.5) |
| `image_vectorisation_unsupported` | 415 | unsupported_media_type | A raster source with `targetFormat=svg` (US5.4, FR-003) |

### Reused codes

`missing_file`, `empty_file`, `unexpected_part`, `missing_target_format`,
`invalid_store_flag`, `same_format`, `input_too_large`,
`unsupported_source_format`, `unsupported_target_format`,
`xml_doctype_forbidden`, `output_too_large`, `timeout`, `internal_error`.

### Two status decisions worth defending

- **`targetFormat=svg` from a raster source → 415, not 400.** The value is
  syntactically valid (the spec's Assumptions say so) and SVG *is* a
  supported format — what is unsupported is it being a target. That is the
  same judgement feature 010 makes for an unsupported target format, so the
  two endpoints agree. The message states that vectorisation is never
  performed, which is what US5.4 asks for.
- **`targetFormat` equal to the detected source → 400 `same_format`.** The
  spec groups this with the previous case under "unsupported conversion
  direction", which is a description of the reason, not a status name. Both
  formats are supported and both are decodable/encodable; it is the *request*
  that is wrong, which is 400 — and it is the code and status feature 010
  already uses for exactly this. The spec's requirement is that each refusal
  be distinct and correctly described (US5 Independent Test); two different
  codes with two different messages satisfy that, and sibling endpoints
  answering the same mistake differently would not.

---

## 11. Alpha, orientation, colour, and multi-frame input

| Case | Rule | Requirement |
|---|---|---|
| PNG → JPEG with transparency | Composite onto `IMAGE_BACKGROUND_COLOR` (default `#ffffff`) via `.flatten({ background })`; result is fully opaque | FR-009, SC-003 |
| PNG → JPEG without transparency | Nothing to composite; the background has no visible effect | Edge case |
| JPEG → PNG | Opaque RGB in, opaque RGB out — no alpha channel is invented | FR-009 |
| SVG → PNG | Rendered over the configured background, alpha preserved where the drawing is transparent above it | FR-010 |
| SVG → JPEG | Rendered over the background, then flattened | FR-010 |
| EXIF orientation | Applied to the pixels during decode (`.rotate()`); the output is upright | Edge case |
| Other metadata | Cannot survive the raw-pixel hub; nothing is written back | FR-026, Edge case |
| Colour profile | Converted to sRGB during decode; the source profile is not carried into the result | Edge case |
| Animated / multi-frame | **The first frame is converted.** sharp's `animated: false` default; fixed by a test | Edge case |
| Greyscale, indexed, 16-bit PNG | Decoded and normalised to 8-bit RGB/RGBA, not refused | Edge case |

**Dimension preservation, precisely** (FR-008, SC-002): "the source image's
pixel dimensions" means the dimensions **after EXIF orientation is applied** —
what a viewer shows. For orientations 5–8 the stored raster is transposed, so
comparing against the stored width and height would fail for an image that
converted perfectly. The contract states the post-orientation reading and the
test asserts it.

**JPEG quality**: a fixed, documented default of **85**, configurable as
`IMAGE_JPEG_QUALITY` but never caller-supplied (spec Assumptions).

---

## 12. Atomicity and the response (FR-011, FR-012)

Identical to feature 010, for the same reason: the encoder returns a
**complete Buffer**, its size is checked against `IMAGE_MAX_OUTPUT_BYTES`,
and only then is any header written. A partially written image is not a case
to be handled — it is unrepresentable (FR-012, Edge case "failure
mid-stream").

Response headers on success:

```
Content-Type: image/png            (or image/jpeg)
Content-Disposition: attachment; filename="converted.png"
X-Image-Conversion-Retention: not-requested | stored | failed
```

The attachment name is always `converted`, never derived from the upload
(FR-011). `jpeg`'s extension is **`jpg`** — the conventional one; the handler
owns its own extension, so the format name and the extension are free to
differ and nothing else in the pipeline cares.

The retention header mirrors 010's `X-Conversion-Retention` under a distinct
name, so a client wiring up both endpoints cannot confuse them.

---

## 13. History, retention, and logging (FR-024 – FR-032)

**Decision**: reuse `ConversionHistoryService` and
`ConversionRetentionService` as they stand, widened to `RecordedFormat`.

Everything the spec asks for is already true of them:

- the record is written from a `finally` block and **outside any
  transaction**, so it survives a refusal, a render failure, a timeout, a
  rollback, and a caller who disconnects (FR-027);
- the table has **no column capable of holding image content** — the same
  structural guarantee, now covering pixels (FR-026, SC-012);
- retention writes under `CONVERSION_STORAGE_DIR`, deliberately outside the
  `@fastify/static`-served `ASSETS_DIR`, so a retained image is not readable
  by anyone who guesses a path (FR-030);
- a storage failure is reported as `failed` in both the header and the
  history row while the caller still receives a valid image, because the
  conversion did succeed (FR-031);
- nothing is stored for an attempt that did not complete (FR-029).

**One deliberate reading**: FR-025 lists "upload size" but no output size.
The shared `output_size_bytes` column is written anyway on success — the
schema's `CHECK` constraint requires it — and it is a byte count, not
content.

**The FR-032 log line** is the image analogue of 010's, emitted independently
of the history row:

```
image conversion user=<id> source=<png|jpeg|svg|unknown> target=<…> \
  inputBytes=<n> outcome=<success|failure code=<code>> durationMs=<n>
```

Numbers and fixed codes only. No file name, no pixels, no library message.

---

## 14. Configuration (Image Format Limit Configuration entity)

Ten settings, all validated by Joi at startup with defaults, so no code change
is needed to retune them (spec Assumptions).

| Setting | Default | Purpose |
|---|---|---|
| `IMAGE_MAX_BYTES_PNG` | 10485760 | Upload cap for detected PNG (FR-017) |
| `IMAGE_MAX_BYTES_JPEG` | 10485760 | Upload cap for detected JPEG |
| `IMAGE_MAX_BYTES_SVG` | 2097152 | Upload cap for detected SVG |
| `IMAGE_MAX_OUTPUT_WIDTH` | 8192 | Max rasterised width (FR-018) |
| `IMAGE_MAX_OUTPUT_HEIGHT` | 8192 | Max rasterised height (FR-018) |
| `IMAGE_MAX_PIXELS` | 16000000 | Decode pixel budget (FR-019) |
| `IMAGE_MAX_OUTPUT_BYTES` | 20971520 | Ceiling on the produced image |
| `IMAGE_BACKGROUND_COLOR` | `#ffffff` | Rasterisation / flatten background (FR-009, FR-010) |
| `IMAGE_JPEG_QUALITY` | 85 | Fixed output quality |
| `IMAGE_CONVERSION_TIMEOUT_MS` | 30000 | Time budget (FR-022) |
| `IMAGE_MAX_CONCURRENT` | 2 | Concurrency bound (FR-023) |
| `IMAGE_SVG_FONT_DIR` | *(empty)* | Optional font directory; empty ⇒ no system fonts |

Every numeric value is validated as a **positive integer** for the same
reason 010 gives: a zero ceiling would not disable a guard, it would refuse
every image while reporting a limit failure. `IMAGE_BACKGROUND_COLOR` is
validated against `^#[0-9a-fA-F]{6}$` — an unparseable colour at startup is
better than a black background discovered in production.

`CONVERSION_STORAGE_DIR` is reused; retained images share the root and the
`<userId>/<id>.<ext>` layout (FR-029, FR-030).

---

## 15. Rate limiting (FR-016)

`@Throttle({ default: { limit: 5, ttl: 60000 } })` on `POST
/api/images/convert` — **tighter than the text endpoint's 10/minute**,
because a single image conversion costs more memory and more CPU than a
single document conversion. `GET /api/images/convert/formats` keeps the
global `ThrottlerGuard` (FR-014 still requires a session for it).

---

## 16. Testing approach (Constitution IV)

**Unit** (`*.spec.ts`, colocated):

- each handler's decode and encode against fixture images, including
  greyscale / indexed / 16-bit PNG and an EXIF-rotated JPEG;
- `svg-security` — one case per refusal in §5, plus the parse-differential
  cases the text scan exists for;
- `svg-intrinsic-size` — every branch of §6's rule, including units,
  percentages, viewBox-only, fractional, zero, and absent;
- the registry — that directions are exactly the four, that `svg` never
  appears as a target, and that adding a fake handler with both capabilities
  widens the set with no other change (SC-014);
- the detector — magic bytes, conclusiveness, extension disagreement;
- the service — pixel budget, deadline, semaphore, retention outcomes;
- history writing for every error category.

**E2E** (`test/image-conversion.e2e-spec.ts`, isolated e2e database):

- all four directions end to end, asserting the returned bytes are a valid
  image of the requested format with the expected dimensions (SC-001, SC-002);
- PNG-with-alpha → JPEG, asserting formerly transparent pixels carry the
  background colour **pixel-wise** (SC-003);
- every refusal in §10, each asserting its own status *and* code (US5);
- SVG script, event handler, external entity, and remote `<image>` — refused,
  with an outbound-connection assertion (SC-006);
- a small PNG declaring enormous dimensions — refused, with process memory
  sampled before and after (SC-007);
- oversized uploads per format, asserting the response arrives before the
  whole body is consumed (SC-008);
- **discovery matches reality** — read `GET /formats`, drive every advertised
  direction to success, and assert every unadvertised pair is refused
  (SC-009, SC-010);
- history rows for success, failure, timeout, and client disconnect
  (SC-011), and an assertion that no row or log line carries image bytes
  (SC-012);
- retention on, off, and with a forced storage failure (SC-015).

**Fixtures** live in `test/support/image-fixtures/` and are generated by a
committed script rather than checked in as opaque binaries where practical,
so a reviewer can see what each one is.

**Performance** (`test/image-conversion-perf.e2e-spec.ts`, mirroring 010's
`conversion-perf.e2e-spec.ts`): a 2 MiB conversion under five seconds
(SC-004), a timeout honoured within its budget plus five seconds (SC-005),
and ten concurrent 2 MiB conversions with an unrelated `GET /health` request
delayed by under one second (SC-013).
