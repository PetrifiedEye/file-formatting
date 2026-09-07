# Feature Specification: JWT Cookie-Based Session Authorization

**Feature Branch**: `[004-jwt-session-auth]`

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "Авторизация пользователя производится посредством JWT токена, передаваемого в Cookies. Аутентификация запросов на основе access/refresh JWT из Cookies, TTL access 15 минут / refresh 30 дней, ротация refresh включена, хранение refresh на сервере запрещено (без allowlist/denylist/jti), серверная инвалидация refresh недоступна — только TTL и очистка cookies на клиенте."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Access a protected resource with a valid session (Priority: P1)

A signed-in user sends a request to a protected resource. The system reads their session
credentials from cookies, confirms the session is valid and belongs to an active user, and
lets the request through to be handled normally.

**Why this priority**: This is the core of the feature — without reliable request
authentication, no protected resource in the system can be safely exposed. Every other story
depends on this one existing first.

**Independent Test**: Sign in, then call any protected endpoint with the resulting session
cookies. The request succeeds and returns the expected resource. Calling the same endpoint
with no cookies, or with a tampered cookie value, is rejected.

**Acceptance Scenarios**:

1. **Given** a user has a valid, unexpired access credential in cookies, **When** they request a
   protected resource, **Then** the request is processed and the resource is returned.
2. **Given** a request has no session cookie at all, **When** it targets a protected resource,
   **Then** the system rejects it as unauthenticated.
3. **Given** a session cookie has been altered or does not match the system's signing key,
   **When** it is presented, **Then** the system rejects the request as unauthenticated.
4. **Given** the user account tied to a valid access credential has been deactivated/blocked
   since the credential was issued, **When** a request is made, **Then** the system rejects the
   request even though the credential itself is still technically valid.

---

### User Story 2 - Session renews automatically without re-entering credentials (Priority: P2)

A user's short-lived access credential has expired, but their longer-lived renewal credential is
still valid. The user (via the client application) exchanges the renewal credential for a fresh
session without being forced to log in again, and their original request can then proceed.

**Why this priority**: This preserves a seamless experience across a 15-minute access window;
without it, users would be logged out every 15 minutes, which is an unacceptable experience but
not as foundational as basic authentication itself.

**Independent Test**: Let the access credential expire (or simulate expiry), then call the
renewal flow using only the renewal cookie. A fresh, working session is issued and can
immediately be used to access a protected resource.

**Acceptance Scenarios**:

1. **Given** the access credential has expired and the renewal credential is still valid,
   **When** the client requests session renewal, **Then** the system issues a new access
   credential (and a new renewal credential, since renewal rotates on every use).
2. **Given** a session has just been renewed, **When** the client retries the original request
   with the new credentials, **Then** it succeeds as if the session had never expired.
3. **Given** renewal succeeds, **When** the previous renewal credential is presented again,
   **Then** the system cannot detect or block this reuse (no server-side renewal-credential
   state is kept); this is an accepted, explicit trade-off of the design.

---

### User Story 3 - Expired or invalid session requires signing in again (Priority: P2)

A user's renewal credential has expired, is missing, or is invalid. The system tells them their
session is over and they must sign in again to continue.

**Why this priority**: This is the natural boundary condition of the renewal flow and must exist
alongside it so users get a clear, actionable outcome instead of being stuck.

**Independent Test**: Attempt session renewal with an expired, missing, or malformed renewal
cookie. The system responds with an unauthenticated result and no new session cookies are set.

**Acceptance Scenarios**:

1. **Given** the renewal credential has expired, **When** the client requests renewal, **Then**
   the system rejects the request and issues no new cookies.
2. **Given** the renewal cookie is missing or malformed, **When** the client requests renewal,
   **Then** the system rejects the request the same way.
3. **Given** renewal was rejected, **When** the user next tries to reach a protected resource,
   **Then** they are treated as signed out and directed to sign in again.

---

### User Story 4 - User signs out (Priority: P3)

A signed-in user chooses to end their session from the current device/browser.

**Why this priority**: Useful and expected for user control and shared/public device hygiene,
but the system's security does not depend on it, since sessions already expire on their own via
TTL.

**Independent Test**: While signed in, trigger sign-out. Session cookies are cleared from the
client, and the next request to a protected resource from that browser is treated as
unauthenticated.

**Acceptance Scenarios**:

1. **Given** a user is signed in, **When** they sign out, **Then** their session cookies are
   cleared on the client.
2. **Given** a user has signed out, **When** they immediately request a protected resource using
   the browser's (now-cleared) cookies, **Then** they are treated as unauthenticated.
3. **Given** a user signed out on one device, **When** the same renewal credential is still held
   by another device/browser (e.g. it was copied out), **Then** that other session keeps working
   until its own TTL expires, since sign-out cannot revoke it server-side.

### Edge Cases

- What happens when the access credential is technically well-formed but is missing required
  identity information? → Treated as invalid; request rejected as unauthenticated.
- What happens when the system clock and the credential's issued/expiry times disagree slightly
  (clock skew)? → A small, fixed tolerance is applied; beyond that, normal expiry rules apply.
- What happens when two requests race to renew the session at nearly the same moment? → Each
  valid renewal attempt independently succeeds and issues its own fresh session; the system does
  not need to serialize these, but callers should expect only the most recently issued renewal
  credential to remain usable if uniqueness is later enforced by the client.
- How does the system handle a renewal credential being renewed far past when it "should" have
  been (e.g. an old copy replayed weeks later, still inside its 30-day window)? → It is accepted
  as valid; by design there is no way to distinguish a legitimate renewal from a replay of a
  previously-issued renewal credential, since no server-side record is kept.
- What happens if a user is deleted or blocked mid-session? → The next access-credential check
  that looks up the user will reject the request; already-authenticated in-flight requests are
  not retroactively interrupted.
- What happens on sign-out if the user has no active session cookies at all? → Treated as a
  no-op success; the end state (no session cookies) is already satisfied.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST authenticate every request to a protected resource using an access
  credential carried in the request's cookies, with no other means of supplying it accepted.
- **FR-002**: The system MUST reject a request to a protected resource when the access
  credential is missing, malformed, has an invalid signature, or has expired.
- **FR-003**: The system MUST verify that the access credential identifies an existing user, and
  MUST reject the request if that user cannot be found or is not in an active/allowed state.
- **FR-004**: On successful validation, the system MUST make the authenticated user's identity
  available to the request handler for the duration of that request.
- **FR-005**: The system MUST issue both an access credential and a renewal credential together
  whenever a user establishes a new session (sign-in).
- **FR-006**: The access credential MUST remain valid for 15 minutes from issuance; the renewal
  credential MUST remain valid for 30 days from issuance.
- **FR-007**: The system MUST provide a way to exchange a still-valid renewal credential for a
  new access credential without requiring the user's password again.
- **FR-008**: Every successful renewal MUST issue a new renewal credential in addition to the new
  access credential (rotation on every use); the previous renewal credential is not tracked or
  actively invalidated server-side.
- **FR-009**: The system MUST reject a renewal request when the renewal credential is missing,
  malformed, has an invalid signature, or has expired, and MUST NOT issue any new credentials in
  that case.
- **FR-010**: The system MUST NOT persist renewal credentials, their identifiers, or any
  session/allow-list/deny-list state on the server; validity is determined solely from the
  credential's own signature and expiry at the time it is presented.
- **FR-011**: The system MUST provide a sign-out action that clears the session cookies on the
  client; sign-out MUST NOT be relied upon to invalidate the renewal credential server-side, and
  the specification explicitly accepts that a copy of the renewal credential held elsewhere
  remains usable until it naturally expires.
- **FR-012**: Session cookies MUST be set with attributes that prevent client-side script access
  and restrict transmission to secure, same-application contexts (not readable by page
  JavaScript, sent only over encrypted connections, and constrained in cross-site delivery).
- **FR-013**: The system MUST record an audit entry for each failed authentication or renewal
  attempt on a protected/renewal endpoint, capturing the failure reason category (e.g. missing,
  expired, invalid signature, user not found/blocked) without recording the credential value
  itself or any other secret.
- **FR-014**: The system MUST NOT write full credential values, signing secrets, or other
  sensitive personal data to logs at any point.
- **FR-015**: A rejected request (invalid/missing/expired access credential, or invalid/expired
  renewal credential) MUST receive a distinct "not authenticated" outcome that a client can
  reliably use to trigger renewal or a fresh sign-in, as appropriate to which credential failed.

### Key Entities

- **User Session**: Represents a signed-in user's ongoing authenticated state, composed of an
  access credential and a renewal credential issued together and independently time-limited.
- **Access Credential**: A short-lived (15-minute) proof of identity presented on every
  protected request; carries the user's identity and standard validity window claims.
- **Renewal Credential**: A longer-lived (30-day) credential used only to obtain a new session;
  rotates on every use; never stored or tracked server-side.
- **User Account (status)**: The account referenced by a session's identity; must be looked up
  and confirmed active/allowed on each protected request, independent of credential validity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of requests to protected resources with a missing, tampered, or expired access
  credential are rejected, with zero false-accepts observed in testing.
- **SC-002**: A user whose access credential expires mid-session experiences no forced re-login
  for up to 30 days of continued activity, as long as they return at least once within any given
  30-day window (i.e. renewal keeps extending usable session life through rotation).
- **SC-003**: Session renewal completes and returns usable new credentials in under 1 second
  under normal load.
- **SC-004**: After signing out, a user's browser can no longer access any protected resource
  using its former session state, verified in 100% of tested sign-out flows.
- **SC-005**: No occurrence of a full session credential or signing secret appears in application
  logs across a full audit of authentication-related log output.

## Assumptions

- "Sign-in" itself (verifying a username/password and issuing the very first session) is treated
  as an existing/prerequisite capability; this feature covers request authentication using the
  issued session, session renewal, and sign-out — not the initial credential-verification step.
- Cross-site cookie delivery (`SameSite=None`) is out of scope by default; the system is assumed
  to be accessed as a same-site or same-origin application. If a cross-domain frontend/backend
  split is required later, cookie `SameSite`/domain settings will need revisiting.
- Token issuer/audience claims are not required for this system's current single-application
  deployment; they are not validated unless a future multi-service deployment requires them.
- A small, fixed clock-skew tolerance (industry-standard, on the order of a few seconds) is
  applied when checking token time-based claims, to absorb minor clock drift between servers.
- Because renewal credentials are never stored server-side, "logout everywhere" and
  "invalidate on suspected compromise" are explicitly out of scope for this feature; the only
  mitigations available are the 30-day TTL and client-side cookie clearing, as stated in the
  input requirements.
- Rate limiting of authentication/renewal endpoints against abuse is assumed to be handled by
  existing platform-wide protections rather than being redefined by this feature.
