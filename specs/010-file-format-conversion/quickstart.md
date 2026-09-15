# Quickstart: File Format Conversion

Validates the feature end-to-end against a running local backend and
Postgres. The HTTP contract is in
[contracts/conversion-api.md](./contracts/conversion-api.md); the mapping
rules being checked are in
[contracts/conversion-mapping-rules.md](./contracts/conversion-mapping-rules.md).

## Prerequisites

1. Migrations applied (adds `conversion_records`, `conversion_stored_files`,
   and their enums) and the app running:

   ```bash
   npm run migration:run
   npm run start:dev
   ```

2. `.env` carries the conversion settings (defaults are fine; the small CSV
   limit below is what makes the per-format limit test meaningful):

   ```bash
   CONVERSION_MAX_BYTES_CSV=1048576
   CONVERSION_MAX_BYTES_JSON=5242880
   CONVERSION_MAX_BYTES_XML=5242880
   CONVERSION_MAX_BYTES_YAML=5242880
   CONVERSION_MAX_DEPTH=64
   CONVERSION_MAX_NODES=200000
   CONVERSION_TIMEOUT_MS=10000
   CONVERSION_STORAGE_DIR=./storage/conversions
   ```

3. A signed-in user. Log in via `POST /auth/login` and save the cookie jar
   as `cookies.txt`.

4. Fixtures in the working directory:

   ```bash
   printf 'name,age\nAnn,30\nBob,41\n' > people.csv
   printf '\xEF\xBB\xBFname,city\nAnn,Wrocław\n' > bom.csv
   printf '[{"name":"Ann","tags":["a","b"]}]' > nested.json
   printf '<!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/passwd">]><t>&x;</t>' > xxe.xml
   printf '' > empty.csv
   ```

Replace `3007` with your `PORT` throughout.

## Scenario 1 — Discovery (Story 2)

```bash
curl -s -b cookies.txt http://localhost:3007/api/convert/formats
```

**Expect**: `200`, four entries (`csv`, `json`, `xml`, `yaml`), each with
three `targets` that exclude its own `source`, plus `mediaType`,
`extension`, and `maxInputBytes`. `csv` reports `1048576`, matching the
`.env` above — confirming the advertised limit is the configured one.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3007/api/convert/formats
```

**Expect**: `401` with no cookie.

## Scenario 2 — All twelve directions (Story 1)

```bash
for src in csv json xml yaml; do
  for tgt in csv json xml yaml; do
    [ "$src" = "$tgt" ] && continue
    code=$(curl -s -o "out.$src.$tgt" -w '%{http_code}' -b cookies.txt \
      -F "file=@sample.$src" -F "targetFormat=$tgt" \
      http://localhost:3007/api/convert)
    echo "$src -> $tgt : $code"
  done
done
```

**Expect**: twelve lines, all `200`, twelve non-empty output files each
parsing as its target format. Prepare `sample.csv`, `sample.json`,
`sample.xml`, `sample.yaml` carrying the same data first — the point of the
loop is that the same content survives every hop. (Copies of all four live in
`test/support/conversion-fixtures/`.)

> **Mind the rate limit.** `POST /api/convert` allows ten requests per minute
> (FR-015), so a straight run of this loop returns `200` ten times and then
> `429` twice. That is the feature working, not a failure. Either add
> `sleep 61` before the last two directions, or raise
> `THROTTLE_GLOBAL_LIMIT`-style headroom for the walkthrough by temporarily
> relaxing the `@Throttle` on the route. The same caveat applies to
> Scenarios 5 and 9, which issue six and two conversions respectively —
> pause a minute between scenarios.

Check the response envelope on one of them:

```bash
curl -i -s -b cookies.txt -F "file=@people.csv" -F "targetFormat=json" \
  http://localhost:3007/api/convert | head -20
```

**Expect**: `Content-Type: application/json; charset=utf-8`,
`Content-Disposition: attachment; filename="converted.json"`,
`X-Conversion-Retention: not-requested`.

## Scenario 3 — Round-trip equivalence (SC-001)

```bash
curl -s -b cookies.txt -F "file=@people.csv" -F "targetFormat=json" \
  http://localhost:3007/api/convert -o rt.json
curl -s -b cookies.txt -F "file=@rt.json" -F "targetFormat=csv" \
  http://localhost:3007/api/convert -o rt.csv
diff <(tr -d '\r' < people.csv) <(tr -d '\r' < rt.csv) && echo "round-trip exact"
```

**Expect**: `round-trip exact`. Values are strings in `rt.json`
(`"age": "30"`, not `30`) — that is the documented rule, and it is what
makes this diff clean.

## Scenario 4 — Unicode and BOM

```bash
curl -s -b cookies.txt -F "file=@bom.csv" -F "targetFormat=json" \
  http://localhost:3007/api/convert
```

**Expect**: `200` and `[{"name":"Ann","city":"Wrocław"}]`. The first key is
`name`, **not** `﻿name` — the BOM was consumed, and the non-Latin
character survived unchanged.

## Scenario 5 — Refusals (Story 5)

```bash
# No session
curl -s -o /dev/null -w '401? %{http_code}\n' \
  -F "file=@people.csv" -F "targetFormat=json" http://localhost:3007/api/convert

# Zero-byte file
curl -s -w '\n400? %{http_code}\n' -b cookies.txt \
  -F "file=@empty.csv" -F "targetFormat=json" http://localhost:3007/api/convert

# Same source and target
curl -s -w '\n400? %{http_code}\n' -b cookies.txt \
  -F "file=@people.csv" -F "targetFormat=csv" http://localhost:3007/api/convert

# Unknown target
curl -s -w '\n415? %{http_code}\n' -b cookies.txt \
  -F "file=@people.csv" -F "targetFormat=toml" http://localhost:3007/api/convert

# Unsupported source content
printf '\x89PNG\r\n\x1a\n' > blob.png
curl -s -w '\n415? %{http_code}\n' -b cookies.txt \
  -F "file=@blob.png" -F "targetFormat=json" http://localhost:3007/api/convert

# Oversized for CSV's 1 MiB limit
head -c 2000000 /dev/urandom | base64 | awk 'BEGIN{print "a,b"}{print $0",x"}' > big.csv
curl -s -w '\n413? %{http_code}\n' -b cookies.txt \
  -F "file=@big.csv" -F "targetFormat=json" http://localhost:3007/api/convert
```

**Expect**: `401`, `400`, `400`, `415`, `415`, `413` in that order. The
`413` body names the CSV limit. Then confirm the limit is **per format** —
the same byte count as JSON is accepted:

```bash
python3 -c "import json;print(json.dumps([{'a':'x'*1500000}]))" > big.json
curl -s -o /dev/null -w '200? %{http_code}\n' -b cookies.txt \
  -F "file=@big.json" -F "targetFormat=yaml" http://localhost:3007/api/convert
```

**Expect**: `200` — 1.5 MB is over CSV's limit but within JSON's (US5
scenario 3).

## Scenario 6 — XML external entities (SC-007)

```bash
curl -s -b cookies.txt -F "file=@xxe.xml" -F "targetFormat=json" \
  http://localhost:3007/api/convert
```

**Expect**: `400` with `"code": "xml_doctype_forbidden"`. The response must
contain **no** part of `/etc/passwd`. Confirm nothing was fetched — the
module constructs no HTTP client, so there is no outbound request to see.

## Scenario 7 — History (Story 3)

Run one success and one failure, then inspect the table (Adminer at
http://localhost:8081, or `psql`):

```sql
SELECT user_id, original_file_name, source_format, target_format,
       input_size_bytes, outcome, error_category, failure_reason,
       started_at, duration_ms
FROM conversion_records
ORDER BY started_at DESC
LIMIT 5;
```

**Expect**: one row per attempt, both attributed to your user id. The
success row has `outcome = success`, both formats set, and a non-null
`duration_ms`. The failure row has `outcome = failure` and a populated
`error_category`. **No column holds file content**, and `failure_reason` is
a code — not a parser message quoting your data (SC-005).

Check the log lines for the same two requests: they carry user id, formats,
size, outcome, and duration, and no file content (FR-031).

## Scenario 8 — Optional retention (Story 4)

```bash
curl -i -s -b cookies.txt -F "file=@people.csv" -F "targetFormat=json" \
  -F "store=true" http://localhost:3007/api/convert | grep -i retention
```

**Expect**: `X-Conversion-Retention: stored`. Then:

```sql
SELECT f.storage_path, f.format, f.size_bytes, r.retention_outcome
FROM conversion_stored_files f
JOIN conversion_records r ON r.stored_file_id = f.id
ORDER BY f.created_at DESC LIMIT 1;
```

```bash
ls -R ./storage/conversions
```

**Expect**: one row, `retention_outcome = stored`, and the file present on
disk under `<userId>/<uuid>.json`.

**The privacy check that matters** — the file must not be reachable over
HTTP:

```bash
curl -s -o /dev/null -w '404? %{http_code}\n' \
  "http://localhost:3007/assets/conversions/$(ls ./storage/conversions)/"
```

**Expect**: `404`. Retained results live outside `ASSETS_DIR`, which
`@fastify/static` serves without authentication (FR-027).

Now the same conversion without `store`:

```bash
curl -i -s -b cookies.txt -F "file=@people.csv" -F "targetFormat=json" \
  http://localhost:3007/api/convert | grep -i retention
```

**Expect**: `X-Conversion-Retention: not-requested`, no new row in
`conversion_stored_files`, no new file on disk, and the downloaded bytes
identical to the `store=true` run.

Finally, a failed conversion with `store=true`:

```bash
printf '{"a":' > broken.json
curl -s -w '\n400? %{http_code}\n' -b cookies.txt -F "file=@broken.json" \
  -F "targetFormat=csv" -F "store=true" http://localhost:3007/api/convert
```

**Expect**: `400`, no stored file, and a history row with
`outcome = failure`, `retention_requested = true`, and
`retention_outcome = failed` — nothing is stored for a conversion that
produced no result (FR-026).

`failed` rather than `not_requested`: the caller *did* ask, so
`retention_requested` is `true`, and the schema's
`retention_outcome <> 'not_requested' ⇒ retention_requested = true` rule means
the two must agree. `not_requested` would say the user never asked, which is
the one thing that is not true here. (In a **200** response `failed` carries
its other meaning — the conversion succeeded and only the copy did not; there
is no ambiguity, because a failed conversion returns a JSON error and no
`X-Conversion-Retention` header at all.)

## Scenario 9 — Structural limits and timeout

```bash
python3 -c "print('['*200 + ']'*200)" > deep.json
curl -s -w '\n400? %{http_code}\n' -b cookies.txt \
  -F "file=@deep.json" -F "targetFormat=yaml" http://localhost:3007/api/convert
```

**Expect**: `400` with `"code": "structure_limit_exceeded"` (200 levels
against a default `CONVERSION_MAX_DEPTH` of 64).

A YAML alias bomb must be refused rather than expanded. It has to be an actual
bomb: a handful of aliases expands to a small, perfectly legal document and is
converted, as it should be. Nine-way fan-out over six levels is what exceeds
the cap (this is `test/support/conversion-fixtures/alias-bomb.yaml`):

```bash
cat > bomb.yaml <<'YAML'
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]
YAML
curl -s -w '\n400? %{http_code}\n' -b cookies.txt \
  -F "file=@bomb.yaml" -F "targetFormat=json" http://localhost:3007/api/convert
```

**Expect**: `400` with `"code": "parse_error"`, returned promptly (tens of
milliseconds), with memory flat — the alias cap refuses the expansion rather
than performing it.

## Scenario 10 — Discovery matches reality (SC-010)

Drive every advertised direction and confirm each is accepted, then confirm
each self-direction (`csv→csv`, …) is refused. The automated version of this
check lives in `test/file-conversion.e2e-spec.ts` and is the gate for
FR-012; the manual loop in Scenario 2 is the same assertion by hand.

## Automated suites

```bash
npm run verify     # typecheck + lint + unit tests (required gate)
npm run test:e2e   # includes test/file-conversion.e2e-spec.ts
```
