# Contract: `POST /api/images/convert`, `GET /api/images/convert/formats`

Field definitions are in [data-model.md](../data-model.md); the pixel-level
rules (SVG sizing, alpha, orientation, multi-frame) are in
[image-rasterisation-rules.md](./image-rasterisation-rules.md); decisions are
in [research.md](../research.md).

Both routes require a valid `access_token` cookie (`JwtAuthGuard`). A
missing, expired, malformed, or revoked token → **401**, with **no file read
and no history record written** (FR-014).

---

## `GET /api/images/convert/formats`

Lists every image conversion direction the service accepts. The list is
**derived from the registered handlers' capabilities** at request time — a
format with no `encode` cannot appear as a target, which is why SVG never
does (FR-013, FR-033, FR-034, SC-009).

### Response `200 OK`

```json
{
  "formats": [
    {
      "source": "jpeg",
      "mediaType": "image/jpeg",
      "extension": "jpg",
      "maxInputBytes": 10485760,
      "targets": ["png"]
    },
    {
      "source": "png",
      "mediaType": "image/png",
      "extension": "png",
      "maxInputBytes": 10485760,
      "targets": ["jpeg"]
    },
    {
      "source": "svg",
      "mediaType": "image/svg+xml",
      "extension": "svg",
      "maxInputBytes": 2097152,
      "targets": ["jpeg", "png"]
    }
  ]
}
```

- `targets` never contains `source`.
- **`targets` never contains `svg`, on any entry** (FR-003, SC-009). This is
  not filtered out; the SVG handler implements no `encode`, so the pair
  cannot be computed.
- `maxInputBytes` is that source format's administrator-configured limit
  (FR-017), so a client can refuse an oversized file before uploading it.
- Order is stable: sources alphabetically, targets alphabetically.

**Invariant (FR-013, SC-010)**: the set of `(source, target)` pairs
advertised here equals exactly the set `POST /api/images/convert` accepts.
Verified by an automated test that reads this endpoint, drives every
advertised pair to success, and asserts every unadvertised pair is refused.

### Errors

| Status | Cause |
|---|---|
| 401 | No valid session |
| 429 | Global rate limit |

---

## `POST /api/images/convert`

`Content-Type: multipart/form-data`. Rate limited to **5 requests per minute**
per client — tighter than `/api/convert`, because an image conversion costs
more (FR-016).

### Request parts

| Part | Type | Required | Value |
|---|---|---|---|
| `file` | file | yes | Exactly one. The image to convert |
| `targetFormat` | field | yes | `png` \| `jpeg` \| `svg` |
| `store` | field | no | `true` \| `false`; default `false` (FR-028) |

`svg` is an accepted *value* — it is a real format — but no direction
produces it, so it is always refused (see the error table).

Any other part, a duplicate part, or a second file → **400**
`unexpected_part`.

### Source format detection (FR-004)

Content decides; the file name is a secondary hint only.

| Format | Signature |
|---|---|
| `png` | `89 50 4E 47 0D 0A 1A 0A` |
| `jpeg` | `FF D8 FF` |
| `svg` | optional BOM and whitespace, then `<`, with an `<svg` token in the first 64 KiB |

A `.png` file containing JPEG bytes is converted as JPEG. A file matching no
signature → **415** `unsupported_source_format`, refused from the prefix
alone, before the rest of the upload is read.

Each signature is **conclusive**: a file with PNG magic whose pixel data is
corrupt is `image_invalid` (**400**), never "unsupported" (415). That
distinction is the point — a caller must be able to tell "I sent the wrong
kind of file" from "I sent a broken file of the right kind".

### Order of refusals

Fixed, and each step happens before the next is possible:

1. **401** — session, before any byte is read.
2. Multipart parts are read. The file is consumed under a byte budget:
   → **413** `input_too_large` the moment the detected format's limit is
   passed, without reading the rest (FR-017, SC-008).
   → **415** `unsupported_source_format` if nothing recognises the prefix.
   → **400** `empty_file` for a zero-byte file.
3. Fields validated → **400** `missing_target_format` / **400**
   `invalid_store_flag` / **415** `unsupported_target_format`.
4. Direction checked → **415** `image_vectorisation_unsupported` /
   **400** `same_format`.
5. SVG only: safety scan → **400** `svg_active_content` /
   `svg_external_reference` / `xml_doctype_forbidden`.
6. Size determined → **400** `image_pixel_budget_exceeded` /
   `image_dimensions_exceeded` / `svg_no_intrinsic_size`. **Nothing is
   decoded or rendered before this point** (FR-018, FR-019).
7. Decode, encode → **400** `image_invalid` / `svg_render_failed` /
   `output_too_large` / `timeout`.
8. Optional retention → never changes the status (FR-031).

**Inherited consequence**: a request that is both oversized *and* missing
`targetFormat` is answered **413**, not 400. The field may legitimately
arrive after the file part, and the file must be refused while the stream is
still open, so no ordering makes both refusals take precedence.

### Response `200 OK`

The converted image, as a complete body. The response is either a valid
image or an error — **never a partially written file** (FR-012): the encoder
produces a full buffer and only then is any header written.

| Header | Value |
|---|---|
| `Content-Type` | `image/png` or `image/jpeg` |
| `Content-Disposition` | `attachment; filename="converted.png"` / `"converted.jpg"` |
| `X-Image-Conversion-Retention` | `not-requested` \| `stored` \| `failed` |

- The attachment base name is always `converted`, never derived from the
  upload (FR-011).
- JPEG's extension is **`jpg`**, the conventional one. The handler owns its
  extension, so the format name and the extension are free to differ.
- `X-Image-Conversion-Retention: failed` means **the conversion succeeded and
  the image below is valid** — only keeping a copy did not (FR-031). It is
  named distinctly from `/api/convert`'s `X-Conversion-Retention` so a client
  wiring up both cannot confuse them.

### Error response body

Identical in shape to `/api/convert`:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "SVG input must not contain active content",
  "code": "svg_active_content"
}
```

`message` is built from **fixed text plus numbers only**. No part of the
uploaded file, no file name, and no library message can appear in it — the
type of the parameters makes that unrepresentable (FR-026, SC-012).

### Error table

| Status | `code` | Category | Cause |
|---|---|---|---|
| 400 | `missing_file` | bad_request | No `file` part |
| 400 | `empty_file` | bad_request | Zero-byte file |
| 400 | `unexpected_part` | bad_request | Extra, duplicate, or misnamed part |
| 400 | `missing_target_format` | bad_request | `targetFormat` absent |
| 400 | `invalid_store_flag` | bad_request | `store` not `true`/`false` |
| 400 | `same_format` | bad_request | `targetFormat` equals the detected source (US5.5) |
| 400 | `image_invalid` | parse_error | Not a valid image of its detected format, or truncated (US1.5) |
| 400 | `image_pixel_budget_exceeded` | structure_limit_exceeded | Declared pixels over `IMAGE_MAX_PIXELS` (US3.5) |
| 400 | `image_dimensions_exceeded` | structure_limit_exceeded | Rendered size over the configured maximum (US2.3) |
| 400 | `svg_no_intrinsic_size` | bad_request | Size resolvable from neither width/height nor viewBox (US2.4) |
| 400 | `svg_active_content` | bad_request | Script, event handler, or other executable construct (US3.1) |
| 400 | `svg_external_reference` | bad_request | External entity or external resource reference (US3.2) |
| 400 | `xml_doctype_forbidden` | parse_error | A `DOCTYPE` declaration (closes entity-expansion attacks) |
| 400 | `svg_render_failed` | parse_error | The renderer could not process the drawing (US2.5) |
| 400 | `output_too_large` | structure_limit_exceeded | Encoded result over `IMAGE_MAX_OUTPUT_BYTES` |
| 400 | `timeout` | timeout | Over `IMAGE_CONVERSION_TIMEOUT_MS` (FR-022) |
| 401 | — | — | No valid session (no history row) |
| 413 | `input_too_large` | payload_too_large | Over the **detected source format's** limit (FR-017) |
| 415 | `unsupported_source_format` | unsupported_media_type | Not PNG, JPEG, or SVG (US5.6) |
| 415 | `unsupported_target_format` | unsupported_media_type | `targetFormat` outside the accepted set |
| 415 | `image_vectorisation_unsupported` | unsupported_media_type | Raster source with `targetFormat=svg` (US5.4, FR-003) |
| 429 | — | — | Rate limit |
| 500 | `internal_error` | internal_error | Unexpected failure |

**Why `same_format` is 400 while raster→`svg` is 415**: in the first the
request is wrong — both formats are supported and both directions exist in
principle. In the second the *target* is genuinely not supported, which is
the same judgement `/api/convert` makes for an unsupported target. The two
endpoints therefore answer the same mistake the same way. Both refusals carry
distinct codes and distinct messages, which is what US5 requires.

### History

Every authenticated attempt writes one `conversion_records` row, successful
or not, from a `finally` block and outside any transaction — so it survives
refusals, render failures, timeouts, rollbacks, and a caller who disconnects
(FR-024, FR-027, SC-011). A **401 writes no row**: no conversion code runs.

The row carries process metadata only. The table has no column capable of
holding image content (FR-026, SC-012).

### Retention (`store=true`)

| Situation | Header | `retention_outcome` | On disk |
|---|---|---|---|
| Not requested | `not-requested` | `not_requested` | nothing |
| Requested, conversion succeeded, stored | `stored` | `stored` | `<userId>/<id>.<ext>` under `CONVERSION_STORAGE_DIR` |
| Requested, conversion succeeded, storage failed | `failed` | `failed` | nothing — a file that cannot be linked is discarded |
| Requested, conversion failed | *(error response)* | `failed` | nothing (FR-029) |

Retained images are private to their owner (FR-030) and are **not served
over HTTP by this feature at all** — the storage root sits outside the
statically served `ASSETS_DIR`. Reading them back is out of scope for this
feature.

---

## OpenAPI

Both routes are decorated so the published document matches the running
contract (Constitution V): `@ApiTags('image-conversion')`,
`@ApiConsumes('multipart/form-data')`, `@ApiProduces('image/png',
'image/jpeg')`, an `@ApiBody` schema for the three parts, and a response
decorator for each status in the table above, including the documented
headers.
