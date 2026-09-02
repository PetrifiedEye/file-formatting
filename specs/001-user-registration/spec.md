# Feature Specification: User Registration

**Feature Branch**: `001-user-registration`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Регистрация — создать аккаунт пользователя по email+паролю. Гость вводит email и пароль. Администратор может включать/выключать подтверждение через email отдельно для регистрации, восстановления пароля и входа. Два сценария: регистрация без подтверждения (аккаунт сразу готов к входу) и регистрация с подтверждением (OTP-код или magic link). Повторная регистрация на существующий email запрещена. Аудит попыток, защита от спама и перебора."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register without email confirmation (Priority: P1)

A guest (not signed in) submits a valid email and password while the administrator has **disabled** email confirmation for registration. The product creates an account for that email. The guest can immediately sign in with those credentials. No confirmation email is sent.

**Why this priority**: This is the core value of the feature — a guest becomes a user. It is a complete, shippable path even if confirmation is never enabled.

**Independent Test**: With registration confirmation turned off, submit a new email and valid password; verify an account exists and sign-in with those credentials succeeds. Repeat with an already used email and verify a second account is not created.

**Acceptance Scenarios**:

1. **Given** registration confirmation is disabled and the email is not associated with an existing account, **When** the guest submits a valid email and password, **Then** an account is created and the guest can sign in with those credentials.
2. **Given** registration confirmation is disabled, **When** the guest submits an invalid email format, **Then** the account is not created and the guest is told the email is invalid.
3. **Given** registration confirmation is disabled, **When** the guest omits the password or the password does not meet the password policy, **Then** the account is not created and the guest is told the password is invalid (without revealing whether the email is already in use).
4. **Given** registration confirmation is disabled and an account already exists for the email, **When** the guest submits that email and a password, **Then** a second account is not created and the guest receives a message that does not confirm whether the email is already registered.
5. **Given** a successful registration without confirmation, **When** the guest proceeds to sign in, **Then** they are not asked to confirm the email as part of completing registration.

---

### User Story 2 - Register with email confirmation (Priority: P2)

A guest submits a valid email and password while the administrator has **enabled** email confirmation for registration. The product does **not** grant a sign-in-ready account yet. The guest is told that confirmation is required. The product sends a confirmation email that contains both a one-time numeric code (OTP) and a confirmation link (magic link). Until confirmation succeeds, sign-in with those credentials is refused.

**Why this priority**: Confirmation is an administrator-controlled option for the same registration capability. It is independently valuable but not required for an MVP if the confirmation flag stays off.

**Independent Test**: With registration confirmation turned on, submit a new email and valid password; verify the guest cannot sign in yet, a confirmation email is sent, and completing confirmation (next stories) is possible. Existing accounts still cannot be duplicated.

**Acceptance Scenarios**:

1. **Given** registration confirmation is enabled and the email is not associated with an existing usable account, **When** the guest submits a valid email and password, **Then** the product records a registration awaiting confirmation, tells the guest that email confirmation is required, and sends a confirmation email.
2. **Given** registration confirmation is enabled and a registration is awaiting confirmation, **When** the guest tries to sign in with the submitted credentials, **Then** sign-in is refused until confirmation succeeds.
3. **Given** registration confirmation is enabled, **When** the guest submits invalid email or password, **Then** no registration is recorded, no confirmation email is sent, and the guest sees the corresponding validation message.
4. **Given** registration confirmation is enabled and a usable account already exists for the email, **When** the guest submits that email, **Then** a second account is not created and the client-facing outcome does not confirm that the email is already registered.
5. **Given** registration confirmation is disabled, **When** a guest tries to start or complete email confirmation for registration, **Then** confirmation is not performed (confirmation applies only when the registration flag is on).

---

### User Story 3 - Confirm registration with a one-time code (Priority: P3)

After a confirmation email is sent, the guest enters the 6-digit code from the email. On a correct, unexpired code within the attempt limit, the account becomes usable and the guest can sign in. Wrong, expired, or over-limit codes do not activate the account.

**Why this priority**: Completes the optional confirmation path for guests who prefer entering a code rather than opening a link.

**Independent Test**: Start a confirmation-required registration, enter the correct code, and verify the account can sign in. Separately, enter wrong and expired codes and verify the account stays unusable.

**Acceptance Scenarios**:

1. **Given** a registration awaiting confirmation and a valid unexpired code, **When** the guest submits that code (within 5 attempts), **Then** the account becomes usable and the guest can sign in with the registered credentials.
2. **Given** a registration awaiting confirmation, **When** the guest submits an incorrect code, **Then** the account stays unusable, the remaining attempt count decreases, and the guest is told the code is invalid.
3. **Given** a registration awaiting confirmation whose code is older than 10 minutes, **When** the guest submits that code, **Then** confirmation fails and the account stays unusable.
4. **Given** 5 incorrect code submissions for the same confirmation, **When** the guest submits another code, **Then** confirmation is rejected until a new code is requested; the account stays unusable.
5. **Given** a registration that has already been confirmed, **When** the guest submits the old code, **Then** the product does not create another account and does not re-open confirmation.

---

### User Story 4 - Confirm registration with an email link (Priority: P3)

After a confirmation email is sent, the guest opens the confirmation link. If the link is valid and unexpired, the account becomes usable. If the link is invalid, expired, or already used, the account is not activated and the guest is told confirmation failed.

**Why this priority**: Completes the optional confirmation path for guests who confirm by following the email link. Same outcome as the code path; either method is sufficient.

**Independent Test**: Start a confirmation-required registration, open the valid link, and verify the account can sign in. Open an expired or already-used link and verify the account is not activated.

**Acceptance Scenarios**:

1. **Given** a registration awaiting confirmation and a valid unexpired confirmation link, **When** the guest opens that link, **Then** the account becomes usable and the guest can sign in.
2. **Given** a confirmation link older than 10 minutes, **When** the guest opens it, **Then** confirmation fails and the account stays unusable.
3. **Given** a confirmation link that was already used successfully, **When** the guest opens it again, **Then** the product does not change the already-usable account and does not treat it as a new registration.
4. **Given** an invalid or tampered confirmation link, **When** the guest opens it, **Then** confirmation fails and no account is activated.

---

### User Story 5 - Resend registration confirmation (Priority: P4)

A guest whose registration is still awaiting confirmation can request that the confirmation email be sent again. Resend is limited so it cannot be used to flood inboxes or probe emails.

**Why this priority**: Needed so a missed or expired email does not strand the guest, but it is secondary to first-time send and first-time confirm.

**Independent Test**: Request a resend after 60 seconds and verify a new email is sent and previous codes/links no longer work. Request a resend sooner than 60 seconds and verify no additional email is sent.

**Acceptance Scenarios**:

1. **Given** a registration awaiting confirmation and at least 60 seconds since the last confirmation email, **When** the guest requests a resend, **Then** a new confirmation email is sent with a new code and a new link, and previous codes and links no longer work.
2. **Given** a registration awaiting confirmation and fewer than 60 seconds since the last confirmation email, **When** the guest requests a resend, **Then** no additional email is sent and the guest is told to wait before trying again.
3. **Given** registration confirmation is disabled or there is no registration awaiting confirmation, **When** the guest requests a resend, **Then** no confirmation email is sent.

---

### User Story 6 - Administrator controls confirmation per scenario (Priority: P2)

An administrator can turn email confirmation **on or off independently** for three scenarios: registration, password recovery, and sign-in. This feature uses only the **registration** flag. Changing the registration flag changes whether new registrations require confirmation; it does not silently activate unconfirmed registrations.

**Why this priority**: The product requirement is that confirmation is optional and scenario-specific. Without this control, stories 1 and 2 cannot be switched in operation.

**Independent Test**: Toggle the registration confirmation flag and run a new registration; verify confirmation is required only when the flag is on. Verify the password-recovery and sign-in flags can be set independently without changing registration behavior.

**Acceptance Scenarios**:

1. **Given** the administrator disables confirmation for registration, **When** a new guest registers, **Then** User Story 1 applies (account is immediately usable; no confirmation email).
2. **Given** the administrator enables confirmation for registration, **When** a new guest registers, **Then** User Story 2 applies (confirmation required).
3. **Given** the administrator changes the password-recovery or sign-in confirmation flags, **When** a guest registers, **Then** registration behavior follows only the registration flag.
4. **Given** registrations awaiting confirmation exist, **When** the administrator turns registration confirmation off, **Then** already-pending registrations remain unusable until they are confirmed or expire; only **new** registrations skip confirmation.

---

### Edge Cases

- Guest submits an email that differs only by letter case from an existing account (e.g. `User@Example.com` vs `user@example.com`): treated as the same email; a second account is not created.
- Guest submits leading/trailing spaces around the email: spaces are ignored for matching; validation still requires a valid email form.
- Guest starts confirmation-required registration, then submits the same email again before confirming: a second independent account is not created; the request is subject to resend limits rather than creating another pending registration.
- Confirmation code or link is used after the account was already confirmed: no duplicate account; guest is not left in an error state that implies the account does not exist.
- Guest confirms via code after already confirming via link (or the reverse): the second confirmation does not create another account and does not reset credentials.
- Password meets length but is extremely common (e.g. `password1`): accepted unless the administrator has enabled extra complexity rules; this feature does not require a breach-password block list.
- Registration or resend is requested in a tight loop from the same source: requests beyond the rate limit are rejected; no additional account or email is created.
- Email delivery fails after a valid confirmation-required registration: the pending registration still exists; the guest can use resend once the resend interval allows it.
- Confirmation email is delayed beyond the 10-minute lifetime: the guest must request a new email; old code and link do not work.
- Guest never confirms: the pending registration expires and the email may be used for a new registration after expiry (expiry window: 24 hours from the last confirmation email).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A guest MUST be able to request registration by providing an email and a password.
- **FR-002**: The product MUST reject registration when the email is missing or not in a valid email format, and MUST tell the guest that the email is invalid.
- **FR-003**: The product MUST reject registration when the password is missing or does not satisfy the active password policy, and MUST tell the guest that the password is invalid.
- **FR-004**: The default password policy MUST require a non-empty password of at least 8 characters. Additional complexity (letters, digits, special characters) MUST be configurable and off by default.
- **FR-005**: The product MUST treat emails as case-insensitive and MUST NOT create two accounts for the same email.
- **FR-006**: When registration confirmation is **disabled**, a successful registration MUST create a usable account; the guest MUST be able to sign in with the submitted credentials without confirming email.
- **FR-007**: When registration confirmation is **enabled**, a successful registration request MUST NOT create a usable account until confirmation succeeds; the guest MUST be told that confirmation is required.
- **FR-008**: Email confirmation for this feature MUST run only when the administrator has enabled confirmation for the **registration** scenario.
- **FR-009**: When confirmation is required, the product MUST send a confirmation email containing both a 6-digit numeric one-time code and a single-use confirmation link.
- **FR-010**: A confirmation code MUST expire 10 minutes after it is issued, MUST allow at most 5 incorrect entry attempts, and MUST become invalid after a successful confirmation or after a resend.
- **FR-011**: A confirmation link MUST expire 10 minutes after it is issued, MUST be usable at most once, and MUST become invalid after a successful confirmation (by code or link) or after a resend.
- **FR-012**: Successfully confirming via **either** the code **or** the link MUST make the account usable with the password chosen at registration.
- **FR-013**: The guest MUST be able to request a new confirmation email no more often than once every 60 seconds for the same pending registration.
- **FR-014**: A new confirmation email MUST invalidate previously issued codes and links for that registration.
- **FR-015**: Client-facing registration and confirmation errors MUST NOT state whether an email is already registered. Operators MUST still be able to distinguish the real outcome via audit records.
- **FR-016**: The product MUST rate-limit registration requests and confirmation-email sends so automated flooding and credential stuffing against this flow are limited.
- **FR-017**: An administrator MUST be able to turn email confirmation on or off independently for registration, password recovery, and sign-in. This feature MUST honor only the registration flag; password-recovery and sign-in flows are out of scope except for storing those independent flags.
- **FR-018**: The product MUST record audit events for: registration attempts (success and failure), confirmation-email sends (including resend), and confirmation attempts (success and failure). Audit records MUST NOT contain the raw password, the raw confirmation code, or the raw confirmation link secret.
- **FR-019**: Invalid, expired, over-limit, or reused confirmation codes and links MUST fail closed: the account MUST remain unusable if it was not already confirmed.
- **FR-020**: A pending (unconfirmed) registration MUST expire 24 hours after the last confirmation email; after expiry the email MAY be used for a new registration.

### Key Entities

- **Guest**: A person who is not signed in and who may request registration.
- **User Account**: A registered person identified by a unique email, with a secret password. An account is either **usable** (may sign in) or not yet usable.
- **Pending Registration**: A registration that has accepted email and password but is waiting for email confirmation. It is bound to one email, holds the chosen password until confirmation or expiry, and is not a usable account.
- **Confirmation Challenge**: The current one-time code and confirmation link issued for a pending registration, with issue time, expiry, remaining code-entry attempts, and last-sent time.
- **Confirmation Policy**: Administrator-controlled switches for whether email confirmation is required for registration, password recovery, and sign-in. Only the registration switch is used by this feature.
- **Password Policy**: Rules for acceptable passwords (minimum length always; optional complexity).
- **Audit Record**: An operator-visible record of a registration or confirmation security event, without secrets.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A guest with a new email and a valid password completes registration without confirmation (account usable, able to sign in) in under 1 minute of starting the form, excluding any later sign-in UI beyond submitting credentials.
- **SC-002**: A guest with a new email completes confirmation-required registration (request + confirm by code or link) in under 5 minutes when the confirmation email is available immediately, excluding mail-delivery delay outside the product’s control.
- **SC-003**: 100% of registration attempts with an email already tied to a usable account leave exactly one usable account for that email.
- **SC-004**: 100% of confirmation attempts that use an expired, incorrect, over-limit, or already-used code or link leave the account unusable if it was not already confirmed.
- **SC-005**: At least 95% of guests who receive a confirmation email and submit a correct unexpired code or unexpired unused link on the first try obtain a usable account without contacting support.
- **SC-006**: When confirmation is disabled, 100% of valid new registrations result in a usable account without any confirmation message or confirmation email.
- **SC-007**: Repeated registration or resend requests from the same source that exceed the rate limit are rejected; in a 10-minute window a single source cannot trigger more than 5 confirmation emails for the same email.
- **SC-008**: Operators can reconstruct, from audit records alone, whether a given registration attempt succeeded, whether a confirmation email was sent, and whether confirmation succeeded or failed — without reading passwords or confirmation secrets.
- **SC-009**: Changing only the password-recovery or sign-in confirmation switches causes 0 change in whether new registrations require confirmation.

## Assumptions

- Sign-in / authentication, password recovery, and profile management are separate features. This feature only makes an account **usable** so that a later sign-in feature can accept the credentials. Registration does not automatically start a signed-in session.
- Email confirmation for registration is **off** by default so the P1 path works without mail delivery. Administrators turn it on when they want confirmation.
- Confirmation email includes **both** a 6-digit code and a confirmation link. The administrator does not choose one channel; the guest may use either. Password-recovery and sign-in confirmation **methods** are not defined here.
- Client-facing messages never confirm that an email is already registered (anti-enumeration). The guest who mistypes an email may need to use account recovery later; that is accepted in exchange for not leaking account existence.
- Default password policy is minimum length 8 with no extra complexity. Administrators may enable complexity rules later without changing this feature’s stories.
- Emails are normalized by trimming whitespace and comparing case-insensitively.
- Confirmation codes are 6 decimal digits. Confirmation links and codes share a 10-minute lifetime. Resend interval is 60 seconds. Code entry is limited to 5 tries per issued code.
- Pending registrations expire after 24 hours without confirmation so abandoned emails do not stay reserved indefinitely.
- Rate limit for confirmation emails: at most 5 emails per email address per 10 minutes, in addition to the 60-second resend gap. Registration request rate limiting is enforced in addition to that email cap.
- Password-recovery and sign-in confirmation flags are stored as independent switches in this feature so later features can read them; those flows are not built here.
- Mail delivery is provided by the existing operational environment; this feature is responsible for *requesting* a send and for recording whether the product attempted it, not for inbox placement.
- Localization of guest-facing messages is out of scope; messages MUST be clear and MUST follow FR-015 (no email-existence leak).

## Out of Scope

- Sign-in, session issuance, logout, and “remember me”.
- Password recovery / reset (except persisting its confirmation flag).
- Email confirmation at sign-in time (except persisting its confirmation flag).
- Social / SSO / passkey registration.
- Guest-facing administrator console design beyond the ability to set the three confirmation switches and the optional password-complexity rules.
- Changing email on an existing account.
- Multi-factor authentication after the account is usable.
