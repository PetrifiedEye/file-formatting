# Contract: `POST /api/convert`, `GET /api/convert/formats`

Field definitions are in [data-model.md](../data-model.md); the
format-to-model mapping is in
[conversion-mapping-rules.md](./conversion-mapping-rules.md); decisions are
in [research.md](../research.md).

Both routes require a valid `access_token` cookie (`JwtAuthGuard`). A
missing, expired, malformed, or revoked token → **401**, with no file read
and no conversion record written (FR-013).

---

## `GET /api/convert/formats`

Lists every conversion direction the service actually accepts. The list is
**derived from the registered format handlers** at request time — it is
never a hand-maintained constant, so a newly registered format appears here
with no further change (FR-030, SC-009).

### Response `200 OK`

```json
{
  "formats": [
    {
      "source": "csv",
      "mediaType": "text/csv",
      "extension": "csv",
      "maxInputBytes": 5242880,
      "targets": ["json", "xml", "yaml"]
    },
    {
      "source": "json",
      "mediaType": "application/json",
      "extension": "json",
      "maxInputBytes": 5242880,
      "targets": ["csv", "xml", "yaml"]
    },
    {
      "source": "xml",
      "mediaType": "application/xml",
      "extension": "xml",
      "maxInputBytes": 5242880,
      "targets": ["csv", "json", "yaml"]
    },
    {
      "source": "yaml",
      "mediaType": "application/yaml",
      "extension": "yaml",
      "maxInputBytes": 5242880,
      "targets": ["csv", "json", "xml"]
    }
  ]
}
```

- `targets` never contains `source` (FR-004).
- `maxInputBytes` is that source format's administrator-configured limit
  (FR-016), so a client can refuse an oversized file before uploading it.
- Order is stable: sources alphabetically, targets alphabetically.

**Invariant (FR-012, SC-010)**: the set of `(source, target)` pairs
advertised here equals exactly the set `POST /api/convert` accepts. Verified
by an automated test that reads this endpoint and drives every advertised
pair through conversion, and asserts every unadvertised pair is refused.

### Errors

| Status | Cause |
|---|---|
| 401 | No valid session |
| 429 | Global rate limit |

---

## `POST /api/convert`

`Content-Type: multipart/form-data`. Rate limited to 10 requests per minute
per client (FR-015).

### Request parts

| Part | Kind | Required | Rules |
|---|---|---|---|
| `file` | file | yes | Exactly one. The document to convert. |
| `targetFormat` | field | yes | One of `csv`, `json`, `xml`, `yaml`. |
| `store` | field | no | `"true"` or `"false"`. Default `"false"` (FR-025). |

Any additional part, a second file part, or a file part under another name
→ **400**.

### Processing order

The order is part of the contract — it is what makes each refusal
distinguishable and what keeps oversized input from being parsed.

1. **Authenticate** (401 before anything is read).
2. **Read parts**, enforcing the multipart ceiling (the largest configured
   per-format limit).
3. **Validate fields**: `targetFormat` present and known (415 if unknown),
   `store` well-formed, no unexpected parts (400).
4. **Reject an absent or zero-byte file** (400).
5. **Detect the source format** from a 64 KiB prefix; content decides, the
   file-name extension is only a CSV/YAML tie-breaker (FR-003). Undetectable
   → **415**.
6. **Apply the detected format's size limit** while consuming the remainder;
   exceeded → **413**, and the rest of the upload is never read (SC-006).
7. **Reject `targetFormat === sourceFormat`** → **400** (`same_format`).
8. **Parse** into the canonical model: malformed input, invalid UTF-8, or a
   `<!DOCTYPE` declaration → **400**.
9. **Guard the structure**: depth, node count → **400**.
10. **Serialize** to the target format, complete, into a buffer.
11. **Retain** the result if `store=true`.
12. **Send** the file. Headers are written only at this point — a failure at
    any earlier step yields a JSON error body, never a partial file (FR-008).

A conversion record is written for every attempt that reaches step 3,
whatever the outcome, from a `finally` block (FR-021, FR-024).

### Response `200 OK`

Body is the converted document. Headers:

| Header | Value |
|---|---|
| `Content-Type` | `text/csv; charset=utf-8`, `application/json; charset=utf-8`, `application/xml; charset=utf-8`, or `application/yaml; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="converted.<ext>"` (FR-007) |
| `X-Conversion-Retention` | `not-requested` \| `stored` \| `failed` (FR-028) |

The attachment name is always `converted` plus the target extension — it is
not derived from the uploaded name.

`X-Conversion-Retention: failed` means **the conversion succeeded and the
file in this response is valid**; only keeping a copy failed. The history
record says the same (`outcome = success`, `retention_outcome = failed`,
`stored_file_id` null). A storage failure never turns a good result into an
error (FR-028).

### Error responses

All errors share one JSON shape:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "...", "code": "parse_error" }
```

`message` never contains any fragment of the uploaded file. Parser messages
from the underlying libraries quote input and are therefore **replaced** by
a fixed code plus, where useful, a line/column (FR-023, SC-005).

| Status | `code` | Cause |
|---|---|---|
| 400 | `missing_file` | No `file` part |
| 400 | `empty_file` | Zero-byte file |
| 400 | `unexpected_part` | Extra, duplicate, or misnamed part |
| 400 | `missing_target_format` | `targetFormat` absent |
| 400 | `same_format` | `targetFormat` equals the detected source format |
| 400 | `invalid_store_flag` | `store` is neither `true` nor `false` |
| 400 | `invalid_encoding` | Input is not valid UTF-8 |
| 400 | `parse_error` | Input is malformed for its detected format |
| 400 | `csv_duplicate_header` | CSV header has empty or repeated field names |
| 400 | `xml_doctype_forbidden` | A `<!DOCTYPE` declaration is present (FR-018) |
| 400 | `xml_name_collision` | Two sibling keys collide after XML-name sanitization |
| 400 | `structure_limit_exceeded` | Depth or node count over the limit |
| 400 | `csv_too_many_columns` | Flattened CSV output exceeds the column limit |
| 400 | `output_too_large` | Produced document exceeds the output ceiling |
| 400 | `timeout` | Conversion exceeded the time budget (FR-019) |
| 401 | `unauthenticated` | No valid session |
| 413 | `input_too_large` | Over the detected source format's limit; `message` names that limit (FR-016) |
| 415 | `unsupported_source_format` | Content matches no supported format |
| 415 | `unsupported_target_format` | `targetFormat` is not a supported format |
| 429 | — | Rate limit exceeded |
| 500 | `internal_error` | Unexpected failure |

**Why `same_format` is 400 and not 415**: both formats are supported; the
*request* is wrong, not the media type.

**Why per-format limits produce different answers for the same size**: a
2 MiB XML file is accepted when `CONVERSION_MAX_BYTES_XML` is 5 MiB even if
`CONVERSION_MAX_BYTES_CSV` is 1 MiB. The limit applied is always the one for
the **detected** source format (FR-016, US5 scenario 3).

### Examples

Convert CSV to JSON and keep the result:

```bash
curl -i -b cookies.txt \
  -F "file=@people.csv" \
  -F "targetFormat=json" \
  -F "store=true" \
  -o converted.json \
  http://localhost:3007/api/convert
```

Discover directions first:

```bash
curl -s -b cookies.txt http://localhost:3007/api/convert/formats
```
