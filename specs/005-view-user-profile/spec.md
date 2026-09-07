# Feature Specification: View User Profile

**Feature Branch**: `005-view-user-profile`

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "Просмотр данных пользователя — показать профиль пользователя по правилам доступа. Self просматривает свой профиль; роль с правом `users.read` может просматривать чужой профиль, но только разрешённые поля; без права — 403. Контракт: GET /users/{userId}, вход userId + access JWT (cookie), выход id/email/photo/fields (только разрешённые), ответы 200/401/403/404. Требуется default-deny фильтрация полей, rate limit на чтение профилей, защита от IDOR, опциональный аудит просмотров."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View my own profile (Priority: P1)

An authenticated user requests their own profile and receives their full profile data, without needing any special permission.

**Why this priority**: Viewing one's own data is the most common and essential case; it must work independently of any RBAC configuration.

**Independent Test**: Log in as a user with no special permissions, request the profile for the logged-in user's own ID, and verify the full self-profile data is returned.

**Acceptance Scenarios**:

1. **Given** an authenticated user with a valid session, **When** they request the profile for their own user ID, **Then** they receive a 200 response containing their profile data, including `id`, `email`, and `photo`.
2. **Given** an authenticated user, **When** they request their own profile, **Then** the response is returned regardless of whether the user holds the `users.read` permission.

---

### User Story 2 - Privileged viewing of another user's profile (Priority: P1)

An authenticated user holding the `users.read` permission requests another user's profile and receives only the subset of profile fields their role is allowed to see.

**Why this priority**: This is the core access-control behavior distinguishing this feature from simple self-service profile viewing, and it directly governs what sensitive data support/admin roles can see about others.

**Independent Test**: Log in as a user holding `users.read`, request another existing user's profile, and verify the response contains only the fields designated as visible to that role — no additional fields.

**Acceptance Scenarios**:

1. **Given** an authenticated user holding the `users.read` permission, **When** they request another existing user's profile, **Then** they receive a 200 response containing only the fields allowed for privileged viewing.
2. **Given** an authenticated user holding `users.read`, **When** the requested user exists, **Then** the response never includes fields outside the allowed set, even if the target profile has additional data.

---

### User Story 3 - Deny access without permission (Priority: P1)

An authenticated user without the `users.read` permission attempts to view another user's profile and is denied.

**Why this priority**: This is the primary security boundary of the feature (prevents IDOR-style access to other users' data) and must hold even when other stories are only partially implemented.

**Independent Test**: Log in as a user without `users.read`, request a profile belonging to a different user ID, and verify a 403 response with no profile data returned.

**Acceptance Scenarios**:

1. **Given** an authenticated user without the `users.read` permission, **When** they request a profile belonging to a different user ID, **Then** they receive a 403 response and no profile fields are disclosed.
2. **Given** an authenticated user without `users.read`, **When** they request a profile belonging to a different, non-existent user ID, **Then** they receive a 403 response rather than a 404 (existence of other accounts is not disclosed to unauthorized viewers).

---

### User Story 4 - Handle unauthenticated and not-found cases (Priority: P2)

A request without a valid session, or for a user ID that does not exist (when the viewer is authorized to know that), is rejected with the appropriate status.

**Why this priority**: Correct handling of edge-of-flow cases (auth and existence) rounds out the contract but depends on the core access decision (Stories 1–3) already being correct.

**Independent Test**: Send a request with no/invalid access token and verify 401; send a request as an authorized viewer (self or `users.read` holder) for a non-existent user ID and verify 404.

**Acceptance Scenarios**:

1. **Given** a request with no access token or an invalid/expired one, **When** any profile is requested, **Then** the response is 401 and no profile data is returned.
2. **Given** an authenticated user requesting their own profile, **When** that user's account no longer exists (e.g., deleted mid-session), **Then** the response is 404.
3. **Given** an authenticated user holding `users.read` requesting a profile by an ID that does not correspond to any user, **When** the request is made, **Then** the response is 404.

---

### User Story 5 - Audit profile views (Priority: P3)

The system optionally records who viewed which profile and the outcome, to support later security review.

**Why this priority**: Useful for compliance and detecting abuse of privileged access, but not required for the feature's core access-control behavior to function correctly.

**Independent Test**: Perform a self view, a privileged view, and a denied attempt; verify each produces an audit record containing the viewer's ID, the target's ID, and the outcome.

**Acceptance Scenarios**:

1. **Given** any profile view request (self, privileged, or denied), **When** the request completes, **Then** an audit record is created containing the viewer's user ID, the target user ID, and the result (200, 403, or 404).
2. **Given** audit records exist, **When** they are inspected, **Then** they never include the profile field values themselves — only the identifiers and outcome.

---

### Edge Cases

- What happens when a user holding `users.read` requests their own profile via the same endpoint? They receive the full self-profile (Story 1 behavior), not the restricted privileged-view field set.
- What happens when repeated profile-read requests exceed the configured rate limit? The system rejects further requests with a rate-limit response until the limit window resets, independent of whether the target is self or another user.
- What happens when the `userId` path value is not a validity-checkable identifier (malformed)? The system treats it as not found and responds consistently with the not-found case, without revealing whether the format itself was the problem.
- What happens when a user's permissions change (e.g., `users.read` revoked) between login and the request? The access decision uses the user's current, up-to-date permissions at request time, not permissions cached at login.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an authenticated user to retrieve their own profile by their own user ID, returning their full self-profile data.
- **FR-002**: System MUST allow an authenticated user holding the `users.read` permission to retrieve another user's profile, returning only the fields designated as visible for privileged viewing.
- **FR-003**: System MUST deny access (403) when an authenticated user without the `users.read` permission requests a profile other than their own, without disclosing whether the target user exists.
- **FR-004**: System MUST reject requests lacking a valid authenticated session with a 401 response, before evaluating any access or existence rules.
- **FR-005**: System MUST return 404 when the requesting flow is authorized to view the target (self, or `users.read` holder) but the target user does not exist.
- **FR-006**: System MUST apply default-deny field filtering: any profile field not explicitly designated as visible for the viewer's access level (self vs. privileged) MUST be omitted from the response.
- **FR-007**: System MUST apply a rate limit to profile-read requests to mitigate enumeration and scraping of user data.
- **FR-008**: System MUST prevent horizontal privilege escalation (IDOR): a user without `users.read` MUST NOT be able to retrieve any profile data for a user ID other than their own, regardless of how the ID is supplied.
- **FR-009**: System MUST evaluate the requester's current permissions at request time, not permissions established earlier in the session.
- **FR-010**: System SHOULD record an audit entry for each profile view attempt, capturing the viewer's ID, the target's ID, and the outcome, without including the returned field values.
- **FR-011**: System MUST define the profile field allow-list per access level: the self view MUST include the full profile (`id`, `email`, `photo`, plus other profile fields); the privileged view (a viewer holding `users.read` requesting another user's profile) MUST include only `id` and `photo` — `email` and all other profile fields MUST be omitted from the privileged view.

### Key Entities

- **User Profile**: The viewable representation of a user, keyed by `id`. Includes attributes such as `email` and `photo`, plus other profile fields whose visibility depends on the viewer's access level relative to the profile owner.
- **Profile Field Visibility Policy**: A configuration mapping viewer access level (self, or a role holding `users.read`) to the set of profile fields that may be included in the response for that level.
- **Profile View Audit Record**: An optional log entry capturing viewer ID, target ID, and result (allowed/denied/not-found) for a profile view attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of profile requests for a user's own ID succeed and return that user's full profile data, independent of the requester's assigned roles.
- **SC-002**: 100% of profile requests for another user's ID by a viewer lacking `users.read` are denied, with zero profile fields disclosed in the response.
- **SC-003**: 100% of profile responses to privileged viewers contain only fields on the approved visibility list for their role — zero occurrences of unapproved fields appearing in a response during testing.
- **SC-004**: Unauthenticated requests are rejected in 100% of cases before any user-existence or profile data is evaluated.
- **SC-005**: Under sustained repeated requests from a single client, the system begins rejecting excess profile-read requests once the configured threshold is exceeded, in 100% of tested overflow scenarios.

## Assumptions

- The `users.read` permission and its RBAC evaluation mechanism already exist (as established by the RBAC feature) and can be checked per request.
- Authentication uses the existing access JWT delivered via cookie (as established by the session/JWT auth features); this feature only consumes that identity, it does not change authentication.
- "Photo" in the profile response is represented as a URL reference regardless of whether the underlying storage is a file store or an external location; the mechanics of photo storage are out of scope for this feature.
- Rate limiting reuses the project's existing throttling mechanism and standard abuse-prevention thresholds already applied to other authenticated endpoints, unless a stricter limit is later specified for privileged (other-user) lookups.
- Malformed or non-existent `userId` values are treated the same as "not found" for viewers authorized to see that outcome, to avoid leaking information through error-type differences.
- Audit logging of profile views (Story 5) is optional/best-effort and does not block the response if logging fails.
