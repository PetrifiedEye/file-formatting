# Image conversion

`POST /api/images/convert` and `GET /api/images/convert/formats`, both behind
the `JwtAuthGuard` cookie session.

The wire contract is
[`specs/011-image-conversion/contracts/image-conversion-api.md`](../../../specs/011-image-conversion/contracts/image-conversion-api.md);
the pixel-level rules are
[`image-rasterisation-rules.md`](../../../specs/011-image-conversion/contracts/image-rasterisation-rules.md).
This file covers what a reader of the code needs that those do not say.

---

## The capability model

Every conversion is one shape:

```
decode(source bytes) → RasterImage → encode(target bytes)
```

A format is one `ImageFormatHandler` that may implement `decode`, `encode`, or
both. The registry computes directions as *decoders × encoders, minus
self-pairs*. Nothing enumerates a direction anywhere.

| Handler | `decode` | `encode` |
|---|---|---|
| `PngHandler` | ✓ | ✓ |
| `JpegHandler` | ✓ | ✓ |
| `SvgHandler` | ✓ | **absent** |

Three handlers give exactly four directions: `png→jpeg`, `jpeg→png`,
`svg→png`, `svg→jpeg`.

### Why `png→svg` is not "forbidden"

It is **unrepresentable**. There is no rule refusing it, no list it is missing
from, and no branch checking for it. `SvgHandler` has no `encode`, so the pair
cannot be computed — discovery cannot advertise it and the pipeline cannot
reach it. A raster source naming `svg` is answered
`415 image_vectorisation_unsupported`, which comes from the registry failing to
find an encoder, not from a special case.

**The invariant to not break: never add an `encode` to `SvgHandler`.** The
moment one exists, vectorisation becomes representable and this stops being
structural. `svg.handler.spec.ts` asserts the absence.

The same property makes discovery honest: `GET …/formats` and `POST …/convert`
read the *same computation*, so they cannot drift. Two lists would.

---

## The canonical hub

```ts
interface RasterImage {
  data: Buffer;   // row-major, 8 bits per channel
  width: number;  // post-orientation
  height: number;
  channels: 3 | 4;
  hasAlpha: boolean;
}
```

**It has no metadata field, and that is the mechanism.** EXIF, GPS, camera
data, and colour profiles cannot cross it because there is nowhere for them to
sit. "No image metadata is stored or logged" is enforced by shape, not by every
handler remembering to strip something.

`width` and `height` are **post-orientation** — what a viewer shows. A JPEG
with EXIF orientation 6 stores 48×64 and displays 64×48; the second reading is
the one "the source image's pixel dimensions" means, and comparing against the
stored raster would fail for an image that converted perfectly.

---

## Safety, in the order it is applied

1. **Session** — before any byte is read.
2. **Per-source-format byte budget**, applied *while the upload streams*. The
   reader destroys the stream the moment the budget is passed, so an oversized
   upload is refused without being read to the end. The budget is the
   *detected* format's, which is why the same byte count is accepted as PNG and
   refused as SVG.
3. **Content-based detection** from magic bytes. The file name is a secondary
   hint only: a `.png` file containing JPEG bytes is converted as JPEG. Every
   signature is conclusive, which is what keeps a corrupt PNG a
   `400 image_invalid` rather than a `415 unsupported_source_format` — a caller
   must be able to tell "wrong kind of file" from "broken file of the right
   kind".
4. **SVG safety** (SVG only) — see below.
5. **Size** — the pixel budget for rasters, read from the container *header*
   before any allocation; the intrinsic-size rule for SVG, resolved before the
   renderer is constructed.
6. **Decode, encode**, under a deadline and a concurrency bound.
7. **Output ceiling**, on the complete buffer, before any header is written.

Steps 5 and 7 are where most of the value is. The pixel budget is checked
against what the header *declares*: a 229-byte PNG declaring 30000×30000 is
refused having allocated nothing, where a reader that trusted the declaration
would ask for 3.6 GB. And because the encoder returns a complete buffer that is
measured before a header is written, a partially written image is not a case to
handle — it is unrepresentable.

### SVG safety

Two independent checks, because they fail differently:

- a **raw-text scan** for `<!DOCTYPE`, `<!ENTITY`, `<script`, `javascript:`,
  `@import`, and `on<name>=`;
- a **structured walk** (`fast-xml-parser`, `processEntities: false`) refusing
  active elements, `on*` attributes, and every reference that is not a
  same-document fragment or an inline `data:` URI.

A construct would have to be invisible to the parser *and* invisible to a
literal scan *and* meaningful to the renderer. A parser differential is the
classic way a sanitizer is bypassed.

**The validator never rewrites.** It refuses, or it passes the *original bytes*
to the renderer. Re-serializing would recreate exactly the differential the two
checks exist to close: what was checked would no longer be what is rendered.

Refusing `<!DOCTYPE` outright is what closes billion-laughs. No entity
expansion is performed at any point, so there is no expansion budget to tune
and no bomb to survive.

### No outbound requests

The guarantee is **the absence of a code path**: this module contains no HTTP
client, no `fetch`, and reads no file that an uploaded document names. The
validator and resvg's own inability to fetch are defence in depth on top of
that. `image-conversion.service.spec.ts` asserts the absence over every source
file here, and the e2e suite observes a listening socket that the attack corpus
points at and records zero connections.

---

## Two library behaviours worth knowing

### `renderAsync` is available, and is what we use

`@resvg/resvg-js@2.6.2` exposes a module-level `renderAsync(svg, options,
signal)` — the `Resvg` class itself is synchronous, but the async function is
the one this module calls. So SVG rasterisation runs off the event loop and
honours the conversion deadline, the same as sharp's work. **If a future
version drops it**, the output-dimension cap becomes the operative bound on how
long a render can block, and that should be said here rather than assumed away.

### resvg rounds where the contract ceils

The intrinsic-size rule rounds a fractional dimension **up**, so a `10.2px`
drawing is never clipped. resvg rounds to nearest and produces 10. Rather than
let the library quietly redefine a documented rule, `SvgHandler.fit()` extends
the canvas to the resolved size with the background colour — the drawing is
neither scaled nor moved, and the output is exactly the size the contract
promises. This is the only place the two disagree; every other worked example
in the contract matches resvg exactly.

### Fonts

`loadSystemFonts` is **off**. Text renders using only fonts from
`IMAGE_SVG_FONT_DIR`, if one is configured.

**Stated plainly: with no font directory configured, `<text>` renders as
nothing.** This is deliberate. Substituting whatever font a host happens to
have would make the same SVG convert differently on two machines.

### Multi-frame input

sharp's `animated: false` default means a multi-frame container yields its
first frame. There is no generated fixture for this: libvips cannot *write* an
APNG or a multi-frame GIF on the platforms this runs on, so a fixture would
have to be an opaque committed blob. What is covered is the adjacent real case
— a progressive (multi-scan) JPEG decoding to one complete image.

---

## History and storage

This feature **adds no table and no column**. Image attempts are rows in
feature 010's `conversion_records`; retained images are rows in its
`conversion_stored_files`. The only schema change is widening the
`conversion_format` enum.

There is no discriminator column: an attempt is an image attempt exactly when
its format is an image format, and a `kind` column would be derived data able
to disagree with the data it is derived from.

The history row is written from a `finally` block and **outside any
transaction**, so it survives a refusal, a render failure, a timeout, a
rollback, and a caller who disconnects. A `401` writes no row — no conversion
code runs.

Retained images share `CONVERSION_STORAGE_DIR` and its `<userId>/<id>.<ext>`
layout, which sits **outside** the `@fastify/static`-served `ASSETS_DIR`.
Nothing in this feature serves them over HTTP at all.

---

## Configuration

Twelve `IMAGE_*` settings, all validated at startup with defaults, so an
administrator retunes them with no code change and no migration. See
[`.env.example`](../../../.env.example).

Peak raster memory is bounded by `IMAGE_MAX_PIXELS × 4 bytes ×
IMAGE_MAX_CONCURRENT` — 16 MP and 2 by default, so ≈128 MiB, plus input and
output buffers bounded by the byte caps. `IMAGE_MAX_CONCURRENT` defaults
*lower* than the text pipeline's because an image's expanded form is far larger
relative to its upload than a parsed document's is.

The two semaphores are separate counters on purpose: sharing one would let a
burst of text conversions starve image conversions of slots.

---

## Adding a fourth format

The worked example. To add WebP:

1. Write `formats/webp.handler.ts` implementing `ImageFormatHandler` with both
   `decode` and `encode`, a `sniff` delegating to a new predicate in
   `formats/image-signatures.ts`, and a `detectionPriority`.
2. Add `WEBP = 'webp'` to `ImageFormat` in
   `@/modules/conversion/conversion.enums`, and `'webp'` to the
   `conversion_format` PostgreSQL enum in a migration.
3. Add `WebpHandler` to `providers` and to the `IMAGE_FORMAT_HANDLERS` factory
   in `image-conversion.module.ts`.
4. Add `IMAGE_MAX_BYTES_WEBP` to the config types, the Joi schema, and the
   limits factory. (Skipping this is safe rather than unbounded: an
   unconfigured format falls back to the *smallest* configured limit.)

**What is not touched**: `PngHandler`, `JpegHandler`, `SvgHandler`, the
controller, the request DTO, the discovery DTO, the registry, the detector, and
the service. Discovery immediately advertises `webp→png`, `webp→jpeg`,
`png→webp`, `jpeg→webp`, and `svg→webp`, and the pipeline immediately accepts
exactly those — because both read the same capability set.

`image-format-registry.service.spec.ts` asserts precisely this with a fake
handler: the direction set widens, and no existing handler is consulted.

---

## Layout

```
image-conversion.controller.ts      the two routes; no conversion logic
image-conversion.service.ts         the pipeline, deadline, semaphore, history
image-conversion.constants.ts       signatures, media types, extension hints
image-format-registry.service.ts    capabilities in, directions out
image-format-detector.service.ts    magic-byte detection over a bounded prefix
formats/
  image-format-handler.ts           the capability contract + DI tokens
  raster-image.ts                   the hub and its construction invariants
  image-signatures.ts               one definition of "this is a PNG"
  sharp-raster.ts                   the decode PNG and JPEG share
  png.handler.ts  jpeg.handler.ts  svg.handler.ts
  svg-security.ts                   reject-only; never rewrites
  svg-intrinsic-size.ts             the deterministic size rule
dto/
```

Test fixtures are generated by `npm run fixtures:images` (also run by
`pretest:e2e`); the SVG corpus is hand-written beside them, because those files
are meant to be read.
