# Quickstart: Image Conversion

Validates the feature end-to-end against a running local backend and
Postgres. The HTTP contract is in
[contracts/image-conversion-api.md](./contracts/image-conversion-api.md);
the pixel-level rules being checked are in
[contracts/image-rasterisation-rules.md](./contracts/image-rasterisation-rules.md).

## Prerequisites

1. Dependencies installed (this feature adds two native packages):

   ```bash
   npm install sharp @resvg/resvg-js
   ```

2. Migrations applied (widens the `conversion_format` enum with `png`,
   `jpeg`, `svg` — no new table) and the app running:

   ```bash
   npm run migration:run
   npm run start:dev
   ```

3. `.env` carries the image settings. Defaults are fine; the small SVG limit
   and modest maximum dimensions below are what make the limit scenarios
   meaningful:

   ```bash
   IMAGE_MAX_BYTES_PNG=10485760
   IMAGE_MAX_BYTES_JPEG=10485760
   IMAGE_MAX_BYTES_SVG=65536
   IMAGE_MAX_OUTPUT_WIDTH=2048
   IMAGE_MAX_OUTPUT_HEIGHT=2048
   IMAGE_MAX_PIXELS=16000000
   IMAGE_MAX_OUTPUT_BYTES=20971520
   IMAGE_BACKGROUND_COLOR=#ffffff
   IMAGE_JPEG_QUALITY=85
   IMAGE_CONVERSION_TIMEOUT_MS=30000
   IMAGE_MAX_CONCURRENT=2
   IMAGE_SVG_FONT_DIR=
   CONVERSION_STORAGE_DIR=./storage/conversions
   ```

   `IMAGE_SVG_FONT_DIR` being empty is meaningful rather than unset: no fonts
   are loaded and no system-font scan happens, so `<text>` in an SVG renders
   as nothing.

   Note also that `POST /api/images/convert` is rate limited to **5 requests
   per minute**. Working through a scenario back to back will hit `429`;
   pause a minute, or restart the app, between batches.

4. A signed-in user. Log in via `POST /auth/login` and save the cookie jar as
   `cookies.txt`.

5. Fixtures in the working directory. Generate the rasters with `sharp` so
   nothing opaque is checked in:

   ```bash
   node -e '
   const sharp = require("sharp");
   const solid = { create: { width: 200, height: 120, channels: 4,
     background: { r: 200, g: 40, b: 40, alpha: 1 } } };
   const clear = { create: { width: 200, height: 120, channels: 4,
     background: { r: 200, g: 40, b: 40, alpha: 0 } } };
   sharp(solid).png().toFile("photo.png");
   sharp(solid).jpeg().toFile("photo.jpg");
   sharp(clear).png().toFile("transparent.png");
   sharp(solid).greyscale().png({ colours: 16 }).toFile("indexed.png");
   '

   printf '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">
     <rect width="120" height="80" fill="#3366cc"/></svg>' > drawing.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">
     <circle cx="150" cy="75" r="60" fill="#cc3366"/></svg>' > viewbox-only.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' \
     > no-size.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999">
     <rect width="10" height="10"/></svg>' > enormous.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
     <script>fetch("http://127.0.0.1:9/x")</script></svg>' > scripted.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"
     onload="alert(1)"><rect width="10" height="10"/></svg>' > onload.svg

   printf '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>
     <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
     <text>&x;</text></svg>' > xxe.svg

   printf '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
     <image href="http://127.0.0.1:9/pixel.png" width="10" height="10"/></svg>' \
     > remote-image.svg

   printf '' > empty.png
   head -c 400 /dev/urandom > notanimage.bin
   ```

Replace `3007` with your `PORT` throughout.

---

## Scenario 1 — Discovery (Story 4)

```bash
curl -s -b cookies.txt http://localhost:3007/api/images/convert/formats
```

**Expect**: `200`, three entries. `png` offers `["jpeg"]`, `jpeg` offers
`["png"]`, `svg` offers `["jpeg","png"]`. **No entry lists `svg` as a
target** (FR-003, SC-009). `svg`'s `maxInputBytes` reports `65536`, matching
the `.env` above.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:3007/api/images/convert/formats
```

**Expect**: `401` with no cookie jar (US4.4).

---

## Scenario 2 — The four directions (Stories 1 and 2)

```bash
convert() {
  curl -s -b cookies.txt -D headers.txt -o "out.$3" \
    -F "file=@$1" -F "targetFormat=$2" \
    http://localhost:3007/api/images/convert
  grep -iE 'content-type|content-disposition|x-image-conversion-retention' headers.txt
  file "out.$3"
}

convert photo.png       jpeg jpg   # png  → jpeg
convert photo.jpg       png  png   # jpeg → png
convert drawing.svg     png  png   # svg  → png
convert drawing.svg     jpeg jpg   # svg  → jpeg
```

**Expect** for each: `200`; `Content-Type: image/png` or `image/jpeg`;
`Content-Disposition: attachment; filename="converted.png"` (or
`converted.jpg`); `X-Image-Conversion-Retention: not-requested`; and `file`
reporting a valid image of the requested format (SC-001).

**Dimensions** (SC-002 and US2.1):

```bash
node -e 'require("sharp")("out.jpg").metadata().then(m =>
  console.log(m.format, m.width, m.height))'
```

- `photo.png → jpeg` and `photo.jpg → png`: **200 × 120**, matching the
  source exactly.
- `drawing.svg → png/jpeg`: **120 × 80**, the SVG's declared size.
- `viewbox-only.svg → png`: **300 × 150**, derived from the view box.

---

## Scenario 3 — Transparency composited onto the background (SC-003)

```bash
curl -s -b cookies.txt -o flat.jpg \
  -F "file=@transparent.png" -F "targetFormat=jpeg" \
  http://localhost:3007/api/images/convert

node -e '
require("sharp")("flat.jpg").raw().toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => {
    console.log("channels:", info.channels);          // 3 — no alpha
    console.log("first pixel:", data[0], data[1], data[2]);  // 255 255 255
  });'
```

**Expect**: three channels (fully opaque), and every formerly transparent
pixel carrying `IMAGE_BACKGROUND_COLOR` — `255 255 255` for the default
`#ffffff`. Verified pixel-wise, not by eye (US1.3, FR-009).

A PNG **without** transparency converts identically whatever the background
is set to.

---

## Scenario 4 — Greyscale, indexed, and rotated input

```bash
convert indexed.png jpeg jpg
```

**Expect**: `200`. Greyscale, indexed-colour, and 16-bit-per-channel PNGs are
decoded and re-encoded, **not refused** (Edge case).

For EXIF orientation, convert a photograph carrying an `Orientation` tag of
6 or 8 and confirm the output is upright and that its width and height are
the **post-orientation** ones — the reading a viewer shows, and the one
FR-008 is measured against.

---

## Scenario 5 — Refusals (Story 5)

```bash
refuse() {
  curl -s -b "${3:-cookies.txt}" -w '\n%{http_code}\n' \
    -F "file=@$1" -F "targetFormat=$2" \
    http://localhost:3007/api/images/convert
}

# No session
curl -s -w '\n%{http_code}\n' -F "file=@photo.png" -F "targetFormat=jpeg" \
  http://localhost:3007/api/images/convert

# Zero-byte file
refuse empty.png jpeg

# Missing targetFormat
curl -s -b cookies.txt -w '\n%{http_code}\n' -F "file=@photo.png" \
  http://localhost:3007/api/images/convert

# Unrecognised targetFormat
refuse photo.png gif

# Vectorisation
refuse photo.png svg

# Same source and target
refuse photo.png png

# Not an image at all
refuse notanimage.bin png

# Truncated PNG
head -c 120 photo.png > broken.png && refuse broken.png jpeg
```

**Expect**, each with its own distinct `code`:

| Case | Status | `code` |
|---|---|---|
| No session | 401 | — |
| Zero-byte file | 400 | `empty_file` |
| Missing `targetFormat` | 400 | `missing_target_format` |
| `targetFormat=gif` | 415 | `unsupported_target_format` |
| `targetFormat=svg` from PNG | 415 | `image_vectorisation_unsupported` |
| PNG → PNG | 400 | `same_format` |
| Random bytes | 415 | `unsupported_source_format` |
| Truncated PNG | 400 | `image_invalid` |

The last two are the distinction that matters: PNG magic present but broken
is `image_invalid` (400), not "unsupported" (415).

---

## Scenario 6 — SVG safety (Story 3, SC-006)

Watch for outbound connections while running these — the fixtures point at
`127.0.0.1:9`, so anything that leaks is visible. (The automated suite does
the same thing on port `9099`, where it can bind a listener without root.)

```bash
# in another terminal
nc -l 9        # or: lsof -nP -iTCP -sTCP:SYN_SENT -p $(pgrep -f 'nest start')
```

```bash
refuse scripted.svg     png   # 400 svg_active_content
refuse onload.svg       png   # 400 svg_active_content
refuse xxe.svg          png   # 400 xml_doctype_forbidden
refuse remote-image.svg png   # 400 svg_external_reference
```

**Expect**: all four refused, each with its own code, and **no connection
attempt at all** — not a failed one, none. The module contains no HTTP
client, so the guarantee is the absence of a code path (FR-021, SC-006).

Nothing is rendered in any of these cases.

---

## Scenario 7 — Size, dimension, and pixel limits (Story 3)

```bash
# Over the configured maximum output dimensions
refuse enormous.svg png          # 400 image_dimensions_exceeded

# No determinable size
refuse no-size.svg png           # 400 svg_no_intrinsic_size

# Over SVG's 64 KiB byte limit
python3 -c "
open('big.svg','w').write('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\">'
  + '<!--' + 'x'*200000 + '-->' + '</svg>')"
refuse big.svg png               # 413 input_too_large

# Within PNG's much larger limit — the limit applied is the detected format's
cp big.svg big-but-png-sized.svg  # still SVG by content → still 413
```

**Expect**: `image_dimensions_exceeded` names the applicable maximum;
`input_too_large` names SVG's limit specifically (FR-017, US3.4). The
oversized upload is refused **while it is still arriving** — the response
comes back before the full body has been sent (SC-008).

**Decompression bomb** (SC-007) — a small PNG declaring enormous dimensions:

```bash
node -e '
const zlib = require("zlib"), crc = require("buffer-crc32");
// IHDR declaring 40000 x 40000 in a file of a few hundred bytes
' # or craft with any PNG editor

refuse bomb.png jpeg             # 400 image_pixel_budget_exceeded
```

**Expect**: refused from the header alone. Sample RSS before and after — it
should not move measurably, because no pixel buffer is ever allocated.

---

## Scenario 8 — History (FR-024 – FR-027, SC-011, SC-012)

After running Scenarios 2 and 5:

```sql
SELECT source_format, target_format, outcome, error_category,
       failure_reason, input_size_bytes, output_size_bytes,
       retention_outcome, duration_ms
FROM conversion_records
WHERE source_format IN ('png','jpeg','svg')
   OR target_format IN ('png','jpeg','svg')
ORDER BY started_at DESC
LIMIT 20;
```

**Expect**:

- one row per attempt, successes and failures alike, all attributed to the
  signed-in user;
- image rows sit in the **same table** as text-conversion rows — no separate
  history (FR-024);
- the 401 attempt has **no row** — no conversion code ran;
- `failure_reason` is a fixed code, never a library message, never a file
  name fragment, and never image bytes (SC-012);
- `error_category` matches the contract's table.

Confirm the same of the logs:

```bash
grep 'image conversion' <app log> | head
```

**Expect** lines of the form `image conversion user=… source=png target=jpeg
inputBytes=… outcome=success durationMs=…` — numbers and fixed codes only
(FR-032).

---

## Scenario 9 — Optional retention (Story 6, SC-015)

```bash
# Kept
curl -s -b cookies.txt -D h1.txt -o kept.jpg \
  -F "file=@photo.png" -F "targetFormat=jpeg" -F "store=true" \
  http://localhost:3007/api/images/convert
grep -i x-image-conversion-retention h1.txt        # stored

# Not kept
curl -s -b cookies.txt -D h2.txt -o loose.jpg \
  -F "file=@photo.png" -F "targetFormat=jpeg" \
  http://localhost:3007/api/images/convert
grep -i x-image-conversion-retention h2.txt        # not-requested

cmp kept.jpg loose.jpg && echo "downloads identical"
```

```sql
SELECT r.retention_outcome, r.stored_file_id,
       f.format, f.size_bytes, f.storage_path
FROM conversion_records r
LEFT JOIN conversion_stored_files f ON f.id = r.stored_file_id
WHERE r.target_format = 'jpeg'
ORDER BY r.started_at DESC LIMIT 2;
```

**Expect**: the first has `retention_outcome = 'stored'`, a linked row, and a
file on disk at `CONVERSION_STORAGE_DIR/<userId>/<id>.jpg`; the second has
`not_requested`, no link, and nothing on disk. **The two downloads are byte
identical** — asking to keep a copy changes nothing about the response.

```bash
# Retention with a failing conversion keeps nothing (US6.3)
refuse notanimage.bin png    # with -F store=true
ls -R ./storage/conversions  # unchanged
```

**Storage failure** (US6.4) — make the root unwritable and repeat the first
call:

```bash
chmod 500 ./storage/conversions
```

**Expect**: still `200` with a **valid JPEG**, but
`X-Image-Conversion-Retention: failed` and `retention_outcome = 'failed'`
with no `stored_file_id`. The conversion succeeded; only keeping a copy did
not (FR-031). Restore with `chmod 700`.

---

## Scenario 10 — Timeout and concurrency (SC-005, SC-013)

Set `IMAGE_CONVERSION_TIMEOUT_MS=1000` and restart, then convert a large,
filter-heavy SVG:

**Expect**: `400 timeout`, returned within the budget plus a small margin,
and the attempt recorded with `error_category = 'timeout'`.

Restore the budget, then run ten concurrent 2 MiB conversions while polling
an unrelated endpoint:

```bash
for i in $(seq 10); do
  curl -s -b cookies.txt -o /dev/null \
    -F "file=@big-photo.png" -F "targetFormat=jpeg" \
    http://localhost:3007/api/images/convert &
done

while jobs -r | grep -q curl; do
  curl -s -o /dev/null -w '%{time_total}\n' http://localhost:3007/health
  sleep 0.2
done
wait
```

**Expect**: every conversion succeeds, and no `/health` response takes more
than one second (SC-013). Image work runs on the libuv threadpool, so the
event loop stays free.

---

## Scenario 11 — Discovery matches reality (SC-010)

Read `GET /api/images/convert/formats`, drive **every** advertised
`(source, target)` pair to a `200`, and confirm every unadvertised pair —
`png→svg`, `jpeg→svg`, `svg→svg`, `png→png`, `jpeg→jpeg` — is refused. The
automated version of this check lives in `test/image-conversion.e2e-spec.ts`
and is the gate for FR-013; the manual loop in Scenario 2 is the same
assertion by hand.

---

## Automated suites

```bash
npm run verify     # typecheck + lint + unit tests (required gate)
npm run test:e2e   # includes test/image-conversion.e2e-spec.ts
```
