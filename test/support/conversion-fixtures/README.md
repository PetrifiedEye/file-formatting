# Conversion fixtures

Inputs for `test/file-conversion.e2e-spec.ts`. Each file exists to pin one
documented behaviour; nothing here is a generic sample.

## Equivalent-content set

These four carry the **same data** in four formats, so every one of the twelve
directions can be checked against a known-good expectation and the round trips
of SC-001 have something to compare to.

| File | Purpose |
|---|---|
| `sample.csv` | Rectangular CSV: header plus two data records |
| `sample.json` | The same records as an array of objects |
| `sample.xml` | The same records as repeated sibling elements |
| `sample.yaml` | The same records as a block sequence of mappings |

## Encoding and edge shapes

| File | Purpose |
|---|---|
| `bom.csv` | Leading UTF-8 BOM — consumed, never part of the first field name |
| `unicode.csv` | Combining sequences, emoji, and non-Latin text pass through unchanged (FR-010) |
| `header-only.csv` | Header with no data records → `[]`, a success not an error |
| `empty-array.json` | `[]` → header-only CSV, a success not an error |
| `ragged.csv` | Short and long records — the `""` fill and `_extra_N` rules |

## Refusals

| File | Purpose |
|---|---|
| `empty.csv` | Zero bytes → `400 empty_file` (the one empty input that is an error) |
| `invalid-utf8.csv` | Invalid UTF-8 → `400 invalid_encoding` |
| `blob.png` | Valid UTF-8 text matching no supported format → `415 unsupported_source_format`. A *genuinely* binary file never reaches format detection: it is refused earlier as invalid UTF-8, which is why this one is deliberately decodable. |
| `xxe.xml` | `<!DOCTYPE` with an entity declaration → `400 xml_doctype_forbidden`, and no outbound request (SC-007) |
| `deep.json` | 200 nesting levels → `400 structure_limit_exceeded` |
| `alias-bomb.yaml` | Anchor/alias expansion → refused promptly by `maxAliasCount` |
| `oversized.csv` | Larger than a deliberately small configured CSV limit → `413`. Also **larger than the 64 KiB detection prefix**, which is what makes it a real SC-006 check: a smaller file would be read in full before any per-format budget could apply, so the recorded input size could never be less than the file. |
