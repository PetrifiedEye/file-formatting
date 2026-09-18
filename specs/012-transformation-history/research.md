# Phase 0 Research: Transformation History

All unknowns from the Technical Context are resolved below. Each decision is
grounded in code already in this repository — feature 010 (file conversion),
feature 011 (image conversion), and feature 009 (admin user list), which this
feature reuses as precedent wherever the spec is silent on a mechanism.

---

## 1. Where the data comes from

**Decision**: Read directly from the existing `conversion_records` table
(`src/modules/conversion/entities/conversion-record.entity.ts`), owned by
`ConversionModule`. No new history table.

**Rationale**: FR-020 requires sourcing from "the existing, single history
store already populated by the file- and image-transformation features,
without duplicating or re-logging." Both `ConversionService` (file) and
`ImageConversionService` (image) already write every attempt — success or
failure — into `conversion_records` via the shared `ConversionHistoryService`
(confirmed by reading both call sites: `conversion.service.ts:156` and
`image-conversion.service.ts:184`). There is nothing else to source from.

**Alternatives considered**: A dedicated read-model/materialized view was
considered and rejected — at the stated scale (SC-001: tens of thousands of
records per user, <2s) a correctly indexed query against the existing table
is sufficient, and a projection would itself be "re-logging" the same
activity, which FR-020 forbids.

---

## 2. The "type" (file vs. image) discriminator gap

**The problem**: FR-010 and FR-013 require every record to expose and be
filterable by transformation `type` (`file` | `image`). Feature 011's own
data-model deliberately added **no discriminator column**, reasoning that
"an attempt is an image attempt exactly when its format is an image format"
— the format value itself says which family a row belongs to.

That reasoning has a hole this feature exposes for the first time: both
`source_format` and `target_format` are **nullable**, and reading
`conversion.service.ts` / `image-conversion.service.ts` confirms both can be
`NULL` simultaneously on an early failure — e.g. the uploaded part is
rejected before format detection runs, or the request is malformed before
`targetFormat` is parsed. For such a row, family cannot be recovered from the
format columns: there is no value to inspect. Feature 011 never had a reader
that needed to know the family for these rows, so the gap was latent; this
feature's `type` filter and required `type` field make it load-bearing.

**Decision**: Add a `transformation_type` column
(`ENUM('file','image') NOT NULL`) to `conversion_records`, populated
**by the writer, not derived from format** — `ConversionService` always
passes `'file'`, `ImageConversionService` always passes `'image'`. Each
service knows unconditionally which family it belongs to, independent of
whether detection ever succeeds, so this is never ambiguous at write time.

This is additive to feature 010/011's shared write path
(`ConversionHistoryService.ConversionAttempt`), not a new logging mechanism —
it satisfies FR-020 ("without duplicating or re-logging") because it is one
more column on the one row already being written, not a second write.

Existing rows (pre-feature, dev-only, no production data yet) are backfilled
in the same migration using the format value where available
(`source_format`/`target_format` IN the image set → `'image'`, else
`'file'`), with a documented `'file'` default for the residual case where
both are null — an acceptable approximation for pre-existing dev fixtures,
never for a row written after this migration lands.

**Alternatives considered**:
- *Derive `type` from format at query time, treat null/null rows as
  unfilterable / omit them from type-filtered results*: rejected — it would
  silently make some of a user's own failed attempts disappear from a
  type-filtered page, which contradicts "a record MUST satisfy every
  supplied filter to be included" (FR-010) by making inclusion
  non-deterministic for a subset of real rows, and contradicts FR-013's
  unconditional "every returned record MUST expose... transformation type."
- *Leave `type` out of the filter/response entirely and defer to a future
  feature*: rejected — it's an explicit, prioritized (P2) requirement
  (User Story 4) and a named response field (FR-013); the spec does not
  make it optional.
- *Infer family from which of the two conversion controllers issued the
  request, without persisting it*: not possible after the fact — history is
  read back by a different request entirely, with no link to the request
  that created the row.

**Consequence for Project Structure**: this feature edits feature
010/011's shared code (`conversion.enums.ts`, `conversion-history.service.ts`,
the two call sites, the entity, and one migration) in addition to adding its
own new module — the same kind of edit feature 011 made to feature 010 when
it widened the format enum, for the same reason (a later feature completing
a gap in a shared, additive table).

---

## 3. Terminology mapping: `outcome` → `status`, `error_category` → `errorCode`

**Decision**: The persisted `outcome` column (`success` | `failure`) is
exposed to callers as `status` (`success` | `error`), and `error_category`
is exposed as `errorCode`. The query DTO's `status` filter accepts
`success`/`error` and is translated to `outcome = 'success'/'failure'` in
the query builder; nothing new is persisted.

**Rationale**: The spec's contract (User Story 1 Acceptance Scenario 3, Key
Entities, FR-013) uses `status: success | error` and `errorCode` verbatim.
The persisted vocabulary predates this feature and uses `failure`/
`error_category` for reasons internal to the conversion feature (e.g.
`ConversionErrorCategory` also drives HTTP status mapping in
`conversion.exception.ts`, which this feature must not touch). Translating
at the API boundary avoids renaming a column three other features already
depend on, for a naming preference specific to this feature's contract.

---

## 4. Cursor pagination design

**Decision**: Reuse the exact keyset-pagination mechanism already built for
`GET /users` (`UserDirectoryService`, `src/modules/users/user-directory.service.ts`):
an HMAC-SHA256-signed, base64url cursor carrying `{v, fp, id, createdAt}`,
where `fp` is a SHA-256 fingerprint of the effective filter set. The keyset
predicate is `(created_at, id)` tuple comparison, descending, matching the
sort order (most-recent-first, fixed — no caller-selectable sort per the
spec's Assumptions).

**The one addition over the `/users` precedent**: the fingerprint MUST also
bind the cursor to *whose* history is being read — the caller for the self
route, the target `userId` for the admin route — not just the filters. This
is what makes FR-008 ("does not correspond to the caller... of the current
request") hold: without it, a cursor minted while reading user A's history
could be replayed, still correctly signed, against user B's history (by an
admin issuing both requests) and return page 2 of the wrong person's data.
`fp = sha256({subjectUserId, type, sourceFormat, targetFormat, status,
createdAtFrom, createdAtTo, limit})`.

The HMAC secret reused is `JWT_ACCESS_SECRET` via `ConfigService`, matching
`UserDirectoryService` exactly — no new secret to provision.

**Rationale**: FR-007/FR-008/FR-009 (opaque cursor, reject if malformed or
mismatched, idempotent repetition) are already solved once in this codebase;
re-solving them differently here would be pure risk for no benefit. Keyset
(not offset) pagination is also what SC-001 (<2s at tens of thousands of
rows) needs — offset pagination degrades with page depth.

**Alternatives considered**: A stateful server-side cursor (e.g. a
short-lived row in a `history_cursors` table) was considered and rejected —
it would need its own cleanup/expiry story and a write on every page read of
a read-only endpoint, for no capability the signed-cursor approach lacks.

---

## 5. Authorization model

**Decision**: One new RBAC permission, `transformation-history`, with a
single action `read-any`, granted to the `admin` role by default — following
the exact migration pattern used for the `settings` permission
(`1760600000000-SettingsPermissionAndAudit.migration.ts`): `INSERT` the
permission, `INSERT` a grant for the `admin` role, both `ON CONFLICT DO
NOTHING`. Checked the same way `UsersController` checks `users:list` —
a manual `accessConfigService.hasPermission(request.user.roles,
'transformation-history', 'read-any')` call inside the admin route handler,
not a class-level `@RequirePermission` decorator, because (like
`UsersController`) this controller also has a self-service route that must
never require the permission at all; a single class-level guard could not
express that split.

**Rationale**: FR-019 requires the Admin role to hold this permission by
default via "the existing access-control configuration" — this project's
access control is entirely DB-backed (roles/permissions/grants tables,
snapshotted in `AccessConfigService`), so a migration is the only mechanism
that exists for granting a default permission. `read-any` (not bare `read`)
names the capability precisely — reading one's own history needs no
permission at all, so a same-named-but-unqualified action would invite
confusion about which route it gates.

---

## 6. Rate limiting

**Decision**: `@Throttle({ default: { limit: 30, ttl: 60000 } })` on the
self route (matching `GET /users`'s admin-listing limit — the closest
existing precedent for a paginated, filterable, potentially bulk-read
endpoint), and `@Throttle({ default: { limit: 20, ttl: 60000 } })` on the
admin route — stricter, satisfying FR-016's "MUST NOT be more permissive
than the self-service one." Both sit under the app's global default
(`THROTTLE_GLOBAL_LIMIT`/`THROTTLE_GLOBAL_TTL`) as per-route overrides, the
same mechanism used throughout `UsersController` and `ConversionController`.

**Rationale**: The spec sets no numeric threshold, only the relative
constraint (admin ≤ self) and the general abuse-prevention goal (SC-008).
Reusing the admin-user-list number keeps the new endpoint consistent with
the one existing feature it most resembles in shape (paginated, filtered,
permission-gated administrative read).

---

## 7. Audit logging mechanics

**Decision**: A dedicated `TransformationHistoryAuditEvent` entity/service
pair, following the `UserDirectoryAuditEvent`/`UserDirectoryAuditService`
shape exactly (own table, `record()` wrapped in try/catch, never throws),
called from two places:

1. **In the controller**, `await`ed, for the outcomes reachable inside the
   handler body: `success`, `denied` (403), `not_found` (404).
2. **In a route-scoped exception filter**
   (`TransformationHistoryAuditFilter`, modeled directly on
   `UserDirectoryAuditFilter`), fire-and-forget, for outcomes that throw
   *before* the handler body runs: `unauthenticated` (401, thrown by
   `JwtAuthGuard`), `invalid` (400, thrown by `ValidationPipe` or
   `ParseUUIDPipe`), and `rate_limited` (429, thrown by the global
   `ThrottlerGuard`).

**Rationale**: This project has no generic audit service — every feature
that needs one builds its own entity + service, and `UserDirectoryAuditEvent`
already solves the identical problem (a paginated, filtered,
permission-gated read that must be audited on every outcome including ones
that never reach the handler). Reusing its two-call-site shape verbatim is
the smallest correct solution and keeps this feature's audit trail
consistent with the one other feature that already audits a history-style
read.

**Filter/value distinction (FR-017)**: only boolean "was this filter
supplied" flags are recorded (`typeFilterUsed`, `sourceFormatFilterUsed`,
`targetFormatFilterUsed`, `statusFilterUsed`, `dateRangeFilterUsed`) — never
the filter values themselves, matching `UserDirectoryAuditEvent`'s
`searchUsed`/`statusFilterUsed` booleans (which likewise omit the actual
search term).

**Non-blocking**: per the spec's Assumptions ("a best-effort audit write
MUST be attempted... but MUST NOT block or fail the response"), the audit
write is wrapped in try/catch inside the service (so a DB error there can
never surface as a 500 to the caller) — the same non-blocking guarantee
`UserDirectoryAuditService` gives, achieved the same way. It is still
`await`ed before the response is sent on the two in-handler paths (matching
`UsersController.listUsers`), and genuinely fire-and-forget only from the
exception filter (matching `UserDirectoryAuditFilter`) — consistent with
the only precedent this codebase has for this exact shape of requirement.

---

## 8. Indexing

**Decision**: One new composite index,
`idx_conversion_records_user_created (user_id, created_at DESC)`. No
additional per-filter index (type, format, status).

**Rationale**: `user_id` is in every query's `WHERE` clause (self: the
caller's own id; admin: the target's id) and `created_at DESC` is the fixed,
non-negotiable sort — together they are the one composite this feature's
every query shares, exactly mirroring why `idx_conversion_records_user_started`
was built the way it was for feature 010. The existing
`idx_conversion_records_user_started` index sorts by `started_at`, not
`created_at` — reusing it for this feature's `createdAt`-ordered,
`createdAt`-filtered reads would silently miss rows or return an
incorrectly-ordered page whenever `duration_ms` causes the two timestamps to
diverge, so a distinct index is required, not a reuse.

The lower-cardinality filters (`type`: 2 values, `status`: 2 values,
`source_format`/`target_format`: bounded small enum) are applied as
ordinary predicates on top of the `(user_id, created_at DESC)` index range
scan. This mirrors the precedent set by `UserDirectoryService`, whose
`status` filter and `search` predicate are likewise not separately indexed
beyond the one composite keyset index — sufficient there up to the same
"tens of thousands of rows per scope" scale this feature targets (SC-001).

**Alternatives considered**: A composite index per filter combination
(`(user_id, type, created_at)`, `(user_id, status, created_at)`, …) was
rejected as premature — Postgres can filter a handful of extra low-selectivity
predicates cheaply once the `user_id`-scoped, `created_at`-ordered range is
narrowed by the index; adding four more indexes would slow every write to
`conversion_records` (already a hot path for feature 010/011) for
combinations with no evidence of being a bottleneck at the stated scale.

---

## 9. Route shape

**Decision**:
- `GET /api/transformations/history` — self.
- `GET /api/transformations/history/:userId` — admin, `userId` validated
  with `ParseUUIDPipe` (matching the existing "malformed `:userId` → 400,
  not 500" precedent from `UsersController`).

**Rationale**: The spec states the admin path is "the same contract, by a
specific `userId`" against the self path
`GET /api/transformations/history` — a path parameter on the same base path
is the direct reading of that sentence, and mirrors `UsersController`'s own
`GET /users/:userId` shape for its analogous self/admin split.

**Request handling order** (governs which status code wins when multiple
conditions apply): `JwtAuthGuard` (401) → framework pipes: `ParseUUIDPipe`
on `:userId`, `class-validator` on the query DTO (400 for malformed shape) →
handler body: permission check for the admin route (403, checked *before*
querying for the target user's existence, so a caller without the
permission gets 403 "regardless of whether the target account id exists,"
per User Story 3) → existence check for the admin route (404) →
service-level cross-field validation — cursor ownership/fingerprint, date
range order (400) → query execution (200). This is standard NestJS pipe/guard
ordering (guards, then pipes, then handler body), not a new pattern.

---

## 10. Testing

**Decision**: One new e2e spec, `test/transformation-history.e2e-spec.ts`,
structured exactly like `test/users-directory.e2e-spec.ts` — boot the full
`AppModule`, seed `Role`/`Permission`/`Grant`/`UserRole` rows in-file (no
shared "login as admin" helper exists in this codebase; every spec
re-implements the seed/login sequence inline), log in via `POST /auth/login`
and extract the `access_token` cookie, call `accessConfigService.reload()`
after seeding grants, and clear `ThrottlerStorage` between tests. Fixture
history rows are inserted directly via the `ConversionRecord` repository
(no need to run real conversions through `/api/convert` to populate
history — feature 010/011 already have their own tests for the write path).

**Rationale**: This is a read-only feature over data the tests can seed
directly; going through the real conversion endpoints to generate fixture
rows would make this suite depend on, and be slowed by, two other features'
full pipelines for no added coverage.
