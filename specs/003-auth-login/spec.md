# Feature Specification: User Login & Session Authentication

**Feature Branch**: `003-auth-login`

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "I want to implement full working authentication according to the missing points from Аутентификация: проверка реализации" — a status review that found registration, email confirmation, and password hashing already implemented, but login, session/token issuance, login-time email verification, brute-force protection, generic error handling, password recovery, and route protection all missing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log In With Email and Password (Priority: P1)

A registered user enters their email and password to access their account. If the credentials are correct and no additional verification is required, they are signed in immediately and can use the application as an authenticated user.

**Why this priority**: Without a working login, none of the previously built registration and account infrastructure can actually be used. This is the minimum viable authentication capability.

**Independent Test**: Can be fully tested by registering a user, then submitting their email and password to the login flow, and confirming the user is granted an authenticated session and can access an account-only action.

**Acceptance Scenarios**:

1. **Given** a registered user with a confirmed account and correct password, **When** they submit their email and password, **Then** they are signed in and issued an authenticated session.
2. **Given** a registered user, **When** they submit an incorrect password, **Then** they see a generic "invalid credentials" message and are not signed in.
3. **Given** no account exists for a submitted email, **When** login is attempted, **Then** the user sees the same generic "invalid credentials" message as a wrong password (no indication the email is unregistered).
4. **Given** a signed-in user, **When** they choose to log out, **Then** their session is invalidated and they can no longer access account-only actions with it.

---

### User Story 2 - Additional Email Verification at Login (Priority: P2)

When the system is configured to require extra verification at sign-in, a user who enters the correct password must also confirm their identity via a one-time code or link sent to their email before the login completes.

**Why this priority**: This builds directly on the existing system setting for sign-in confirmation and the email-confirmation mechanism already built for registration, extending it to protect logins as originally intended.

**Independent Test**: Can be fully tested by enabling the sign-in confirmation setting, logging in with correct credentials, and confirming that the session is only granted after the emailed code or link is verified — not before.

**Acceptance Scenarios**:

1. **Given** sign-in confirmation is enabled and a user submits correct credentials, **When** the password is verified, **Then** the system sends a one-time code and/or link to the user's email and withholds the session until it is confirmed.
2. **Given** a pending login verification, **When** the user submits the correct code (or follows the link) within its validity window, **Then** the login completes and a session is issued.
3. **Given** a pending login verification, **When** the code expires or the maximum number of incorrect attempts is reached, **Then** the login attempt is rejected and the user must start over.
4. **Given** sign-in confirmation is disabled, **When** a user submits correct credentials, **Then** the login completes immediately without an extra verification step.

---

### User Story 3 - Protection Against Credential Guessing (Priority: P3)

The system detects repeated failed login attempts against an account or from a source and slows down or blocks further attempts, so attackers cannot brute-force passwords, while every attempt is recorded for later review.

**Why this priority**: Without this, a working login endpoint is directly exposed to automated password-guessing attacks. It depends on login existing (Story 1) but is essential before the feature is safe to expose publicly.

**Independent Test**: Can be fully tested by submitting repeated incorrect passwords for the same account and confirming that further attempts are throttled or the account is temporarily locked, and that each attempt appears in the audit log.

**Acceptance Scenarios**:

1. **Given** repeated failed login attempts for the same account within a short window, **When** the configured attempt limit is reached, **Then** further login attempts for that account are temporarily blocked, with a generic message that does not reveal lockout mechanics to an attacker.
2. **Given** an account is temporarily locked due to failed attempts, **When** the lockout period elapses, **Then** the user can attempt to log in again normally.
3. **Given** any login attempt (successful, failed, or blocked by lockout), **When** it occurs, **Then** it is recorded in the audit log with outcome and reason, consistent with existing registration audit logging.

---

### User Story 4 - Recover a Forgotten Password (Priority: P4)

A user who cannot remember their password requests a password reset, receives a time-limited code or link by email, and uses it to set a new password and regain access to their account.

**Why this priority**: Important for real-world usability once login exists, since users will inevitably forget passwords, but it is not required for the core login path to function.

**Independent Test**: Can be fully tested by requesting a password reset for a known account, confirming the email code/link, submitting a new password, and then successfully logging in with the new password (and confirming the old password no longer works).

**Acceptance Scenarios**:

1. **Given** a registered email address, **When** the user requests a password reset, **Then** the system sends a time-limited one-time code and/or link to that email, and responds the same way regardless of whether the email is registered (no enumeration).
2. **Given** a valid, unexpired reset code or link, **When** the user submits it along with a new password meeting the existing password policy, **Then** the password is updated and the user can log in with the new password.
3. **Given** an expired or already-used reset code/link, **When** the user attempts to use it, **Then** the reset is rejected with a clear, generic error and no password change occurs.
4. **Given** a completed password reset, **When** the reset finishes, **Then** the old password no longer grants access.

---

### User Story 5 - Access Restricted to Authenticated Users (Priority: P5)

Endpoints and actions that are only meant for signed-in users reject requests that do not carry a valid, current session, so account data and account-only actions cannot be accessed anonymously or with an expired/invalidated session.

**Why this priority**: This is what makes login meaningful beyond the login endpoint itself — it depends on Story 1 (session issuance) and closes the loop so the rest of the application can rely on "the user is authenticated."

**Independent Test**: Can be fully tested by calling an account-only action without a session (expect rejection), with a valid session (expect success), and with an expired or logged-out session (expect rejection).

**Acceptance Scenarios**:

1. **Given** no session or an invalid session, **When** a protected action is requested, **Then** the request is rejected without performing the action.
2. **Given** a valid, current session, **When** a protected action is requested, **Then** the request proceeds as that authenticated user.
3. **Given** a session that has expired or been invalidated (e.g., by logout or password reset), **When** it is used for a protected action, **Then** the request is rejected.

---

### Edge Cases

- What happens when a user requests a password reset while a previous, still-valid reset code/link for the same account is outstanding?
- What happens when a user changes their password while other sessions/devices are still logged in?
- How does the system respond if the same email address receives many password-reset or login-verification requests in a short time (abuse of the email-sending mechanism itself)?
- What happens if a user submits the login-verification code correctly but the underlying login attempt has since expired?
- How does the system behave if a user's account is deactivated or removed between issuing a session and that session being used?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a way for a registered user to log in using their email and password.
- **FR-002**: System MUST verify submitted credentials against the stored account record and reject the attempt if the email is unknown or the password does not match.
- **FR-003**: System MUST return the same generic "invalid credentials" outcome whether the email does not exist or the password is wrong, so login failures do not reveal which registered emails exist.
- **FR-004**: System MUST issue the user an authenticated session/token immediately upon successful credential verification when no additional verification step is configured.
- **FR-005**: System MUST support a configurable sign-in verification step: when enabled, after credentials are verified the system MUST send a one-time code and/or link to the user's email and MUST NOT issue a session until that code/link is successfully confirmed, reusing the same expiration and attempt-limit behavior already established for registration confirmation.
- **FR-006**: System MUST allow an authenticated user to log out, invalidating their current session/token so it can no longer be used for authenticated actions.
- **FR-007**: System MUST track failed login attempts and apply rate limiting to the login, login-verification, and password-recovery endpoints to slow down automated abuse.
- **FR-008**: System MUST temporarily lock an account after 5 consecutive failed login attempts, for a lockout duration of 15 minutes, after which normal login attempts are allowed again.
- **FR-009**: System MUST record an audit log entry for every login attempt (success, failure, and lockout-blocked), including outcome and reason, consistent with the existing registration audit logging.
- **FR-010**: System MUST allow a user to request a password reset by submitting their email address, and MUST respond the same way regardless of whether that email is registered.
- **FR-011**: System MUST send a time-limited one-time code and/or link to the user's email for password reset requests, and MUST require it to be verified before a new password can be set.
- **FR-012**: System MUST enforce the existing password policy (length, character composition) when a user sets a new password during recovery.
- **FR-013**: System MUST invalidate the used password-reset code/link after a successful reset (or upon expiry), preventing reuse.
- **FR-014**: System MUST restrict access to authenticated-only actions and data to requests carrying a valid, unexpired, non-invalidated session/token; unauthenticated or invalid requests MUST be rejected without performing the requested action.
- **FR-015**: System MUST expire authenticated sessions/tokens after a bounded lifetime, and a successful password reset MUST invalidate all of that user's other active sessions/tokens, requiring a fresh login everywhere else.
- **FR-016**: System MUST reject login attempts for accounts whose registration email has not yet been confirmed, returning a clear message directing the user to confirm their email (with the option to resend the confirmation) rather than issuing a session.

### Key Entities *(include if feature involves data)*

- **Authenticated Session**: Represents a successfully logged-in user's access to the system; has an issuing time, an expiration, an owning user, and a validity state (active, expired, or invalidated by logout/reset).
- **Pending Login Verification**: Represents a login attempt that has passed password verification but is awaiting confirmation of a one-time code or link sent to the user's email, analogous to the existing registration confirmation challenge; has an expiration and a limited number of confirmation attempts.
- **Login Attempt Record**: Represents one login attempt (successful, failed, or lockout-blocked) for audit and lockout-tracking purposes; includes the account/email targeted, outcome, reason, and timestamp.
- **Password Reset Request**: Represents a user's request to reset a forgotten password; has an associated one-time code and/or link, an expiration, a used/unused state, and the target account.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with correct credentials and no pending verification requirement can complete login and reach an authenticated state in under 5 seconds under normal conditions.
- **SC-002**: 100% of failed login attempts (wrong password or unknown email) return an indistinguishable, generic error message.
- **SC-003**: 100% of login attempts (successful, failed, and lockout-blocked) are captured in the audit trail with a determinable outcome.
- **SC-004**: Sustained automated password-guessing against a single account is stopped by rate limiting or lockout within the configured attempt threshold, rather than allowing unlimited attempts.
- **SC-005**: A user who forgets their password can regain account access using only the self-service recovery flow, without contacting support, in under 10 minutes end-to-end.
- **SC-006**: 100% of requests to authenticated-only actions without a valid session are rejected, and 0% of such requests succeed.
- **SC-007**: After a user logs out or successfully resets their password, the previously issued session can no longer be used to perform authenticated actions.

## Assumptions

- The email-confirmation mechanisms (one-time code and magic link, with their existing expirations and attempt limits) already built for registration will be reused for both login verification and password-reset verification, rather than building a separate mechanism.
- The existing password policy (minimum length, character composition rules) built for registration applies unchanged to passwords set via recovery.
- Session/token lifetime, refresh behavior, and exact rate-limit thresholds for login and recovery will mirror the conservative defaults already used for registration (e.g., similar per-minute request caps) unless specified otherwise during planning.
- Existing user accounts, password hashes, and audit-logging infrastructure will be reused as-is; this feature does not change how accounts are created.
- Password recovery is available only to users who know their own registered email address; it does not cover account recovery when the email itself is lost or inaccessible.
