# Research: User Registration

**Feature**: `001-user-registration`  
**Date**: 2026-09-01

Resolves all technical unknowns identified during planning.

---

## 1. Password Hashing

**Decision**: Use `bcryptjs` with cost factor 12 for password hashing and verification.

**Rationale**: Industry-standard adaptive hashing; pure JavaScript (no native bindings) simplifies Jest unit tests and CI. Cost factor 12 balances security and acceptable latency for registration (~200–300 ms). Aligns with constitution security requirements without adding operational complexity of native modules.

**Alternatives considered**:
- `argon2` — stronger against GPU attacks but requires native bindings and complicates test/CI setup.
- `scrypt` — similar trade-offs to argon2; less common in NestJS examples.
- Plain SHA-256 — rejected; not suitable for password storage.

---

## 2. OTP and Magic-Link Token Generation

**Decision**:
- OTP: 6-digit decimal code via `crypto.randomInt(100000, 1000000)`.
- Magic link: 32-byte cryptographically random token via `crypto.randomBytes(32)`, encoded as `base64url`.
- Store only SHA-256 hashes of OTP and link token in the database; never persist or log raw values.

**Rationale**: Meets spec (FR-009, FR-010, FR-011, FR-018). Hashing at rest limits blast radius if the confirmation-challenges table is exposed. `crypto` is built-in and auditable.

**Alternatives considered**:
- Store OTP plaintext for easy comparison — rejected; violates audit/secret-handling requirements.
- UUID v4 for link token — acceptable entropy but base64url 32-byte token is shorter in URLs and equally secure.

---

## 3. Email Delivery

**Decision**: Add a `EmailModule` under `src/core/email/` using **Nodemailer** with SMTP transport. Configuration via Joi-validated env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `APP_BASE_URL`). Development uses Mailpit/Mailhog (docker-compose sidecar).

**Rationale**: No email infrastructure exists in the repo. Nodemailer is the de-facto Node.js SMTP client, provider-agnostic, and easy to mock in tests. Mailpit gives operators a local inbox for manual quickstart validation.

**Alternatives considered**:
- `@nestjs-modules/mailer` — higher-level wrapper; adds Handlebars/Pug templating we do not need yet.
- SendGrid/SES SDK directly — couples to a single provider; SMTP works with any provider.
- In-memory/no-op sender only — insufficient for e2e confirmation flows.

---

## 4. Email Normalization and Uniqueness

**Decision**: Normalize email as `trim().toLowerCase()` before validation and storage. PostgreSQL `citext` column type (via TypeORM `type: 'citext'`) with a unique index on `users.email`.

**Rationale**: Spec requires case-insensitive matching (FR-005, edge cases). `citext` enforces uniqueness at the database layer and simplifies queries. Migration enables `citext` extension once.

**Alternatives considered**:
- Store lowercase in `varchar` with functional unique index on `LOWER(email)` — works but `citext` is cleaner for equality comparisons.
- Application-only normalization without DB constraint — rejected; race conditions could create duplicates.

---

## 5. User vs Pending Registration Model

**Decision**: Single `users` table with `status` enum: `pending_confirmation` | `active`. Pending registrations carry `pending_expires_at` (24 h from last confirmation email). No separate pending-registration table.

**Rationale**: A pending registration is a user record that is not yet usable (spec entity: "Pending Registration"). One table avoids join complexity and duplicate email handling. Expiry is a column update + scheduled cleanup or lazy check on access.

**Alternatives considered**:
- Separate `pending_registrations` table — clearer separation but duplicates email/password fields and complicates "same email re-register after expiry" logic.
- Soft-delete pattern — unnecessary for this flow.

---

## 6. Confirmation Challenge Lifecycle

**Decision**: `confirmation_challenges` table linked to `users.id`. One active challenge per pending user at a time. Resend invalidates the previous row (`invalidated_at`) and inserts a new challenge. Confirmation (code or link) marks challenge consumed and sets `users.status = active` in a single `@Transactional()` block.

**Rationale**: Supports FR-010, FR-011, FR-014 atomically. Attempt counter lives on the challenge row. Invalid/expired checks are centralized in the service layer.

**Alternatives considered**:
- Embed OTP fields on `users` — works for MVP but resend/history auditing is harder.
- Redis for ephemeral challenges — no Redis in stack; PostgreSQL is sufficient at expected scale.

---

## 7. Rate Limiting Strategy

**Decision**: Layered limits:
1. **HTTP layer**: `@nestjs/throttler` with route-specific `@Throttle()` — registration: 5 req/min/IP; resend: 1 req/60 s/IP (matches FR-013).
2. **Application layer**: Count confirmation-email audit events for `(normalized_email, last 10 min)` — reject if ≥ 5 (SC-007). Implemented in service before send.

**Rationale**: Constitution requires throttling on abuse-prone endpoints. HTTP throttling alone cannot enforce per-email caps or 60 s resend gap tied to last send time; application checks use `confirmation_challenges.last_sent_at` and audit counts.

**Alternatives considered**:
- Redis sliding window — not in current stack.
- DB-only without HTTP throttler — insufficient against distributed IP rotation at the edge.

---

## 8. Administrator Confirmation Policy Storage

**Decision**: `system_settings` singleton row (id fixed = 1) with columns:
- `registration_confirmation_enabled` (boolean, default `false`)
- `password_recovery_confirmation_enabled` (boolean, default `false`)
- `sign_in_confirmation_enabled` (boolean, default `false`)
- Password policy fields: `password_min_length` (default 8), `password_require_uppercase`, `password_require_digit`, `password_require_special` (booleans, default `false`)

Admin updates via `PATCH /admin/settings/confirmation-policy` (implementation phase adds auth guard placeholder).

**Rationale**: Spec requires independent per-scenario flags (FR-017) and configurable password complexity (FR-004). Database storage allows runtime toggling without redeploy; seed migration sets defaults matching spec assumptions.

**Alternatives considered**:
- Environment variables only — requires redeploy to toggle; poor fit for admin-controlled flags.
- JSON blob settings — flexible but harder to query/migrate.

---

## 9. Audit Logging

**Decision**: Append-only `registration_audit_events` table with: `id`, `event_type`, `outcome`, `normalized_email`, `user_id` (nullable), `ip_address`, `user_agent`, `metadata` (jsonb), `created_at`. Structured NestJS `Logger` calls mirror events for observability.

**Rationale**: FR-018 and SC-008 require operator reconstruction without secrets. Email is stored normalized for operator lookup (not exposed to guests per FR-015). Passwords, raw OTP, and link secrets are never written.

**Alternatives considered**:
- External audit SaaS — out of scope for this feature.
- Log-only without DB — harder to query for compliance reconstruction.

---

## 10. OpenAPI Documentation

**Decision**: Add `@nestjs/swagger` in implementation phase; decorate registration DTOs and controllers with `@ApiTags`, `@ApiOperation`, `@ApiResponse`. Serve Swagger UI at `/api/docs` in development; gated route in production.

**Rationale**: Constitution V requires OpenAPI that reflects the running contract. Swagger decorators co-locate with DTOs already using `class-validator`.

**Alternatives considered**:
- Hand-written OpenAPI YAML only — drifts from implementation without codegen discipline.

---

## 11. Anti-Enumeration Response Strategy

**Decision**: Registration endpoint returns `201 Created` with a generic success body when input is valid-format regardless of duplicate email; duplicate usable account returns `200 OK` (or `201`) with the **same** response shape and message: `"If this email is eligible, registration instructions have been sent."` When confirmation is off, message variant: `"If this email is eligible, your account is ready to sign in."` Never return `409 Conflict` with "email exists" to the client.

**Rationale**: FR-015. Audit table records actual outcome (`duplicate_email`, `success`, etc.) for operators.

**Alternatives considered**:
- Always return 201 — simpler but misleading HTTP semantics for idempotent duplicate handling.

---

## 12. CORS Configuration

**Decision**: Move trusted origins from hard-coded `main.ts` array to `CORS_ORIGINS` env var (comma-separated), validated by Joi. Keep localhost defaults for development when unset.

**Rationale**: Constitution II requires CORS from env in production. Registration feature touches guest-facing endpoints; fixing CORS is a prerequisite change bundled with this feature's implementation.

**Alternatives considered**:
- Leave hard-coded origins — constitution violation for production.

---

## Summary

All planning unknowns are resolved. No remaining `NEEDS CLARIFICATION` items. Implementation may proceed to Phase 1 design artifacts and subsequent `/speckit-tasks`.
