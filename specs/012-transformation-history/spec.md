# Feature Specification: Transformation History

**Feature Branch**: `012-transformation-history`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "Просмотр истории трансформаций файлов пользователя. Назначение: предоставить пользователю и администратору доступ к истории выполненных трансформаций (файлы и изображения). Роли: Self — только свои трансформации; Admin — трансформации любого пользователя. Авторизация через access JWT (cookie). Все трансформации логируются в единое хранилище истории. Пагинация курсорная. Self: GET /api/transformations/history с фильтрами (type, sourceFormat, targetFormat, status, createdAtFrom/To) и лимитом/курсором, возвращает items + nextCursor, поля записи: id, type, sourceFormat, targetFormat, status, fileSize, durationMs, errorCode?, createdAt. Admin: тот же контракт по конкретному userId, требует права администратора, 404 если пользователь не найден, 403 без прав. Ошибки/ограничения: нельзя смотреть чужую историю без прав, невалидные фильтры/пагинация отклоняются, rate limit на endpoint (особенно для админа), не раскрывать чувствительные данные других пользователей. Аудит: actorUserId, targetUserId (для админ-доступа), параметры без PII, результат (200/403/404), количество записей; не логировать содержимое файлов/изображений. НФТ: строгий контроль доступа, обязательная пагинация с индексами по userId/createdAt/type/status, идемпотентность одинаковых запросов, срок хранения истории — на усмотрение администрирования (например 90 дней)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A user reviews their own transformation history (Priority: P1)

A signed-in user opens their transformation history and receives one page of the file and image transformations they personally ran, most recent first, without needing any special permission beyond being signed in.

**Why this priority**: This is the entire reason the feature exists for ordinary users. Without it, a user has no way to confirm what they converted, when, or whether it succeeded.

**Independent Test**: Sign in as a user who has run several file and image transformations, request the transformation history with no filters, and verify a bounded page of that user's own transformation records is returned, newest first, and that no other user's records appear.

**Acceptance Scenarios**:

1. **Given** an authenticated user who has completed both file and image transformations, **When** they request their transformation history with no filters, **Then** they receive a successful result containing only their own transformation records, most recent first, and a continuation token when more records exist.
2. **Given** an authenticated user with fewer transformation records than one page, **When** they request their history, **Then** they receive all of their records on a single page and the continuation token field is null.
3. **Given** an authenticated user, **When** they inspect a returned record, **Then** it contains the transformation type, source format, target format, status, source file size, duration, creation time, and — only when the status is an error — an error code, and it contains no other user's data.
4. **Given** an authenticated user who has never run a transformation, **When** they request their history, **Then** they receive a successful, empty page (empty item list, continuation token null), not an error.

---

### User Story 2 - An administrator reviews a specific user's transformation history (Priority: P1)

An administrator who holds the transformation-history oversight permission looks up a particular user by their account id and receives that user's transformation history, using the same paging and filtering behavior available to the user themselves.

**Why this priority**: Support and abuse investigations need to see what a specific account did without asking the user to self-report or granting broader account access than necessary.

**Independent Test**: Sign in as an administrator holding the oversight permission, request the transformation history of a known user by account id, and verify the returned page contains only that user's transformation records.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator holding the transformation-history oversight permission, **When** they request the transformation history for an existing user's account id, **Then** they receive that user's records on a paginated page, formatted the same way as the self-service history.
2. **Given** an authenticated administrator holding the oversight permission, **When** they request the transformation history for an account id that does not exist, **Then** they receive a 404 response and no transformation records.
3. **Given** an authenticated administrator holding the oversight permission, **When** they request the history of a user who has no transformation records, **Then** they receive a successful, empty page.

---

### User Story 3 - Access to another user's history is denied without the oversight permission (Priority: P1)

A signed-in user who does not hold the transformation-history oversight permission — including one who can view their own history — attempts to retrieve another user's transformation history. The system refuses the request and discloses nothing.

**Why this priority**: Transformation history can reveal what files or images a person has handled; this is the primary security boundary and must hold regardless of how filtering or pagination is implemented.

**Independent Test**: Sign in as a user without the oversight permission, request another user's transformation history by account id, and verify a forbidden response with no transformation records disclosed.

**Acceptance Scenarios**:

1. **Given** an authenticated user without the transformation-history oversight permission, **When** they request another user's transformation history, **Then** they receive a 403 response and no transformation records are disclosed, regardless of whether that target account id exists.
2. **Given** an unauthenticated request, **When** any transformation history (self or admin) is requested, **Then** the response is 401 and no transformation records are disclosed.
3. **Given** an authenticated user without the oversight permission, **When** they request their own history through the self endpoint, **Then** the request still succeeds — the permission only gates viewing other users' history.

---

### User Story 4 - Narrowing history with filters (Priority: P2)

A user or an administrator narrows a transformation history request by transformation type (file or image), source/target format, status, and a creation-date range, and receives only the records matching every supplied criterion.

**Why this priority**: Filtering is what turns a long history into something usable for troubleshooting a specific conversion or reviewing a time window, but the feature is already useful without it (User Story 1/2 cover the unfiltered case).

**Independent Test**: As a user with a mix of successful and failed, file and image transformations, request history with each filter individually and in combination, and verify only matching records are returned.

**Acceptance Scenarios**:

1. **Given** a user with both file and image transformation records, **When** they filter by transformation type, **Then** only records of that type are returned.
2. **Given** a user with transformations between several source and target formats, **When** they filter by source format and/or target format, **Then** only records matching the supplied format(s) are returned.
3. **Given** a user with both successful and failed transformations, **When** they filter by status, **Then** only records with that status are returned, and only failed records include an error code.
4. **Given** a user with transformations spread across time, **When** they supply a creation-date range, **Then** only records created within that range (inclusive) are returned.
5. **Given** a user, **When** they combine several filters, **Then** every returned record satisfies all supplied criteria, and a combination that matches nothing returns a successful empty page rather than an error.
6. **Given** an administrator viewing a specific user's history, **When** they apply any of the above filters, **Then** filtering behaves identically to the self-service history.

---

### User Story 5 - Invalid history requests are rejected (Priority: P2)

A caller submits a page size, continuation token, filter value, or date range that is out of bounds or unrecognized. The system rejects the request instead of guessing or returning an unbounded result.

**Why this priority**: Protects the history store from abusive or malformed queries; depends on the history operation already existing.

**Independent Test**: As an authenticated user, submit each invalid input in turn (oversized page size, garbled cursor, unknown type/format/status value, and an end-of-range date before the start-of-range date) and verify each is rejected with no history payload.

**Acceptance Scenarios**:

1. **Given** an authenticated caller, **When** they request a page size below the minimum or above the maximum, **Then** the request is rejected as invalid and no records are returned.
2. **Given** an authenticated caller, **When** they supply an unrecognized transformation type, format, or status value, **Then** the request is rejected as invalid.
3. **Given** an authenticated caller, **When** they supply a continuation token that is malformed, does not belong to them, or does not match the current filters, **Then** the request is rejected as invalid.
4. **Given** an authenticated caller, **When** the end of a supplied date range is earlier than the start, **Then** the request is rejected as invalid.

---

### User Story 6 - Every history request is audited (Priority: P3)

Each attempt to read transformation history — by a user for themselves, or by an administrator for another user — is recorded so security review can see who asked, about whom, whether it succeeded, and how many records were returned, without capturing file contents or unrelated personal data.

**Why this priority**: Supports compliance and abuse detection for a feature that exposes a record of user activity, but the history feature can function without it.

**Independent Test**: Perform a successful self history read, a successful admin read of another user, a forbidden attempt, and a not-found attempt; verify each produces an audit record with the acting user, the target user when applicable, the outcome, and the result count, and that no record contains file/image content.

**Acceptance Scenarios**:

1. **Given** any transformation-history request (self or admin, allowed or denied), **When** the request completes, **Then** an audit record is created capturing the acting user's id, the target user's id when the admin path was used, the outcome, and, on success, the number of records returned.
2. **Given** a completed transformation-history request, **When** the audit record is inspected, **Then** it does not contain file or image contents, and omits personal data beyond the actor and target account ids.
3. **Given** a forbidden or not-found attempt, **When** the audit record is inspected, **Then** it records that outcome and contains zero transformation records.

---

### Edge Cases

- What happens when no records match the supplied filters? The result is successful with an empty item list and a continuation token of null, not an error.
- What happens when repeated history requests exceed the configured rate limit? Further requests are rejected until the limit window resets; the administrator-facing endpoint is protected by its own limit independent of the self-service one.
- What happens when a user's oversight permission is revoked between sign-in and the request? The decision uses the permission held at request time, not one remembered from sign-in.
- What happens when an administrator requests history for an account that has since been permanently deleted? The request is treated as a not-found account (404), even if history records for that account still exist in storage.
- What happens when two callers request the same filters and continuation token at the same time? Each receives the same page of records for those filters, as long as the matching records haven't changed.
- What happens when a transformation failed partway through? Its record has status "error" with an error code; no partial or in-progress status is exposed, because a transformation is only recorded once it has finished.
- What happens when the caller omits every filter? All of that user's (or, for an admin, the target user's) transformation records are returned, most recent first, still paginated.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an authenticated user to retrieve a paginated page of their own transformation history without requiring any permission beyond being signed in.
- **FR-002**: System MUST allow an authenticated user who holds the transformation-history oversight permission to retrieve a paginated page of transformation history for any other specified, existing user account.
- **FR-003**: System MUST deny a request for another user's transformation history with a 403 response and no records when the caller does not hold the oversight permission, regardless of whether the target account exists.
- **FR-004**: System MUST reject unauthenticated requests to either the self-service or the admin-facing history operation with a 401 response and no records, before evaluating permissions or loading data.
- **FR-005**: System MUST respond with a 404 and no records when an administrator requests history for an account id that does not correspond to an existing user.
- **FR-006**: System MUST always paginate history results. Callers MAY supply a page size; the default is 20 and the allowed range is 1–100 inclusive. A page size outside that range MUST be rejected.
- **FR-007**: System MUST support cursor-style pagination: a page with further matching records MUST return a non-empty, opaque continuation token, and the last page MUST return a continuation token of null (not an empty string, and the field MUST always be present). The initial request MAY omit the continuation token.
- **FR-008**: System MUST treat a continuation token as invalid — and reject the request — when it is malformed or does not correspond to the caller and filters of the current request.
- **FR-009**: Repeating an identical request (same filters, same continuation token, same caller/target) MUST return the same set of records, as long as the underlying matching records have not changed (idempotent pagination).
- **FR-010**: System MUST support filtering history by transformation type (file or image), source format, target format, status (success or error), and a creation-date range (from/to, inclusive), each optional and combinable; a record MUST satisfy every supplied filter to be included.
- **FR-011**: System MUST reject a request whose type, format, or status filter value is not one of the values the system recognizes for that field.
- **FR-012**: System MUST reject a request whose date range has an end before its start.
- **FR-013**: Each returned transformation-history record MUST expose exactly: a record id, transformation type, source format, target format, status, source file size, transformation duration, creation time, and — only when status is "error" — an error code; no other field, and no data belonging to a user other than the one the history belongs to, MUST be exposed.
- **FR-014**: System MUST NOT expose file or image contents, storage locations, or other users' identifying details (such as email) through the transformation-history operation.
- **FR-015**: System MUST evaluate the oversight permission at the time of each request, not from a permission state captured at sign-in.
- **FR-016**: System MUST apply a rate limit to both the self-service and the admin-facing history operations, independently, to limit abuse and bulk extraction; the admin-facing operation's limit MUST NOT be more permissive than the self-service one.
- **FR-017**: System MUST record an audit entry for every history request (self or admin path), capturing the acting user's id, the target user's id when the admin path is used, which filter kinds were supplied (not their values when those values could reveal another party's personal data), the outcome (success, denied, not found, unauthenticated, or invalid), and the number of records returned on success.
- **FR-018**: System MUST NOT include file contents, image contents, or other raw payload data in audit entries produced by this feature.
- **FR-019**: The Admin role MUST be granted the transformation-history oversight permission by default; no other existing role receives it unless later granted through the existing access-control configuration.
- **FR-020**: System MUST source transformation-history records from the existing, single history store already populated by the file- and image-transformation features, without duplicating or re-logging transformation activity itself.

### Key Entities

- **Transformation History Record**: One completed transformation attempt (file or image) belonging to exactly one user. Contains a record id, transformation type, source format, target format, status (success or error), source file size, duration, an error code (only present on error), and creation time. Sourced from the transformation activity already captured by the file- and image-conversion features.
- **Transformation History Page**: A bounded, ordered (most recent first) set of Transformation History Records for one user, plus a continuation token: a non-empty opaque value when more records exist, or null on the last page.
- **Transformation History Oversight Permission**: The access-control grant that allows an administrator to view another user's Transformation History Page. Held by the Admin role by default; viewing one's own history never requires it.
- **Transformation History Access Audit Entry**: A log entry for one history request: acting user id, target user id (when applicable), which filter categories were used, the outcome, and the result count — never file/image content and never another user's personal data beyond their account id.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can retrieve the first page of their own transformation history in under 2 seconds under normal operating conditions, including for accounts with tens of thousands of historical records.
- **SC-002**: 100% of requests for another user's transformation history by a caller lacking the oversight permission are denied, with zero records disclosed.
- **SC-003**: 100% of unauthenticated history requests are denied before any transformation data is evaluated.
- **SC-004**: 100% of admin requests for a non-existent account id receive a not-found response with zero records.
- **SC-005**: No successful history response ever contains more records than the requested (or default) page size, and no successful response omits a continuation token when further matching records exist.
- **SC-006**: Repeating the same filters and continuation token returns the same set of records in 100% of tests, while those records remain unchanged.
- **SC-007**: 100% of tested history responses contain only the allow-listed record fields; no file/image content, storage paths, or other users' personal data ever appear.
- **SC-008**: Under sustained repeated requests from a single caller, excess requests are rejected once the configured threshold is exceeded, for both the self-service and admin-facing operations.
- **SC-009**: Every history request (allowed or denied) produces an audit record retrievable by a reviewer within 1 minute, with zero file/image contents stored in it.

## Assumptions

- Authentication reuses the existing signed-in session (access credential already established by the login and session features); this feature only consumes that identity and does not change how sessions are established.
- Access control reuses the existing role-and-permission model described in the RBAC feature. The transformation-history oversight permission is a new, distinct permission from the ones already used for user-directory or profile access; the Admin role is granted it by default.
- The set of recognized transformation types is file and image, and the set of recognized source/target formats matches whatever the file- and image-transformation features currently support (for example csv, json, xml, yaml for files; png, jpeg, svg for images) — this feature does not introduce new formats or transformation types of its own.
- Transformation history is already being captured by the existing file- and image-transformation features into a single, shared history store; this feature only adds read access to that existing data and does not change what is recorded at transformation time.
- Every recorded transformation is a completed attempt with a final status of success or error; there is no in-progress or partial state to expose, because transformations complete synchronously before a record is written.
- Default page size of 20 and maximum of 100 follow the same bounds already used by the project's other paginated administrative listing feature.
- History records are retained for an operationally determined period (for example 90 days) that is managed outside this feature's contract; this feature does not add an interface for configuring or purging retention, only for reading whatever history currently exists.
- Rate-limit thresholds reuse the project's existing abuse-prevention approach for privileged and data-heavy reads, with the admin-facing endpoint held to an equal or stricter limit than the self-service one.
- Audit logging for history *access* (this feature) is separate from, and in addition to, the existing recording of the transformations themselves; a best-effort audit write MUST be attempted for every request but MUST NOT block or fail the response to the caller.
- Sorting is fixed to most-recent-first; this feature does not expose a caller-selectable sort field or direction, since none was requested.
- Exporting history as a file, deleting or amending history records, and re-downloading the originally converted file from a history entry are all out of scope for this feature.
