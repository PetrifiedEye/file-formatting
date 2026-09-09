# Feature Specification: Delete User Account

**Feature Branch**: `008-delete-user-account`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Delete user — Self can request deletion of their own account (with email confirmation, similar to other confirmation flows); Admin can delete any user's account directly. Deletion revokes access (no further login), removes the user's personal data (PII) and owned files (e.g. profile photo), and handles related records. Access control must prevent deleting someone else's account without the right permission (403). Operations must be idempotent, rate-limited, and audited (actor, target, self/admin, outcome) without logging the deleted PII itself."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Self deletes own account (Priority: P1)

A signed-in user decides to close their account. Because account deletion is irreversible and security-sensitive, the user must confirm the request via a code or link sent to their own email before the account is actually deleted. Once deletion completes, the user can no longer sign in.

**Why this priority**: This is the core, most frequent use case for this feature — users exercising control over their own data — and it must work reliably and safely on its own to deliver value.

**Independent Test**: Can be fully tested by signing in as a user, requesting account deletion, confirming via the emailed code/link, and verifying the account can no longer authenticate and the user's personal data is gone.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they request deletion of their own account, **Then** the system sends a confirmation code or link to their registered email and does not yet delete anything.
2. **Given** a user with a pending self-deletion confirmation, **When** they submit the correct confirmation before it expires, **Then** their account access is revoked, their personal data and owned files are deleted, and they can no longer sign in.
3. **Given** a signed-in user, **When** they attempt to delete their account without completing the email confirmation step, **Then** the deletion is rejected and the account remains active.
4. **Given** a user with a pending self-deletion confirmation, **When** the confirmation window expires before they confirm, **Then** the pending request is invalidated and the account remains active.

---

### User Story 2 - Admin deletes a user's account (Priority: P2)

An administrator removes another user's account directly — for example in response to a support request, policy violation, or offboarding — without requiring confirmation from that user.

**Why this priority**: Administrative account removal is an important operational capability but used far less often than self-service deletion; it reuses the same deletion mechanism with elevated permissions and no confirmation step.

**Independent Test**: Can be fully tested by signing in as a user with administrative deletion rights, deleting another user's account, and confirming that account can no longer authenticate and its personal data is gone, with no confirmation step required.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator with account-deletion rights, **When** they delete another user's account, **Then** that account's access is revoked and its personal data and owned files are deleted immediately, without any email confirmation step.
2. **Given** an authenticated administrator, **When** they delete an already-deleted account, **Then** the system reports the account as already removed without error or side effects.

---

### User Story 3 - Deletion is blocked without the right permission (Priority: P2)

A signed-in user without administrative rights attempts to delete another user's account. The system must refuse the request and leave the target account untouched.

**Why this priority**: This is the primary safeguard against unauthorized data loss (IDOR) and must hold for the feature to be trustworthy, though it only matters once the deletion capability itself exists.

**Independent Test**: Can be fully tested by signing in as a non-administrative user, attempting to delete a different user's account, and confirming the request is rejected and the target account is unaffected.

**Acceptance Scenarios**:

1. **Given** a signed-in user without account-deletion rights, **When** they attempt to delete another user's account, **Then** the request is rejected and the target account remains fully active.
2. **Given** a signed-in user without account-deletion rights, **When** they attempt to delete their own account without going through the confirmation flow, **Then** the direct deletion is rejected (self-deletion always requires confirmation, regardless of any elevated rights the user may separately hold).

---

### Edge Cases

- What happens when a deletion request targets a user id that never existed (an invalid identifier)? The request should be reported as not found.
- What happens when a deletion request targets a user who has already been fully removed by a prior deletion? The request should be reported as already removed, without error — see FR-010.
- What happens when a second deletion request (self or admin) arrives for an account that is currently mid-deletion? The system should report a conflict rather than starting a duplicate deletion or corrupting state.
- What happens when a user submits many deletion or confirmation requests in quick succession? The system should throttle these attempts to limit abuse.
- What happens when a self-deletion confirmation code is submitted incorrectly multiple times? Further attempts on that pending request should be rejected, matching the pattern used for other email-confirmation flows.
- What happens to content or records the user created that are shared with or visible to others (e.g., anything referencing the user as an author or actor)? These related records must be handled so the system remains consistent — either removed, or kept with personal identifiers detached — rather than left pointing at a nonexistent account.
- What happens if a user has an active session at the moment their account is deleted (by themselves or an admin)? Any subsequent request relying on that account must be treated as unauthenticated/forbidden.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a signed-in user to request deletion of their own account.
- **FR-002**: System MUST require the requesting user to confirm self-deletion via a code or link sent to their own registered email before any data is deleted; a self-deletion request with no valid confirmation MUST NOT delete anything.
- **FR-003**: The self-deletion confirmation MUST expire after a limited time window and MUST support a limited number of incorrect attempts, consistent with the confirmation mechanism used elsewhere in the system.
- **FR-004**: System MUST allow a user holding account-deletion rights (administrator) to delete any other user's account directly, without requiring email confirmation from the target user.
- **FR-005**: System MUST reject a deletion request made against another user's account by a user who does not hold account-deletion rights, and MUST leave the target account unaffected.
- **FR-006**: System MUST reject any deletion or delete-confirmation request made by a user who is not authenticated.
- **FR-007**: Upon completed deletion, the system MUST immediately and permanently prevent the deleted account from authenticating again.
- **FR-008**: Upon completed deletion, the system MUST remove the user's personal data (e.g., contact/profile information) and any files the user owns (e.g., profile photo).
- **FR-009**: System MUST handle records related to the deleted user (e.g., audit history, entities referencing the user) so no remaining data references a nonexistent account in a way that breaks the system; where such related records must be retained for legal, audit, or referential-integrity reasons, they MUST NOT retain the deleted personal data itself.
- **FR-010**: System MUST treat repeated deletion requests for the same account idempotently — retrying a deletion (self or admin) that has already completed MUST report the account as already removed rather than erroring or repeating the deletion.
- **FR-011**: System MUST reject a new deletion request for an account that is currently in the middle of being deleted, reporting a conflict rather than starting a second, overlapping deletion.
- **FR-012**: System MUST report a not-found outcome when a deletion request targets a user account that does not exist.
- **FR-013**: System MUST limit the rate of deletion requests and deletion-confirmation attempts per user/account to reduce abuse.
- **FR-014**: System MUST record an audit entry for every deletion attempt, capturing the acting user, the target user, whether the operation was self- or admin-initiated, and the outcome (success or failure) — without recording the personal data values that were deleted.

### Key Entities

- **User Account**: The record being removed; includes personal/profile data (e.g., email, profile photo) and account status. After deletion, it must no longer be usable for authentication.
- **Deletion Confirmation Request**: A short-lived, single-use challenge tied to a self-deletion request, sent to the user's registered email, used to prove the account owner authorized the deletion.
- **Deletion Audit Entry**: A record of who performed a deletion attempt, on which target account, whether it was self- or admin-initiated, and the result — without the deleted personal data itself.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can fully complete self-deletion of their own account, from request to confirmation, in under 3 minutes under normal conditions.
- **SC-002**: 100% of attempts to delete another user's account by a user without the right permission are rejected, with the target account verified unaffected afterward.
- **SC-003**: 100% of completed deletions result in the account being immediately unable to authenticate on the very next login attempt.
- **SC-004**: Retrying a deletion request against an already-deleted account never produces an error or a duplicate deletion attempt — it is reported as already removed in 100% of cases.
- **SC-005**: Every deletion attempt (successful or not) is traceable afterward to an actor, a target, and an outcome, with zero instances of deleted personal data values appearing in that trail.

## Assumptions

- Self-deletion confirmation reuses the same style of emailed code/link, expiry window, attempt limit, and resend cooldown already established for other sensitive account changes (e.g., email change) in this system.
- "Delete" means the user's personal data and owned files are irreversibly removed and the account can never authenticate again; it does not mean a reversible "soft close" or a temporary suspension that the user or an admin can later undo. Reactivation is out of scope for this feature.
- Related records that reference the user (e.g., historical audit logs, content authored by the user) are preserved for integrity/audit purposes but with personal data detached or anonymized, rather than being cascade-deleted wholesale — except where a record's entire purpose is personal to the user (e.g., their own profile), which is fully removed.
- Deletion rights for administrators are granted through the system's existing role/permission model, as a distinct permission from other user-management permissions (e.g., read, update).
- No separate "download my data" export step is included in this feature; it is limited to the deletion request, confirmation, and removal flow.
- A brief in-progress "deleting" state may exist only transiently while a single deletion is being processed, solely to detect and reject overlapping duplicate requests — it is not a long-running asynchronous job queue.
