# Feature Specification: User Profile Update

**Feature Branch**: `006-user-profile-update`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Изменение данных пользователя — Self can update own profile fields except email (requires confirmation); Admin can update any user's fields including email directly. Includes profile photo upload stored locally on the server under /assets with a generated URL saved to photo_url. Email change requires OTP or magic-link confirmation with TTL, attempt limits, and resend cooldown. All changes must be access-controlled (RBAC, IDOR-safe) and audited."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Self updates own profile fields (Priority: P1)

A signed-in user updates their own profile information (such as their profile photo) without needing to touch their email address.

**Why this priority**: This is the core, most frequent use case — most profile edits are self-service and don't involve email, so it must work reliably on its own to deliver value.

**Independent Test**: Can be fully tested by signing in as a user, submitting an update to an allowed profile field (e.g., uploading a new photo), and confirming the profile reflects the change while the email remains unchanged.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they submit a change to an allowed profile field, **Then** the profile is updated and the response reflects only the allowed fields.
2. **Given** a signed-in user, **When** they upload a new profile photo, **Then** the photo is stored on the server, a URL is generated for it, and the user's profile photo URL is updated to point to it.
3. **Given** a signed-in user, **When** they include `email` in their update request, **Then** the request is rejected and no fields are changed.
4. **Given** a signed-in user, **When** they submit a field outside the allowed set for self-updates, **Then** the request is rejected and no fields are changed.

---

### User Story 2 - Self changes email via confirmation (Priority: P2)

A signed-in user wants to change the email address associated with their account. Because email is a sensitive, security-relevant field, the change only takes effect after the user proves they control the new address.

**Why this priority**: Email changes are less frequent than general profile edits but are security-sensitive; they depend on User Story 1 existing (the update endpoint and access model) and add the confirmation workflow on top.

**Independent Test**: Can be fully tested by having a signed-in user request an email change, receiving a confirmation code or link at the new address, submitting that confirmation, and verifying the account's email is now the new address and the old email no longer works for login.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they request to change their email to an address not used by any other account, **Then** the system creates a pending change and sends a confirmation code or link to the new address.
2. **Given** a signed-in user, **When** they request to change their email to an address already used by another account, **Then** the request is rejected and no pending change is created.
3. **Given** a user with a pending email change, **When** they submit the correct confirmation code/link before it expires, **Then** their email is updated to the new address and the pending change is cleared.
4. **Given** a user with a pending email change, **When** they submit an incorrect code too many times, **Then** further attempts on that pending change are rejected.
5. **Given** a user with a pending email change, **When** the confirmation window expires before they confirm, **Then** the pending change is invalidated and they must start over.
6. **Given** a user with a pending email change, **When** they request another confirmation to be sent too soon after the previous one, **Then** the resend is rejected until the cooldown period passes.

---

### User Story 3 - Admin updates any user's profile or email directly (Priority: P2)

An administrator updates another user's profile fields, including their email address, without requiring confirmation from that user.

**Why this priority**: Administrative correction/support capability is important but used far less often than self-service edits; it reuses the same update mechanism with elevated permissions.

**Independent Test**: Can be fully tested by signing in as a user with administrative rights, updating another user's profile fields (including email), and confirming the change is applied immediately without any confirmation step.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator, **When** they update another user's allowed profile fields, **Then** the changes are applied immediately.
2. **Given** an authenticated administrator, **When** they change another user's email directly, **Then** the email is updated immediately without a confirmation step.
3. **Given** an authenticated user without administrative update rights, **When** they attempt to update another user's profile, **Then** the request is rejected and no fields are changed.

---

### Edge Cases

- What happens when a user attempts to update a profile for a `userId` that does not exist? → Request is rejected as not found.
- What happens when an unauthenticated request is made to any of these operations? → Request is rejected as unauthorized.
- What happens when the uploaded photo is not a valid image, exceeds the allowed size, or upload fails midway? → Request is rejected and the existing photo remains unchanged.
- How does the system handle a user retrying an email confirmation after it already succeeded (link/code reuse)? → The confirmation is rejected as no longer valid.
- What happens if a user has multiple pending email-change requests (e.g., initiates a second one before confirming/expiring the first)? → The newer request supersedes the prior pending request, which is invalidated.
- What happens when too many profile-update or email-change-initiation requests are made in a short period? → Requests beyond the allowed rate are rejected until the window resets.
- What happens when Self tries to change their own email through the direct admin-only email operation? → Request is rejected as forbidden.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a signed-in user ("Self") to update their own allowed profile fields, identified by their own user ID.
- **FR-002**: System MUST reject a Self profile-update request that includes the `email` field, without applying any part of the request.
- **FR-003**: System MUST reject a Self or Admin profile-update request that includes any field outside the fixed allowed set for that role, without applying any part of the request.
- **FR-004**: System MUST reject a profile-update request where the acting user is neither the target user ("Self") nor holds the required administrative permission to update other users.
- **FR-005**: System MUST validate every submitted field's value against its format and constraints before applying changes, rejecting the entire request if any field is invalid.
- **FR-006**: System MUST allow a user to upload a new profile photo as part of a self-service or admin update, store the photo on the server's local asset storage, generate an accessible URL for it, and update the user's stored photo URL to that new value.
- **FR-007**: System MUST validate uploaded photos for allowed file type and maximum size before storing them, rejecting the update if the photo is invalid.
- **FR-008**: System MUST allow Self to initiate a change of their own email address by supplying a new email address.
- **FR-009**: System MUST reject an email-change initiation when the requested new email is already associated with another account.
- **FR-010**: System MUST validate the format of the requested new email address before creating a pending change.
- **FR-011**: System, upon a valid email-change initiation, MUST create a pending email-change request with a defined expiration and send a confirmation code or link to the new email address.
- **FR-012**: System MUST allow only the requesting Self user to confirm their own pending email change.
- **FR-013**: System MUST update the user's email to the new address only after the confirmation code or link is successfully verified, and MUST invalidate the pending request immediately afterward (single use).
- **FR-014**: System MUST reject confirmation attempts that use an incorrect code/token, a code/token that has expired, or a code/token that no longer corresponds to an active pending request.
- **FR-015**: System MUST limit the number of incorrect confirmation attempts allowed per pending email-change request and reject further attempts once that limit is reached.
- **FR-016**: System MUST enforce a minimum cooldown period between successive requests to resend a confirmation for the same pending email change.
- **FR-017**: System MUST invalidate any prior pending email-change request for a user when a new one is initiated, so at most one pending request is active at a time.
- **FR-018**: System MUST allow an Admin (holding the required administrative permission) to update another user's email address directly, without requiring confirmation from that user.
- **FR-019**: System MUST reject a Self attempt to use the admin-only direct email-update operation on their own or any account.
- **FR-020**: System MUST record an audit entry for every profile update, email-change initiation, confirmation, failure, and expiration event, capturing who performed the action, which user was affected, which field names were involved (never field values), and the outcome.
- **FR-021**: System MUST apply rate limiting to profile-update requests and to email-change initiation/resend requests to prevent abuse.
- **FR-022**: System MUST apply all field-level access rules on a default-deny basis: any field not explicitly included in the allowed set for the acting role's operation MUST be rejected rather than silently ignored or applied.
- **FR-023**: System MUST return the updated profile (containing only fields the caller is permitted to see) after a successful update.

- **FR-024**: The general profile-update operation's allowed field set is limited to the profile photo for both Self and Admin; no other profile attributes (e.g., display name, phone, bio) are introduced by this feature. Email is handled separately (via confirmation for Self, directly for Admin) and is never part of the general update's allowed set for Self. Account status and role assignments are out of scope for this feature and are not editable through it.

### Key Entities *(include if feature involves data)*

- **User Profile**: The set of user-owned attributes that can change through this feature — the profile photo URL, plus the email address, which changes through either the confirmation flow (Self) or a direct operation (Admin).
- **Profile Photo**: A user-uploaded image file, stored on server-local asset storage, represented by a generated, publicly resolvable URL that is stored on the user's profile.
- **Pending Email Change**: A time-limited request representing a user's intent to change their email address, holding the requested new email, an expiration time, a remaining-attempts counter, and a confirmation code/token; superseded or invalidated once confirmed, expired, or replaced by a newer request.
- **Audit Log Entry**: A record of who performed an action, on which target user, which field names were affected, the type of action (profile update, email-change initiated/sent/confirmed/failed/expired), and the outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can successfully update an allowed profile field and see the change reflected in their profile immediately after the request completes.
- **SC-002**: A user can upload a new profile photo and see it associated with their profile within the same update request, with no manual follow-up step.
- **SC-003**: 100% of attempts by a user to change their own email directly (bypassing confirmation) are blocked.
- **SC-004**: 100% of attempts by a non-administrator to update another user's profile are blocked.
- **SC-005**: At least 95% of legitimate email-change confirmations submitted within the expiration window and attempt limit succeed on the first correct attempt.
- **SC-006**: 100% of email-change confirmation attempts using an expired, already-used, or incorrect code/token are rejected.
- **SC-007**: Every profile update and every email-change lifecycle event (initiated, sent, confirmed, failed, expired) produces a corresponding audit entry with no field values leaked into logs.
- **SC-008**: Administrators can update another user's email directly, with the change visible immediately and without any confirmation step being required.

## Assumptions

- The confirmation method for email changes defaults to a one-time code (OTP) unless the request specifies a magic link; the exact channel selection logic is a server-side default and not user-configurable per request beyond this choice.
- Default operational parameters (subject to configuration, not user-facing): confirmation code/link TTL of 10 minutes, maximum of 5 incorrect confirmation attempts per pending request, and a 60-second minimum cooldown between resend requests.
- "Occupied" for a requested new email means it is already the current, confirmed email of another account; addresses only present in another user's own pending, unconfirmed email-change request are not treated as blocking.
- Profile photo uploads are limited to common raster image formats (e.g., JPEG, PNG, WebP) and a maximum file size consistent with typical avatar-upload limits (e.g., a few megabytes); exact limits are a configuration detail, not a scope-defining decision.
- A user's previous profile photo is replaced (not retained as history) when a new one is uploaded.
- Only one administrative permission tier is assumed for this feature ("can update any user"); more granular per-field administrative permissions are out of scope unless later specified.
- Rate-limit thresholds for profile updates and email-change requests follow the same general abuse-prevention approach already used elsewhere in the system, rather than introducing a new distinct policy.
- The photo's generated URL is resolvable by clients without requiring separate authentication, consistent with how other static assets are served.
