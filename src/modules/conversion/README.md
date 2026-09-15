# Format ↔ Document Model Mapping Rules

Satisfies **FR-009** ("documented, deterministic rules") and **SC-011**
("every documented rule has a test that pins the behaviour").

Every conversion is `read(source) → DocumentNode → write(target)`. There are
no pairwise rules — the twelve directions are the eight mappings below,
composed.

This is the copy that ships with the code; the same text lives in
`specs/010-file-format-conversion/contracts/conversion-mapping-rules.md`. Each
numbered rule below has a test in the neighbouring `*.handler.spec.ts` that
pins it.

## The document model

```ts
type DocumentNode =
  | null | boolean | number | string
  | DocumentNode[]
  | { [key: string]: DocumentNode };
```

The RFC 8259 data model. Object key order is preserved throughout and is
significant for CSV column order and XML element order.

---

## 1. CSV → model (RFC 4180)

1. Input is decoded as UTF-8; a leading BOM is stripped.
2. The **first record is the header**. Its fields must each be non-empty and
   all distinct → otherwise `400 csv_duplicate_header`.
3. Each following record becomes an object mapping header field → field
   value.
4. **All values are strings.** No type inference: `1` stays `"1"`, `true`
   stays `"true"`, an empty field is `""`.
5. **Short record** (fewer fields than the header): the absent columns are
   present with value `""`. They are present, not missing — so the shape of
   every record is identical.
6. **Long record** (more fields than the header): each surplus value is
   added under `_extra_1`, `_extra_2`, … numbered from 1 in column order.
7. The result is an **array of objects**, one per data record.
8. A header-only file yields `[]` — a valid empty document, not an error.

**Why values stay strings**: it makes `CSV → X → CSV` exact (SC-001).
Inferring numbers would silently destroy zip codes (`01234`), version
strings (`1.10`), and long identifiers that exceed float precision. A lossy
round-trip that looks correct is worse than a verbose one that is.

```csv
name,age
Ann,30
Bob
Cid,41,extra
```

```json
[
  { "name": "Ann", "age": "30" },
  { "name": "Bob", "age": "" },
  { "name": "Cid", "age": "41", "_extra_1": "extra" }
]
```

## 2. Model → CSV (RFC 4180)

1. **Row selection** by the shape of the root:
   - array of objects → one row per element;
   - single object → exactly one row;
   - array of scalars → one row each, in a single column named `value`;
   - bare scalar → one row, single column `value`;
   - empty array → header-only output (no data rows).
2. **Flattening**: each row object is flattened to path keys. An object step
   appends `.<key>`; an array step appends `.<index>` (0-based). A literal
   `.` inside a key is escaped as `\.` so paths are unambiguously reversible.
3. **Header**: the union of all flattened paths across all rows, in order of
   first appearance.
4. **Cells**: absent path → empty field. `null` → empty field. Boolean and
   number → their JSON text. String → itself.
5. **Quoting**: a field is quoted when it contains `"`, `,`, CR, or LF;
   embedded `"` is doubled. Records are separated by **CRLF**.
6. If the header would exceed `CONVERSION_MAX_CSV_COLUMNS` →
   `400 csv_too_many_columns`. Refusing is required rather than truncating:
   FR-009 forbids silently dropping data.

```json
[ { "id": 1, "user": { "name": "Ann" }, "tags": ["a", "b"] } ]
```

```csv
id,user.name,tags.0,tags.1
1,Ann,a,b
```

An empty array or empty object contributes no column: CSV has no way to spell
"an empty list lived here". A root that is `[]` or `{}` therefore produces the
empty document — there is nothing to name a header after.

`null` and absent are both the empty field, so `X → CSV` is lossy for that
distinction. This is inherent to CSV, not a choice — it is called out so
nobody expects `CSV → JSON → CSV → JSON` to restore a `null`.

## 3. XML → model

1. A `<!DOCTYPE` declaration anywhere in the prolog →
   `400 xml_doctype_forbidden`. No entity is ever expanded and no external
   reference is ever resolved (FR-018).
2. Comments, processing instructions, and the XML declaration are discarded.
3. The document element becomes the single key of the root object.
4. An element becomes:
   - its **text as a string**, if it has no attributes and no child
     elements;
   - otherwise an **object**: child elements under their names, attributes
     under `@_<name>`, and any non-whitespace text under `#text`.
5. **Repeated sibling elements** of the same name become an **array**, in
   document order. A name appearing once is *not* wrapped in an array.
6. An empty element (`<a/>` or `<a></a>`) becomes `""`.
7. Leaf values stay strings — no type inference, for the reason in §1.

```xml
<order id="7"><item>pen</item><item>ink</item><note>urgent</note></order>
```

```json
{ "order": { "@_id": "7", "item": ["pen", "ink"], "note": "urgent" } }
```

**The single-vs-repeated asymmetry is real and deliberate**: a one-item list
in XML is indistinguishable from a scalar, so `XML → JSON` cannot know it
was a list. Wrapping every element in an array instead would be equally
deterministic but would make the common case unusable. The rule is tested
both ways.

## 4. Model → XML

1. Prolog `<?xml version="1.0" encoding="UTF-8"?>`.
2. **Document element**: if the root is an object with exactly one key and
   that key is a valid XML Name, that key is the document element.
   Otherwise the document element is `<root>`.
3. A root array becomes `<root><item>…</item></root>` — one `<item>` per
   element.
4. Inside an object: a key prefixed `@_` becomes an **attribute** of the
   enclosing element; the key `#text` becomes the element's **text**; every
   other key becomes a **child element**.
5. An array value emits its owning key as a **repeated sibling element**,
   once per item — the inverse of §3.5.
6. Scalars become text (`true`/`false` and JSON number formatting). `null`
   becomes an **empty element**.
7. `&`, `<`, `>` are escaped in text; `&`, `<`, `>`, `"` in attribute values.
8. **Name sanitization**: a key that is not a valid XML Name has each invalid
   character replaced by `_`, and gains a leading `_` if it starts with a
   character that cannot begin a Name. If sanitization makes two sibling keys
   identical → `400 xml_name_collision`.

Rule 8's refusal is the point: `user name` and `user+name` both sanitize to
`user_name`, and writing one over the other would lose a field silently.
FR-009 requires data that cannot be represented to be refused with an
explanation, not dropped.

`-` is **kept**: it is legal in an XML Name after the first character, so
`first-name` stays `first-name`. (The spec's illustration of this rule uses
`user-name`; that particular pair does not actually collide.)

```json
{ "items": [1, 2], "meta": null }
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<root><items>1</items><items>2</items><meta/></root>
```

(The root has two keys, so `<root>` wraps it — rule 2.)

## 5. JSON → model, model → JSON

Identity in both directions; the model *is* the JSON data model (RFC 8259).
Output is UTF-8, two-space indented, with a trailing newline. Duplicate keys
in the input resolve last-wins, as `JSON.parse` does.

## 6. YAML → model, model → YAML

**Read**: parsed under the **YAML 1.2 core schema** with custom tags
disabled and alias expansion capped (`maxAliasCount`). Core scalars map
directly: `null`/`~` → `null`, `true`/`false` → boolean, integers and floats
→ number, everything else → string. Any non-core tag (`!!python/...`,
`!Ref`, …) → `400 parse_error`. Multi-document streams: only the first
document is converted; a second document → `400 parse_error`, because
silently dropping it would lose data.

**YAML 1.2, not 1.1**: `yes`, `no`, `on`, `off` are **strings**, and `0o17`
is octal while `017` is the integer seventeen. This differs from YAML 1.1
tools and is a deliberate consequence of the spec's YAML 1.2 requirement.

**Write**: block style, two-space indent, no anchors or aliases emitted
(so output never re-triggers an alias limit on re-parse), strings quoted
only where required for unambiguous re-parsing.

## 7. Cross-cutting

- **Encoding**: input must be valid UTF-8 (`400 invalid_encoding`); a
  leading BOM is consumed and never appears in output or in the first field
  name. Output is always UTF-8 **without** a BOM.
- **Unicode**: no normalization is applied — combining sequences, emoji, and
  non-Latin text pass through byte-identical (FR-010).
- **Empty but valid**: a header-only CSV, `[]`, `{}`, and an empty YAML
  document all convert successfully to the empty-but-valid equivalent. Only
  a **zero-byte** file is an error.
- **Depth and breadth**: checked on the model, once, by one shared guard —
  the same limits apply whichever format produced it.

## Round-trip guarantees

| Round trip | Guarantee |
|---|---|
| `CSV → JSON → CSV` | Exact, for rectangular input with a valid header. |
| `CSV → YAML → CSV` | Exact, same conditions. |
| `JSON → YAML → JSON` | Exact for core-schema-expressible values. |
| `JSON → XML → JSON` | Types become strings, single-item arrays become scalars. Documented, not a bug. |
| `X → CSV → X` | Lossy wherever CSV cannot carry the shape: `null` vs `""`, numbers vs strings, nesting vs flattened paths. |

SC-001 is measured against the first three rows.


---

## Detection, and what "unsupported" means

The source format is decided by content; the file name is a secondary hint
(FR-003). Handlers are tried in the order each one declares
(`detectionPriority`): XML, JSON, YAML, CSV.

- XML's check is **conclusive** — a leading `<` cannot begin any other
  supported format, so malformed XML is reported as `400 parse_error` rather
  than falling through the scan and coming back as "unsupported".
- Every other format must prove itself by parsing. This is what keeps
  "unsupported" and "malformed" apart.
- When **nothing** parses, the answer depends on whether the file name claimed
  anything. If it named a format and that format's own parser is the one that
  rejected the document, the refusal is that parser's — `400 parse_error` for a
  truncated `data.json`, and likewise for a `.yaml` file whose aliases blow the
  expansion cap. If the name claimed nothing (or named a format that never even
  sniffed), the answer is `415 unsupported_source_format`: we genuinely could
  not tell what it was. This only decides what is *reported*; it never changes
  a detection that succeeded.
- The file name only ever **widens** what a handler will consider, never
  narrows it, and never reorders the scan. A `.csv` file holding JSON is
  detected as JSON. Its job is the genuinely undecidable cases: `a,b` is both
  a legal YAML scalar and a legal one-column CSV header, and a CSV whose
  header has no delimiter at all is indistinguishable from a line of prose —
  so a single-column CSV is recognised only when the name says `.csv`.

## Size limits, and what "without reading the whole file" means

The input ceiling is **per source format**, and the format is not knowable
until some bytes exist. So the upload is consumed in two stages: a bounded
64 KiB prefix names the plausible formats, the most permissive of those bounds
the rest of the read, and the detected format's own limit is applied once it is
known. The stream is destroyed the moment a budget is passed, so an oversized
upload is refused without being read to the end.

The honest consequence: **a file smaller than the 64 KiB prefix is read in
full** before any per-format budget can apply. For a 5 MiB or 100 MiB upload —
the case the limit exists for — the read stops near the budget. For a 20 KiB
file over a 16 KiB limit, all 20 KiB were already in hand. The bound is 64 KiB
plus the applicable limit, never the file.

`conversion_records.input_size_bytes` records what was actually read, which is
why a 413's row shows the point at which the budget was exceeded rather than
the size of the file the caller tried to send.

## Adding a fifth format (SC-009)

Adding TOML is one new file and one provider entry. Nothing below is edited:
no existing handler, `conversion.controller.ts`, any DTO, or the discovery
endpoint — and the eight new directions appear in `GET /api/convert/formats`
on their own, because that list is derived from the registry rather than
written down (FR-029, FR-030).

1. Add the value to `ConversionFormat` in `conversion.enums.ts`, and its media
   type and extension to `conversion.constants.ts`. (Persistence needs the
   enum value; a migration adds it to the `conversion_format` Postgres type.)

2. Write `formats/toml.handler.ts`:

   ```ts
   @Injectable()
   export class TomlHandler implements FormatHandler {
     readonly format = ConversionFormat.TOML;
     readonly mediaType = FORMAT_MEDIA_TYPES[ConversionFormat.TOML];
     readonly extension = FORMAT_EXTENSIONS[ConversionFormat.TOML];
     readonly detectionPriority = 35; // between YAML and CSV
     readonly sniffIsConclusive = false;

     sniff(prefix: string, namedByFileName: boolean): boolean { /* … */ }

     async read(input: string): Promise<DocumentNode> { /* … */ }

     async write(node: DocumentNode): Promise<Buffer> { /* … */ }
   }
   ```

3. Add it to `conversion.module.ts` — as a provider, and in the
   `FORMAT_HANDLERS` factory's `inject` list.

4. Add `CONVERSION_MAX_BYTES_TOML` to the config surface. Until it exists the
   registry falls back to the smallest configured limit, so the new format is
   conservative rather than unbounded.

5. Write `formats/toml.handler.spec.ts` with one test per mapping rule, and
   add a fixture. The existing e2e check that drives every advertised
   direction (SC-010) picks the new ones up with no change.

## Invariants worth not breaking

- **No file content leaves the module.** `csv-parse`, `yaml`, `JSON.parse`,
  and `fast-xml-parser` all quote the offending input in their messages. Every
  handler maps those onto a fixed `ConversionErrorCode` plus, at most, a line
  and column. `ConversionException` accepts no caller-supplied text at all —
  only numbers and two fixed literals — so this is enforced by the type, not
  by review (FR-023, SC-005).
- **The result is buffered completely before any header is written.** A
  failure therefore yields a JSON error body, never a truncated file (FR-008).
- **Limits arrive by injection.** A handler never reads `ConfigService`, so it
  is testable against arbitrary limits and cannot invent a ceiling of its own.
