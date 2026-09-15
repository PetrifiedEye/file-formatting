# Phase 0 Research: File Format Conversion

All Technical Context items are resolved against the current `dev` codebase.
No `NEEDS CLARIFICATION` markers remain.

## 1. Module placement and route paths

**Decision**: A new feature module `src/modules/conversion/` with
`ConversionController` mounted at `@Controller('api/convert')`, exposing
`POST /api/convert` and `GET /api/convert/formats`.

**Rationale**: The source description names both paths explicitly. The
application registers **no** global prefix in `src/main.ts`
(`setGlobalPrefix` is absent), so the `api/` segment must be part of the
controller path to produce the stated URLs. Conversion is a distinct domain
with its own entities, services, and storage — a module of its own, per
Constitution I, not an addition to `UsersModule`.

**Alternatives considered**: `@Controller('convert')` plus
`app.setGlobalPrefix('api')` was rejected — it would silently relocate every
existing route (`/auth/*`, `/users/*`, `/rbac/*`, `/health`) and break the
e2e suites and any deployed client. If a global `api` prefix is adopted
later as a deliberate migration, this controller path collapses to
`convert`; that is the only coupling.

## 2. Extensibility: canonical intermediate representation + handler registry

**Decision**: Every format is handled by one `FormatHandler` that reads its
wire form into a **canonical document model** and writes that model back
out. Conversion is always `read(source) → DocumentNode → write(target)`.
Handlers are registered as a DI multi-provider under a `FORMAT_HANDLERS`
token and collected by `FormatRegistryService`, which derives the supported
directions as *every ordered pair of distinct registered formats*.

```ts
type DocumentNode =
  | null | boolean | number | string
  | DocumentNode[]
  | { [key: string]: DocumentNode };

interface FormatHandler {
  readonly format: ConversionFormat;      // 'csv' | 'json' | 'xml' | 'yaml'
  readonly mediaType: string;
  readonly extension: string;
  sniff(prefix: Buffer, extensionHint?: string): boolean;
  read(input: Buffer, limits: ConversionLimits): DocumentNode;
  write(node: DocumentNode, limits: ConversionLimits): Buffer;
}
```

**Rationale**: This is what makes FR-029 / FR-030 / SC-009 true rather than
aspirational. With a hub model, N formats yield N×(N−1) directions from N
handlers — 4 handlers give the required 12. Adding a 5th format (say TOML)
is one new file plus one provider entry: no existing handler, no controller,
no DTO, and no discovery code changes, and the 8 new directions appear in
`GET /api/convert/formats` automatically because the list is derived, never
written down.

**Model choice**: the node type is deliberately the RFC 8259 JSON data
model. JSON is exact, YAML 1.2's core schema is a superset that maps onto it
losslessly for core-schema documents, and CSV and XML map onto it through
the documented rules in §9. A richer model (ordered maps, typed scalars,
XML namespaces) was rejected: it would buy fidelity only for XML↔XML, which
is not a supported direction.

**Alternatives considered**: (a) Twelve pairwise converter classes —
rejected, it is 12 implementations now and 20 after one new format, and
FR-029 forbids touching existing ones. (b) A `ConverterStrategy` keyed by
`(source, target)` with a lookup map — same combinatorial problem, and
directions would have to be enumerated by hand, breaking FR-030.

## 3. Parsing and serialization libraries

Four new runtime dependencies. None of them is currently a direct
dependency (`js-yaml@4.3.2` is present only transitively via tooling and is
deliberately **not** used — see below).

| Format | Library | Why |
|---|---|---|
| CSV | `csv-parse` + `csv-stringify` | RFC 4180 compliant, streaming (incremental, yields to the event loop), battle-tested, no dependencies beyond Node. |
| JSON | native `JSON.parse` / `JSON.stringify` | RFC 8259 by definition. No library can be more correct; a third-party parser would only add risk. |
| XML | `fast-xml-parser` | Pure JS, **never resolves external entities and performs no network I/O** (see §6), configurable attribute/text handling that matches the mapping rules in §9. |
| YAML | `yaml` (v2, "eemeli/yaml") | Targets **YAML 1.2** and exposes `maxAliasCount`, the direct defence against billion-laughs alias expansion. |

**YAML library — `yaml` over `js-yaml`**: the spec requires YAML 1.2
conformance (FR/NFR) and bounded expansion (FR-017). `js-yaml` implements
YAML 1.1 semantics with partial 1.2 support and offers **no** alias-count
limit, so a 200-byte anchor bomb expands unbounded inside a synchronous call
that cannot be interrupted by our timeout. `yaml` v2 is 1.2-first and caps
alias expansion by construction. The version difference is user-visible
(`yes`/`no` are booleans in 1.1, plain strings in 1.2), so this is a
correctness decision, not only a safety one.

**Alternatives considered**: `xml2js` (callback-based, slower, DTD handling
less explicit), `libxmljs` (native build, XXE surface is exactly what we are
avoiding), `papaparse` (browser-oriented, weaker RFC 4180 edge-case
behaviour on embedded CRLF in quoted fields).

## 4. Upload handling and per-format size limits

**Decision**: Keep the global `@fastify/multipart` registration in
`main.ts` as-is (`fileSize: PHOTO_MAX_SIZE_BYTES`, `files: 1`) and have the
conversion handler request **its own limits** for this request:

```ts
const part = await request.file({
  limits: { fileSize: registry.maxConfiguredInputBytes(), files: 1 },
});
```

Then enforce the *detected* format's limit while the stream is consumed:

1. Read up to `DETECTION_PREFIX_BYTES` (64 KiB) into a buffer.
2. Detect the source format from that prefix (§5).
3. Set the byte budget to that format's configured limit.
4. Keep consuming; the moment consumed bytes exceed the budget, destroy the
   stream and throw `PayloadTooLargeException` naming the applicable limit.

**Rationale**: `@fastify/multipart` limits are per-registration *and*
overridable per call, so the route does not need a second global
registration and cannot loosen the photo route. FR-016 requires a limit that
differs *per source format*, which is only knowable after detection — hence
the two-stage budget: the multipart ceiling (max across formats) stops the
absurd cases early, the per-format budget stops the rest. SC-006 ("refused
without reading the whole file") holds because the stream is destroyed at
budget+1 byte, not after buffering the upload.

**Config**: limits live in environment configuration, validated by Joi in
`ConfigModule` at startup, matching the spec assumption that they ship with
defaults and are administrator-overridable without code changes:

| Variable | Default | Meaning |
|---|---|---|
| `CONVERSION_MAX_BYTES_CSV` | `5242880` | Max accepted CSV input |
| `CONVERSION_MAX_BYTES_JSON` | `5242880` | Max accepted JSON input |
| `CONVERSION_MAX_BYTES_XML` | `5242880` | Max accepted XML input |
| `CONVERSION_MAX_BYTES_YAML` | `5242880` | Max accepted YAML input |
| `CONVERSION_MAX_OUTPUT_BYTES` | `20971520` | Ceiling on the produced document |
| `CONVERSION_MAX_DEPTH` | `64` | Max structural nesting depth |
| `CONVERSION_MAX_NODES` | `200000` | Max total nodes in the parsed document |
| `CONVERSION_MAX_CSV_COLUMNS` | `1024` | Max columns a CSV output may have |
| `CONVERSION_TIMEOUT_MS` | `10000` | Per-conversion time budget |
| `CONVERSION_STORAGE_DIR` | `./storage/conversions` | Retained-result root (§8) |

**Alternatives considered**: storing the limits in the `system_settings`
table alongside the confirmation policy, mutable through an admin endpoint.
Rejected for this feature — the spec's Assumptions place the limits in
application configuration, and no functional requirement asks for a
runtime-editable limits API. The registry reads limits through
`ConfigService`, so promoting them to `system_settings` later is a change
inside one provider.

## 5. Source-format detection (FR-003)

**Decision**: Content decides; the file-name extension is only a tie-breaker
between YAML and CSV. Applied to a decoded prefix, in this fixed order:

1. Reject if the bytes are not valid UTF-8 → **400** (`invalid_encoding`).
   A leading UTF-8 BOM is stripped first and never reaches a handler.
2. Reject if the file is zero bytes → **400** (`empty_file`).
3. **XML** if the first non-whitespace character is `<`.
4. **JSON** if the first non-whitespace character is `{` or `[` *and* the
   document parses as JSON.
5. **YAML** if the prefix shows a block-mapping key (`^\s*[^\s#].*?:(\s|$)`),
   a block-sequence entry (`^\s*-\s`), or a document marker (`---`) *and*
   the document parses under the YAML 1.2 core schema.
6. **CSV** if the first record parses as a header row of one or more
   non-empty, unique fields and the remaining records parse.
7. Otherwise → **415** (`unsupported_source_format`).

**Extension tie-breaker**: if the file name's extension is `.csv`,
`.yaml`/`.yml`, `.json`, or `.xml`, that format's check runs first; if it
fails to parse, the ordered scan above runs unchanged. This satisfies
FR-003 (content decides, extension is secondary) while giving a
deterministic answer for input that is legal as both CSV and YAML — e.g.
`a,b` alone is a valid YAML scalar and a valid single-column CSV header.

**Rationale**: a fixed, documented order is what makes "unsupported" and
"malformed" distinguishable and testable. Detection reads a bounded prefix
only for the cheap structural checks; the confirming parse for steps 4–6
runs against the fully received (and already size-capped) input, so no
format is accepted on a prefix that the full document contradicts.

## 6. XML safety — external entities and expansion (FR-018, SC-007)

**Decision**: Three independent layers.

1. **Reject DOCTYPE outright.** If the prolog (up to the document element)
   contains `<!DOCTYPE`, the request is refused with **400**
   (`xml_doctype_forbidden`). No entity declaration of any kind — external,
   parameter, or internal — can exist without it.
2. **`processEntities: false`** on `fast-xml-parser`, so even a declared
   internal entity is never expanded.
3. **No network client is constructed anywhere in this module**, so there is
   no code path that could fetch a `SYSTEM`/`PUBLIC` identifier. SC-007's
   "no outbound request" is structurally true, not merely configured.

**Rationale**: `fast-xml-parser` does not implement DTD resolution at all,
so XXE is already absent; layers 1 and 3 turn that from an implementation
detail of a dependency into an invariant this codebase owns and tests. The
explicit DOCTYPE refusal is also what makes the behaviour *observable* —
the e2e test asserts a 400 with a named reason rather than asserting the
absence of a network call.

## 7. Structural limits, timeout, and atomicity

**Depth and node count (FR-017)**: enforced on the canonical model by a
single `guardStructure(node, limits)` walk shared by all handlers, not
re-implemented per format. Exceeding either → **400**
(`structure_limit_exceeded`). Breadth is bounded by the node count; CSV
output width additionally by `CONVERSION_MAX_CSV_COLUMNS`.

**Timeout (FR-019, SC-003)**: a deadline is taken when the upload completes
and is checked at every `await` boundary of the pipeline and inside the
streaming CSV parser's chunk callbacks; the `AbortSignal` is passed to
`csv-parse`. On expiry → **400** with `errorCategory = timeout`, recorded in
history.

**Known limit, stated plainly**: a single synchronous `JSON.parse` or
`yaml.parse` call cannot be interrupted once entered. For those two formats
the real bound on worst-case time is the per-format **byte cap** (§4) and
`maxAliasCount`, not the timer; the timer catches everything around them.
This is why the byte caps default low (5 MiB) and why SC-003 allows five
seconds of slack past the budget. If measurement shows a 5 MiB pathological
JSON document blowing the budget, the fix is the worker pool in §11, not a
larger timer.

**Atomicity (FR-008, "failure mid-stream")**: the target document is
serialized **completely into a buffer** before any response header is set.
Only then are `Content-Type` and `Content-Disposition` written and the
buffer sent. A failure at any point before that produces a JSON error body
with the normal status code; there is no state in which a partial file has
been sent. The buffer is capped by `CONVERSION_MAX_OUTPUT_BYTES`.

**Rationale**: "потоковая обработка" and "атомарность ответа" pull in
opposite directions, and atomicity is the one stated as a hard requirement
with a dedicated edge case. Streaming the *output* would mean committing to
`200 OK` before knowing the conversion succeeds. Streaming survives where it
costs nothing: the upload is consumed and size-checked incrementally
(never fully buffered before rejection), and CSV parsing is incremental.

## 8. Optional retention — and why not `ASSETS_DIR`

**Decision**: Retained results are written under a **new**
`CONVERSION_STORAGE_DIR` (default `./storage/conversions`), at
`<userId>/<uuid>.<ext>`, by a new `ConversionFileStorageService` in
`src/core/storage/`. They are **not** written under `ASSETS_DIR`.

**Rationale — this is a security decision, not a tidiness one**: `main.ts`
registers `@fastify/static` with `root: ASSETS_DIR, prefix: '/assets/'`, and
that route has **no authentication**. Anything placed under `ASSETS_DIR` is
world-readable to anyone who can guess or obtain the path. FR-027 requires
retained files to stay private to their owner, so they must live outside
the statically served tree. No route in this feature serves retained files
at all — reading them back is explicitly out of scope — so the directory has
no HTTP exposure whatsoever.

`LocalFileStorageService` is left untouched (it hard-codes the `photos`
subdirectory and the assets root); the new service is a sibling in
`StorageModule`, keeping storage infrastructure in `src/core/` per
Constitution I.

**Storage failure reporting (FR-028)**: a successful conversion whose
retention write fails still returns **200** with the converted file — the
conversion did succeed and withholding the result would be a worse lie. The
distinction is carried by a response header and by history:

| Situation | Header `X-Conversion-Retention` | `retentionOutcome` | `storedFileId` |
|---|---|---|---|
| Retention not requested | `not-requested` | `not_requested` | `null` |
| Requested and stored | `stored` | `stored` | set |
| Requested, store failed | `failed` | `failed` | `null` |

**Alternatives considered**: returning 500 on a storage failure (rejected —
discards a valid result the user paid for); switching the response to a JSON
envelope carrying both the file and a status (rejected — FR-007 requires a
downloadable attachment). A response header is the only channel that
coexists with a binary body.

## 9. Documented mapping rules for ambiguous directions (FR-009)

The full rules, with worked examples, are in
[contracts/conversion-mapping-rules.md](./contracts/conversion-mapping-rules.md)
and are mirrored into `src/modules/conversion/README.md` (linked from the
root `README.md`) so FR-009's "recorded in project documentation" is
satisfied inside the repository, not only in the spec folder.

Summary of the choices:

- **CSV → model**: first record is the header; fields must be non-empty and
  unique (duplicates → 400). Each data record becomes an object of
  `header → string`. **All values stay strings — no type inference.** Short
  rows: absent columns present as `""`. Long rows: surplus values under
  `_extra_1`, `_extra_2`, … The result is an array of objects.
- **Model → CSV**: array of objects → one row each; single object → one row;
  array of scalars or a bare scalar → one column named `value`. Nested
  values are flattened to path keys (`a.b`, `a.0.b`); a literal `.` in a key
  is escaped `\.`. The header is the union of flattened paths in
  first-appearance order. Absent path or `null` → empty field. Output uses
  CRLF record separators per RFC 4180.
- **XML → model**: attributes under `@_name`; text under `#text` when the
  element also has attributes or children, otherwise the element collapses
  to its string value; repeated sibling names become arrays; empty element →
  `""`; comments and processing instructions are discarded; leaf values stay
  strings.
- **Model → XML**: `<?xml version="1.0" encoding="UTF-8"?>` prolog. A root
  object with exactly one valid-XML-Name key uses that key as the document
  element; otherwise the document element is `<root>`. A root array becomes
  `<root><item>…</item></root>`. `@_`-prefixed keys become attributes,
  `#text` becomes text, `null` becomes an empty element. Key names that are
  not valid XML Names are sanitized (invalid characters → `_`, a leading
  invalid character gains a `_` prefix); **if sanitizing makes two sibling
  keys collide, the request is refused with 400** (`xml_name_collision`)
  rather than silently dropping data.

**The one deliberate consequence**: because CSV values stay strings,
`CSV → JSON → CSV` round-trips exactly, which is what SC-001 measures. The
price is that `1,2` from a CSV becomes `"1","2"` in JSON. Inferring numbers
would make the round-trip lossy for zip codes, leading zeros, and version
strings — a worse failure, and a silent one.

## 10. History and audit (FR-021 – FR-024, FR-031, SC-004, SC-005)

**Decision**: One row in `conversion_records` per authenticated attempt,
written by `ConversionHistoryService` **outside** any transaction that the
conversion itself uses, from a `finally` block, so the record survives every
failure path including client disconnect.

**Scope boundary**: unauthenticated callers (401) produce no conversion
record — they have no user to attribute it to, and FR-013 requires rejection
before any file is processed. Those attempts are already recorded by the
existing `JwtAuthGuard` → `LoginAuditService` `ACCESS_CHECK_FAILED` path.
This is the only class of "attempt" absent from conversion history, and
SC-004 ("attributed to the correct user") is unaffected by it.

**No file content, anywhere (FR-023, SC-005)**: the entity has no column
capable of holding content. Logs emit only `userId`, `sourceFormat`,
`targetFormat`, `inputSizeBytes`, `outcome`, `errorCode`, `durationMs`.
Parser error messages from `csv-parse`, `yaml`, and `JSON.parse` routinely
quote the offending input fragment, so **library messages are never
propagated into `failureReason` or the HTTP body** — each handler maps them
to a fixed error code plus a location (line/column) only. This is the single
easiest way to leak content and is handled at the mapping boundary.

**Client disconnect (FR-024)**: the pipeline is not aborted on
`request.raw.aborted`; the conversion finishes, history is written, and the
send simply fails. Bounded by the timeout and the size caps, so an
abandoned request cannot accumulate work.

## 11. Concurrency (SC-008)

**Decision**: rely on the byte caps and the incremental CSV parser for
now; do not introduce worker threads in this feature. Add
`CONVERSION_MAX_CONCURRENT` (default 4) as a semaphore around the pipeline
to bound peak memory (four 5 MiB inputs plus their models), with waiters
subject to the same deadline.

**Honest framing**: the semaphore bounds **memory, not latency**. Node
executes one synchronous parse at a time regardless, so a long
`JSON.parse` blocks unrelated requests whether or not a semaphore is in
place. The lever that actually protects SC-008's "no unrelated request
delayed by more than one second" is keeping any single synchronous parse
short — which the 5 MiB caps do for realistic documents.

**Contingency, stated now so it is not rediscovered later**: if the SC-008
measurement fails, move `read` + `write` into a `worker_threads` pool behind
the same `FormatHandler` interface. The hub architecture in §2 makes that a
change to the execution site, not to any handler. It is deliberately not
done up front: it adds a serialization boundary and a pool lifecycle for a
problem not yet demonstrated to exist.

## 12. Request validation for a multipart body

**Decision**: the global `ValidationPipe` does not see multipart fields, so
the handler iterates `request.parts()` (the pattern already used by
`UsersController.updateProfile`), collects `file`, `targetFormat`, and the
optional `store`, then validates the non-file fields explicitly via
`plainToInstance(ConvertRequestDto, …)` + `validate(...)`.

Rules enforced: exactly one file part named `file`; `targetFormat` present
and one of the registered formats; `store` absent or `"true"`/`"false"`
(default `false`); any unrecognized part → 400. `targetFormat` equal to the
detected source format → 400 (`same_format`), per FR-004 — note this is a
*bad request*, not a 415, because the format itself is supported.

`@ApiConsumes('multipart/form-data')` plus an `@ApiBody` schema keeps
Swagger accurate (Constitution V).

## 13. Rate limiting and status codes

`@Throttle({ default: { limit: 10, ttl: 60000 } })` on `POST /api/convert`
(Constitution II; FR-015). The global `ThrottlerGuard` stays in place for
`GET /api/convert/formats`.

| Status | When |
|---|---|
| **200** | Conversion succeeded; body is the converted file |
| **400** | Missing/empty file, bad or same `targetFormat`, malformed input, non-UTF-8, DOCTYPE, depth/node/column limit, timeout |
| **401** | No valid `access_token` cookie |
| **413** | Input exceeds the detected source format's configured limit |
| **415** | Source format could not be determined, or `targetFormat` is not a supported format |
| **429** | Rate limit exceeded |

## 14. Testing approach

Unit (`*.spec.ts`, colocated): each handler's read/write against the §9
rules; the structure guard; the detector's ordering and tie-breaker; the
registry's derived direction list; history writing on success and on each
failure category; the size-budget stream consumer.

E2E (`test/file-conversion.e2e-spec.ts`): all twelve directions on
well-formed fixtures; the round-trip equivalence of SC-001; 400/401/413/415/429
paths; the DOCTYPE refusal; retention on and off; a storage-failure
simulation; and an automated check that `GET /api/convert/formats` matches
exactly the set of directions `POST /api/convert` accepts (SC-010).

Fixtures live in `test/support/conversion-fixtures/` and include a BOM file,
a Unicode/emoji file, a header-only CSV, an empty JSON array, a ragged CSV,
and a deeply nested document.
