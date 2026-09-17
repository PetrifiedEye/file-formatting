# Contract: Image Conversion Rules

The pixel-level behaviour of the four supported directions. Every rule here
is fixed by a test — the spec requires several of them to be "documented and
deterministic" rather than merely whatever the library happens to do.

The wire contract is in
[image-conversion-api.md](./image-conversion-api.md); decisions are in
[research.md](../research.md).

---

## The hub

Every conversion is:

```
decode(source bytes) → RasterImage → encode(target bytes)
```

`RasterImage` is raw 8-bit-per-channel pixels plus width, height, and an
alpha flag. **It has no metadata field**, so EXIF, GPS, camera data, and
colour profiles cannot cross it (FR-026).

Directions come from capabilities, not from a table: PNG and JPEG implement
both `decode` and `encode`; SVG implements only `decode`. That is why
`png→svg` and `jpeg→svg` are impossible rather than forbidden (FR-003).

---

## 1. PNG → JPEG

1. Decode. Greyscale, indexed-colour, and 16-bit-per-channel PNGs are all
   decoded and normalised to 8-bit RGB/RGBA — **not refused**.
2. Apply EXIF orientation, if present, to the pixels.
3. Convert to sRGB. A source colour profile is not carried into the result.
4. If the image has an alpha channel, **composite it onto
   `IMAGE_BACKGROUND_COLOR`** (default `#ffffff`). The result is fully
   opaque (FR-009, SC-003).
5. Encode at `IMAGE_JPEG_QUALITY` (default 85), a fixed default that is never
   caller-supplied.

**Dimensions are preserved exactly** (FR-008, SC-002).

A PNG with no transparency converts identically; the background colour has no
visible effect.

## 2. JPEG → PNG

1. Decode, apply EXIF orientation, convert to sRGB.
2. Encode as PNG. **No alpha channel is invented** — an opaque source
   produces an opaque result.

**Dimensions are preserved exactly.** The visible picture is unchanged apart
from the JPEG losses already baked into the source.

## 3. SVG → PNG

1. Validate (§5). Refuse before rendering if anything fails.
2. Resolve the intrinsic size (§4). Refuse if it cannot be determined or
   exceeds the configured maximum — **before the renderer is constructed**
   (FR-018).
3. Render at exactly that size (`fitTo: original` — no scaling), over
   `IMAGE_BACKGROUND_COLOR`.
4. Encode as PNG, preserving alpha where the drawing is transparent above the
   background.

## 4. SVG → JPEG

As §3, then flatten onto the background and encode at `IMAGE_JPEG_QUALITY`.
The result is fully opaque.

---

## 5. SVG intrinsic size — the deterministic rule

Applied to the root `<svg>` element:

1. `width` and `height` are resolved **independently**.
   - A unitless number is CSS pixels.
   - `px`, `pt`, `pc`, `mm`, `cm`, `in` convert at **96 dpi**:
     `1in = 96px`, `1pt = 96/72px`, `1pc = 16px`, `1mm = 96/25.4px`,
     `1cm = 96/2.54px`.
   - `em`, `ex`, `%`, and anything unparseable **do not resolve**.
2. A dimension that does not resolve is taken from `viewBox` — its third
   value for width, its fourth for height, in user units (= px).
3. If a dimension resolves from neither source, the drawing is refused:
   **400 `svg_no_intrinsic_size`**.
4. Fractional results are rounded **up**, minimum 1. Ceiling rather than
   nearest, so a `10.2px` drawing is never clipped.
5. A dimension resolving to zero or a negative value is refused as
   `svg_no_intrinsic_size`.
6. The whole-pixel result is checked against `IMAGE_MAX_OUTPUT_WIDTH`,
   `IMAGE_MAX_OUTPUT_HEIGHT`, and `IMAGE_MAX_PIXELS`. Over any of them →
   **400 `image_dimensions_exceeded`**, naming the limit exceeded.

Steps 4 and 6 are in this order deliberately: the check is against the size
that will actually be produced.

### Worked examples

| Root attributes | Result |
|---|---|
| `width="100" height="50"` | 100 × 50 |
| `width="1in" height="0.5in"` | 96 × 48 |
| `width="10.2" height="10.8"` | 11 × 11 |
| `width="100%" height="100%" viewBox="0 0 300 150"` | 300 × 150 |
| `viewBox="0 0 300 150"` (no width/height) | 300 × 150 |
| `width="200" viewBox="0 0 300 150"` | 200 × 150 |
| *(neither)* | 400 `svg_no_intrinsic_size` |
| `width="0" height="100"` | 400 `svg_no_intrinsic_size` |
| `width="99999" height="99999"` | 400 `image_dimensions_exceeded` |

---

## 6. SVG safety — what is refused

Checked **before any rendering**, in this order. The validator **refuses or
passes the original bytes through**; it never rewrites the document, because
a re-serialized document is no longer the one that was checked.

### 6.1 Raw-text scan (case-insensitive)

Refused on sight: `<!DOCTYPE`, `<!ENTITY`, `<script`, `javascript:`,
`@import`, and any `on<name>=` attribute pattern.

### 6.2 Structured walk

The document is parsed (entities not processed) and refused if it contains:

| Construct | Code |
|---|---|
| `script`, `foreignObject`, `iframe`, `embed`, `object`, `handler`, `audio`, `video` elements | `svg_active_content` |
| Any attribute whose name begins with `on` | `svg_active_content` |
| Any attribute value using the `javascript:` scheme | `svg_active_content` |
| `href` / `xlink:href` / `src` resolving to anything but `#fragment` or `data:` | `svg_external_reference` |
| `style`, `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-*` containing `url(...)` failing the same test | `svg_external_reference` |
| `<style>` text containing `@import`, or `url(...)` failing the same test | `svg_external_reference` |
| A `DOCTYPE` or entity declaration | `xml_doctype_forbidden` |

### 6.3 What is allowed

- Same-document fragment references (`url(#gradient)`, `href="#path1"`).
- Inline `data:` URIs — embedded images render with **no network access**.
- All ordinary drawing, gradients, filters, masks, and paths.

### 6.4 Guarantees

- **No entity expansion is ever performed.** A `DOCTYPE` is refused at 6.1,
  so billion-laughs has nothing to expand.
- **No outbound network request is made while processing an upload**
  (FR-021, SC-006). The module contains no HTTP client and reads no file the
  document names; the validator and the renderer's own inability to fetch are
  defence in depth on top of that.
- Two independent checks (6.1 and 6.2) exist because they fail differently: a
  construct would have to be invisible to the parser *and* invisible to a
  literal scan *and* meaningful to the renderer.

### 6.5 Fonts

`loadSystemFonts` is **off**. Text renders using only fonts from
`IMAGE_SVG_FONT_DIR`, if one is configured.

**Stated plainly**: with no font directory configured, `<text>` renders as
nothing. This is deliberate — substituting whatever font a host happens to
have would make output non-reproducible across machines.

---

## 7. Cross-cutting rules

| Case | Behaviour | Requirement |
|---|---|---|
| **EXIF orientation** | Applied to the pixels during decode; the output is upright | Edge case |
| **Dimension preservation** | Compared **after** orientation — what a viewer shows. For orientations 5–8 the stored raster is transposed, so the post-orientation reading is the correct one | FR-008, SC-002 |
| **Other metadata** | Not carried. Cannot cross the hub, and nothing writes it back | FR-026 |
| **Colour profile** | Converted to sRGB on decode; the source profile is not carried | Edge case |
| **Animated / multi-frame input** | **The first frame is converted**, and the rest are ignored. Fixed by a test | Edge case |
| **Truncated pixel data** | 400 `image_invalid` — never a partial picture | Edge case |
| **Zero-byte file** | 400 `empty_file` | FR-006 |
| **Extension disagrees with content** | Content decides; if content matches no supported format, 415 | FR-004 |
| **Atomicity** | The encoder returns a complete buffer; headers are written only after it exists | FR-012 |
| **Caller disconnects** | The conversion is abandoned and the attempt is still recorded | FR-027 |

---

## 8. Adding a fourth image format (SC-014)

The worked example the spec requires. To add WebP:

1. Write `src/modules/image-conversion/formats/webp.handler.ts` implementing
   `ImageFormatHandler` with both `decode` and `encode`, its magic-byte
   `sniff`, and a `detectionPriority`.
2. Add `WEBP = 'webp'` to `ImageFormat`, and `'webp'` to the
   `conversion_format` PostgreSQL enum in a migration.
3. Add `WebpHandler` to the `providers` array and the `IMAGE_FORMAT_HANDLERS`
   factory in `image-conversion.module.ts`.
4. Add `IMAGE_MAX_BYTES_WEBP` to the config types, the Joi schema, and the
   limits factory.

**What is not touched**: `PngHandler`, `JpegHandler`, `SvgHandler`, the
controller, the request DTO, the discovery response shape, the registry, the
detector, or the service. Discovery immediately advertises `webp→png`,
`webp→jpeg`, `png→webp`, `jpeg→webp`, and `svg→webp`, and the pipeline
immediately accepts exactly those — because both read the same capability
set.

A unit test registers a fake handler and asserts precisely this: the
direction set widens and no existing handler is consulted.

---

## 9. Invariants worth not breaking

1. **SVG has no `encode`.** The moment one is added, vectorisation becomes
   representable and FR-003 stops being structural.
2. **The validator never rewrites.** Rewriting reintroduces the parse
   differential it exists to close.
3. **Size is checked before rendering**, not after. FR-018 says no rendering
   is performed for an oversized drawing.
4. **The pixel budget is checked from the header**, not from a decoded
   buffer. Checking after the allocation is exactly the failure SC-007 tests
   for.
5. **The hub carries no metadata field.** Adding one would make FR-026 a rule
   to remember rather than a shape to rely on.
6. **Discovery and enforcement are one computation.** Two lists drift.
