# Feature Specification: Admin User List

**Feature Branch**: `009-admin-user-list`

**Created**: 2026-09-09

**Status**: Draft

**Input**: User description: "Просмотр списка всех пользователей — Back-end. Назначение: предоставить администратору список пользователей с возможностью поиска/фильтрации. Admin: доступ разрешён; другие роли: запретить. Авторизация через access JWT (cookie) и RBAC. Сценарии: Admin получает страницу результатов; Admin ищет/фильтрует; без права — 403. Контракт: получение списка с курсорной пагинацией, поиском (email/имя/id), фильтром статуса, сортировкой. Элемент списка: id, email (или маскировать), photo, createdAt, status, опционально lastLoginAt. Проверки: JWT, право администратора (например users.list.admin), валидация параметров. Ошибки: 200/401/403, rate limit, не выдавать секреты. Аудит: actorUserId, параметры без PII, результат, количество элементов. НФТ: строгая RBAC, минимизация PII, обязательная пагинация, стабильная курсорная пагинация."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrator views a page of users (Priority: P1)

An administrator with directory-listing rights opens the user directory and receives one page of users, not the entire population at once. Each item shows enough to identify the person (account id, email, profile photo if present, account status, when the account was created, and last successful sign-in when known).

**Why this priority**: Without a paginated directory, administrators cannot operate on the user base at all. This is the minimum useful delivery of the feature.

**Independent Test**: Sign in as an administrator, request the user directory with no search or filters, and verify a bounded page of user summaries is returned with a way to request the next page when more users exist.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator with user-directory listing rights and more users than one page, **When** they request the user directory without search or filters, **Then** they receive a successful result containing only one page of user summaries and a continuation token for the next page.
2. **Given** an authenticated administrator with listing rights and no more users than one page, **When** they request the user directory, **Then** they receive every matching user on that single page and no continuation token.
3. **Given** an authenticated administrator with listing rights, **When** they request the next page using a previously issued continuation token and the same listing options, **Then** they receive the next disjoint page of users (no duplicates from the prior page) or an empty page if they have reached the end.
4. **Given** an authenticated administrator with listing rights, **When** they request the directory, **Then** each item includes account id, email, profile photo URL (or an empty photo when none is uploaded), account status, and created date.

---

### User Story 2 - Administrator searches and filters the directory (Priority: P1)

An administrator narrows the directory by a search phrase (email or account id) and/or by account status, and may change sort field and direction. The result is a paginated subset that matches all supplied criteria.

**Why this priority**: Search and filter are part of the stated purpose of the feature (find a specific user among many). They are independently testable on top of the same listing operation.

**Independent Test**: Create users with known emails and statuses, request the directory with search and/or status filter and a chosen sort, and verify only matching users appear, in the requested order, still paginated.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator with listing rights, **When** they supply a search phrase that matches a user's email (case-insensitive, partial match), **Then** the result contains only users whose email matches that phrase.
2. **Given** an authenticated administrator with listing rights, **When** they supply a search phrase that equals a user's account id, **Then** that user is included in the result (when the account is still listable).
3. **Given** an authenticated administrator with listing rights, **When** they filter by a supported account status, **Then** every returned item has that status and users in other statuses are omitted.
4. **Given** an authenticated administrator with listing rights, **When** they combine a search phrase and a status filter, **Then** results must match both criteria.
5. **Given** an authenticated administrator with listing rights, **When** they request a supported sort field and direction, **Then** the page is ordered accordingly.
6. **Given** an authenticated administrator with listing rights, **When** they omit search, status, sort, and direction, **Then** the directory uses the defaults: no text search, all listable statuses, sorted by created date newest-first.

---

### User Story 3 - Listing is denied without administrator rights (Priority: P1)

A signed-in user who is not an administrator, and who does not hold the dedicated user-directory listing permission, attempts to retrieve the directory. The system refuses the request and returns no user summaries.

**Why this priority**: Bulk access to every account is more sensitive than viewing a single profile. This is the primary security boundary and must hold even if search and pagination are only partially implemented.

**Independent Test**: Sign in as a user without listing rights (including a user who can view a single other profile but cannot list all users), request the directory, and verify a forbidden outcome with an empty body.

**Acceptance Scenarios**:

1. **Given** an authenticated user without the user-directory listing permission, **When** they request the user directory, **Then** they receive a 403 response and no user items are disclosed.
2. **Given** an authenticated user who holds other user-management rights (for example viewing a single profile) but not listing rights, **When** they request the user directory, **Then** they still receive a 403 response and no user items are disclosed.
3. **Given** an unauthenticated request, **When** the user directory is requested, **Then** the response is 401 and no user items are disclosed.

---

### User Story 4 - Invalid listing options are rejected (Priority: P2)

An administrator submits listing options that are out of range or not recognized (page size, continuation token, status, sort field, or direction). The system rejects the request rather than guessing or running an unbounded query.

**Why this priority**: Protects the directory from accidental or abusive queries; depends on the listing operation existing.

**Independent Test**: As an administrator, submit each invalid option in turn and verify the request is rejected with no listing payload.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator, **When** they request a page size below the minimum or above the maximum, **Then** the request is rejected as invalid and no items are returned.
2. **Given** an authenticated administrator, **When** they supply an unrecognized status, sort field, or sort direction, **Then** the request is rejected as invalid.
3. **Given** an authenticated administrator, **When** they supply a continuation token that is malformed or does not correspond to the current listing options, **Then** the request is rejected as invalid.

---

### User Story 5 - Directory access is audited (Priority: P3)

Each attempt to list users is recorded so security review can see who asked, whether it succeeded, and how many items were returned — without copying emails or search text into the audit trail.

**Why this priority**: Supports compliance and abuse detection for a privileged bulk-read, but the directory can function without it.

**Independent Test**: Perform a successful list, a forbidden attempt, and an unauthenticated attempt; verify each produces an audit record with actor (when known), outcome, and result count, and that the record does not contain email addresses or the raw search phrase.

**Acceptance Scenarios**:

1. **Given** any user-directory request (allowed, forbidden, or unauthenticated), **When** the request completes, **Then** an audit record is created with the outcome and, on a successful list, the number of items returned.
2. **Given** a successful list by an administrator, **When** the audit record is inspected, **Then** it includes the acting user's id and which kinds of options were used (search present or not, status filter present or not, sort field) — not the search text, not email values, and not full query strings that contain personal data.
3. **Given** a forbidden or unauthenticated attempt, **When** the audit record is inspected, **Then** it records the denial outcome and does not include any user-directory items.

---

### Edge Cases

- What happens when no users match the search or filter? The result is successful with an empty item list and no continuation token.
- What happens when repeated directory requests exceed the configured rate limit? Further requests are rejected until the window resets, regardless of whether the caller is an administrator.
- What happens when a user's listing permission is revoked between sign-in and the request? The decision uses current permissions at request time, not permissions remembered from sign-in.
- What happens when an account is deleted (or is in the process of being deleted) while an administrator is paging through the directory? Fully removed accounts and accounts already being deleted are omitted from subsequent pages; a continuation token must not error solely because a previously listed account disappeared.
- What happens when two administrators request the same listing options at the same time? Each receives a consistent page for those options; newly created accounts may appear on later pages, not as duplicates on a page already issued.
- What happens when the search phrase is only whitespace? It is treated as no search (same as omitting the phrase).
- What happens when a listed user has no profile photo? The photo field is empty/null; the rest of the item is still returned.
- What happens when last successful sign-in is unknown (the user has never signed in, or the product does not have a last-sign-in timestamp)? The last-sign-in field is empty/null.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an authenticated user who holds the `users.list` permission to retrieve a paginated directory of listable user accounts.
- **FR-002**: System MUST deny the directory request with a 403 response and no items when the caller is authenticated but does not hold `users.list`.
- **FR-003**: System MUST reject unauthenticated directory requests with a 401 response and no items, before evaluating permissions or loading users.
- **FR-004**: System MUST always paginate the directory. Callers MAY supply a page size; the default is 20 and the allowed range is 1–100 inclusive. Requests outside that range MUST be rejected.
- **FR-005**: System MUST support cursor-style pagination: a successful page that has more matching users MUST include an opaque continuation token; a page with no further results MUST include an empty continuation token. The token is optional on the first request.
- **FR-006**: Repeating the same listing options with the same continuation token MUST return the same page of account ids (stable, idempotent pagination) while those accounts remain listable.
- **FR-007**: System MUST support an optional search phrase that matches against email (case-insensitive partial match) and against account id (exact match). No other fields may be searched.
- **FR-008**: System MUST support an optional status filter. Supported filter values for this feature are `active` and `pending_confirmation`. Unrecognized values MUST be rejected.
- **FR-009**: System MUST support optional sort by created date, last successful sign-in, or email, with optional ascending or descending direction. The default is created date, newest first. Unrecognized sort or direction values MUST be rejected. Accounts with an unknown last sign-in sort after those with a known last sign-in when sorting by last sign-in newest-first, and before them when sorting oldest-first.
- **FR-010**: Search, status, sort, and pagination options MUST be combinable. Search and status are applied together (a user must satisfy every supplied criterion).
- **FR-011**: System MUST return only a fixed allow-list of fields on each item: account id, email, profile photo URL (or null), created date, account status, and last successful sign-in (or null). Any other account field MUST be omitted.
- **FR-012**: System MUST never include secrets or sensitive internals in the directory (passwords or password hashes, session or recovery tokens, two-factor secrets, failed-attempt counters, lockout timestamps, internal flags).
- **FR-013**: Email in the directory MUST be returned in full (not masked) to callers who hold `users.list`.
- **FR-014**: Profile photo MUST be represented as a resolvable URL when a photo has been uploaded, and as null when it has not. Photo storage mechanics are out of scope.
- **FR-015**: Accounts that have already been fully deleted, and accounts already in the process of being deleted, MUST NOT appear in the directory.
- **FR-016**: System MUST apply a rate limit to the user-directory operation to limit scraping and bulk extraction of personal data.
- **FR-017**: System MUST evaluate `users.list` at request time (not from a permission snapshot taken at sign-in).
- **FR-018**: System MUST record an audit entry for every directory attempt, capturing the actor's user id when authenticated, the outcome (success, forbidden, unauthenticated, invalid, or rate-limited), the number of items returned on success, and which option kinds were present (search used, status filter used, sort field) — without storing the search phrase, email values, or other personal data.
- **FR-019**: The Admin role MUST be granted `users.list` by default. No other existing role receives it unless an administrator later grants it through the existing access-control configuration.
- **FR-020**: Holding `users.read` (view a single profile) MUST NOT by itself grant directory listing.

### Key Entities

- **User Directory Item**: A summary of one listable account for administrative review. Contains account id, email, profile photo URL or null, created date, account status, and last successful sign-in or null.
- **Directory Page**: A bounded set of user directory items plus an optional continuation token for the next page.
- **Listable Account**: A user account that still exists and is not in the process of being deleted. Statuses in scope are `active` (sign-in ready) and `pending_confirmation` (awaiting registration confirmation).
- **User Directory Audit Record**: A log entry for a directory attempt: actor id (if any), outcome, result count, and option kinds — never item payloads or search text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator with listing rights can retrieve the first page of the user directory in under 2 seconds under normal operating conditions, including when the directory contains at least 10,000 accounts.
- **SC-002**: 100% of directory requests by callers who lack `users.list` are denied, with zero user items in the response.
- **SC-003**: 100% of unauthenticated directory requests are denied before any user data is evaluated.
- **SC-004**: No successful directory response contains more items than the requested (or default) page size, and no successful response omits a continuation token when further matching accounts exist.
- **SC-005**: Repeating the same listing options and continuation token returns the same ordered set of account ids in 100% of tests, while those accounts remain listable.
- **SC-006**: 100% of tested directory responses contain only allow-listed fields; password hashes, tokens, and other secrets never appear.
- **SC-007**: When a search phrase matches a known email or account id, the matching listable account appears in the results in 100% of tests; non-matching accounts do not.
- **SC-008**: Under sustained repeated directory requests from a single client, excess requests are rejected once the configured threshold is exceeded, in 100% of tested overflow scenarios.
- **SC-009**: Every directory attempt (allowed or denied) produces an audit record that a reviewer can retrieve within 1 minute, with zero email values or search phrases stored in that record.

## Assumptions

- Authentication reuses the existing signed-in session (access credential already established by the login and session features). This feature only consumes that identity.
- Access control reuses the existing role-and-permission model. `users.list` is a new action on the existing `users` permission, distinct from `users.read`, `users.update`, and `users.delete`.
- Email is shown in full because the directory's job is to let an administrator identify and search accounts. Masking would undermine search-by-email. Callers without `users.list` never receive the directory at all.
- Display name is not a current user attribute in this product, so search-by-name is out of scope; search is limited to email and account id.
- Account statuses `blocked` and `deleted` are out of scope for this feature: there is no product capability to block an account as a durable status, and deleted accounts have personal data removed so they are not listable. Introducing a block-user lifecycle is a separate feature.
- Last successful sign-in is included when the product can determine it from existing sign-in history; this feature does not invent a new sign-in tracking process beyond exposing that timestamp on the directory item.
- Default page size of 20 and maximum of 100 follow common administrative-directory practice and the bounds given in the feature request.
- Rate-limit thresholds reuse the project's existing abuse-prevention approach for privileged, data-heavy reads, rather than a unique policy defined here.
- Audit logging is best-effort with respect to not blocking the response if the log write fails after the directory result has already been produced; a successful list still MUST attempt to record the audit entry.
- Photo URLs follow the same representation already used on user profiles; this feature does not change how photos are stored or served.
- Exporting the entire directory as a file, bulk editing from the list, and role/permission display on each row are out of scope.
