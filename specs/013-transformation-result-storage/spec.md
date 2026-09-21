# Feature Specification: Transformation Result Storage & Download

**Feature Branch**: `013-transformation-result-storage`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "Сохранение результатов трансформаций в хранилище — при выполнении трансформации файлов/изображений (POST /api/convert, POST /api/images/convert) дать пользователю возможность сохранить результирующий файл в хранилище флагом save (по умолчанию false). Self скачивает только свои сохранённые файлы из истории трансформаций (GET /api/transformations/history/{itemId}/download), Admin может скачать сохранённый файл любого пользователя (GET /admin/users/{userId}/transformations/history/{itemId}/download). Сохранение не должно блокировать или изменять ответ на саму трансформацию. Срок хранения сохранённого файла и связанной записи истории задаётся администратором (например 90 дней) и по истечении — запись и файл удаляются автоматически фоновым процессом. Требуются проверки владения/прав (Self/Admin), обработка отсутствующего/истёкшего файла, лимит размера сохраняемых файлов, аудит действий save/download без логирования содержимого файла, потоковая раздача при скачивании и защита от IDOR. Часть контракта (условный флаг сохранения при трансформации, привязка сохранённого файла к записи истории, локальное файловое хранилище) уже существует в кодовой базе под именем параметра `store`; скачивание, срок хранения/TTL и автоматическая очистка отсутствуют полностью."

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
-->

### User Story 1 - Save a transformation result for later retrieval (Priority: P1)

A signed-in user converts a file or an image and asks the system to keep a copy of the result, so they can come back later and get the same output again without re-uploading and re-converting the original.

**Why this priority**: Without the ability to opt into saving a result, there is nothing to download later — this is the foundation the rest of the feature depends on.

**Independent Test**: As an authenticated user, submit a file transformation (and separately, an image transformation) with the save option enabled, verify the transformation response is unchanged (same status code, same streamed file), and verify a corresponding transformation-history entry now references a retrievable saved copy of the result.

**Acceptance Scenarios**:

1. **Given** an authenticated user submitting a file transformation with the save option enabled, **When** the transformation completes successfully, **Then** the result is written to storage, a unique file reference is generated, and the user's transformation-history entry for this attempt is linked to that file reference with an expiration set to the current retention period.
2. **Given** an authenticated user submitting an image transformation with the save option enabled, **When** the transformation completes successfully, **Then** the same saving behavior described above applies, using the same history and storage mechanism as file transformations.
3. **Given** an authenticated user submitting a transformation with the save option enabled, **When** the underlying transformation itself fails, **Then** nothing is saved, and the transformation-history entry reflects the failure with no file reference — the save option has no effect on a failed transformation.
4. **Given** an authenticated user submitting a transformation with the save option enabled, **When** the transformation succeeds, **Then** the caller still receives the converted file in the response exactly as they would without the save option, with no added delay perceptible to the caller and no change to error handling for the transformation itself.
5. **Given** an authenticated user submitting a transformation with the save option omitted or explicitly disabled, **When** the transformation completes (successfully or not), **Then** no file is written to storage, and the transformation-history entry is created without any file reference.
6. **Given** an authenticated user submitting a transformation, **When** the save option is present but is not a recognized boolean value, **Then** the request is rejected as invalid before the transformation runs.

---

### User Story 2 - Download my own saved result (Priority: P1)

A signed-in user returns to their transformation history and downloads a previously saved result by referencing that history entry, receiving the exact file that was produced at transformation time.

**Why this priority**: This is the entire point of saving a result — without retrieval, saving delivers no value to the user.

**Independent Test**: As an authenticated user with a saved transformation-history entry, request its download and verify the original file bytes, correct filename, and correct content type are returned; then attempt to download an entry that was never saved, or one belonging to another user, and verify both are refused.

**Acceptance Scenarios**:

1. **Given** an authenticated user with a transformation-history entry that has a saved file and has not expired, **When** they request its download, **Then** they receive a successful response streaming the saved file with a content type matching the result format and a filename matching the original result's name.
2. **Given** an authenticated user, **When** they request the download of a transformation-history entry that belongs to a different user, **Then** the request is refused and no file is disclosed, regardless of whether that entry has a saved file.
3. **Given** an authenticated user, **When** they request the download of one of their own transformation-history entries that was never saved (no save option was used), **Then** the request is refused as if no downloadable file exists.
4. **Given** an authenticated user, **When** they request the download of a transformation-history entry that does not exist, **Then** the request is refused the same way as a never-saved entry, without revealing whether the entry ever existed.
5. **Given** an unauthenticated request, **When** a download of any transformation-history entry is requested, **Then** the request is refused before any entry or file is looked up.
6. **Given** an authenticated user, **When** they request the same downloadable entry more than once while it remains saved and unexpired, **Then** each request returns the same file content.

---

### User Story 3 - Administrator downloads a saved result on behalf of a user (Priority: P1)

An administrator holding the appropriate oversight permission retrieves a saved transformation result that belongs to a specific user, for support or investigation purposes, without needing that user's own session.

**Why this priority**: Administrative access to saved results is a distinct, explicitly required capability (support/investigation) and carries its own authorization rules that must be verified independently of the self-service path.

**Independent Test**: As an authenticated administrator holding the oversight permission, request the download of a saved entry belonging to a specific, known user and verify the file is returned; then, as an authenticated user lacking that permission, attempt the same request and verify it is refused.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator holding the transformation-history download oversight permission, **When** they request the download of an existing, saved, unexpired transformation-history entry belonging to a specified user, **Then** they receive the same successful streamed response a self-service download would produce.
2. **Given** an authenticated user who does not hold the oversight permission, **When** they attempt an administrative download for any user (including themselves via the administrative path), **Then** the request is refused before the target entry is looked up.
3. **Given** an authenticated administrator holding the oversight permission, **When** they request a download for a user account that does not exist, **Then** the request is refused as not found.
4. **Given** an authenticated administrator holding the oversight permission, **When** they request a download for an entry that exists but belongs to a different user than the one specified, **Then** the request is refused as not found, exactly as if the entry did not exist for that user.
5. **Given** an authenticated administrator holding the oversight permission, **When** they request a download for an entry that was never saved or has since expired, **Then** the request is refused the same way the self-service download refuses it.

---

### User Story 4 - Saved results and their history expire automatically (Priority: P2)

Once the administrator-defined retention period elapses for a saved result, the saved file and its transformation-history linkage stop being available, and the underlying stored file is removed without manual intervention.

**Why this priority**: This bounds storage growth and enforces the same retention promise already made for transformation history; it depends on saving and downloading already working (User Stories 1–3) but is not required for an initial, manually-cleaned MVP.

**Independent Test**: Create a saved transformation-history entry, advance past its configured retention period, and verify both that attempting to download it is refused as if it were never saved, and that the underlying stored file no longer exists in storage.

**Acceptance Scenarios**:

1. **Given** a saved transformation-history entry whose retention period has elapsed, **When** the automatic cleanup process next runs, **Then** the stored file is removed and the entry's file reference is cleared (or the entry itself is removed, consistent with the retention behavior already defined for transformation history).
2. **Given** a saved transformation-history entry whose retention period has elapsed but the cleanup process has not yet run, **When** a download of that entry is requested (self or admin), **Then** the request is refused as expired/not-available, even though the underlying file may still physically exist.
3. **Given** the automatic cleanup process, **When** it removes an expired saved file, **Then** it removes the file and its history linkage together — there is never a saved-file reference left pointing to a deleted file, nor an orphaned file with no reachable history reference.
4. **Given** the automatic cleanup process encounters an error removing one expired item, **When** it continues processing, **Then** other expired items are still evaluated and removed in the same run rather than the whole run aborting.

---

### User Story 5 - Handling save and download failures gracefully (Priority: P2)

The system behaves predictably when storage is unavailable, when a result is too large to save, or when a saved file and its history record fall out of sync, instead of exposing confusing or unsafe behavior.

**Why this priority**: These are the failure paths the feature must not get wrong, but they refine behavior on top of the already-working happy paths in User Stories 1–3.

**Independent Test**: Simulate a storage failure during save and verify the transformation still succeeds without a saved copy; simulate a storage failure during download and verify a server-error response with no partial file; simulate a result exceeding the configured save size limit and verify it is not saved; simulate a history entry whose file reference no longer resolves in storage and verify download is refused rather than erroring unsafely.

**Acceptance Scenarios**:

1. **Given** a transformation with the save option enabled, **When** writing the result to storage fails for any reason, **Then** the transformation response is still returned successfully to the caller, and the transformation-history entry records that saving did not succeed, with no file reference.
2. **Given** a transformation result that exceeds the configured maximum size for saved results, **When** the save option is enabled, **Then** the result is not saved (recorded as not saved due to size), while the transformation response itself is unaffected.
3. **Given** a transformation-history entry with a file reference, **When** a download is requested but the underlying stored file cannot be found in storage, **Then** the request is refused as unavailable rather than the caller receiving a corrupt or partial file.
4. **Given** a download request, **When** the storage backend is unavailable or a read fails unexpectedly while streaming, **Then** the caller receives a server-error response and no partial or corrupted file content.

---

### User Story 6 - Save and download actions are audited (Priority: P3)

Every attempt to save a transformation result and every attempt to download one — successful or not — is recorded so that security review can reconstruct who saved or accessed which result and when, without ever capturing the file's actual content.

**Why this priority**: Supports compliance and abuse investigation for a feature that grants access to previously produced files, but the feature is functional without it.

**Independent Test**: Perform a successful save, a failed save (simulated storage failure), a successful self download, a refused cross-user download, and a refused admin download without permission; verify each produces an audit record with the acting user, the transformation/history identifier, the file identifier when one exists, the action, the outcome, and — for downloads — file size and duration, and that no record contains file content.

**Acceptance Scenarios**:

1. **Given** any save attempt (successful or not), **When** it completes, **Then** an audit record is created capturing the acting user's id, the transformation-history identifier, the file identifier (when a file was produced), the action "save", the outcome, the file size, and how long the save took.
2. **Given** any download attempt (self or admin path, successful or refused), **When** it completes, **Then** an audit record is created capturing the acting user's id, the target user's id (for the admin path), the transformation-history identifier, the file identifier (when applicable), the action "download", the outcome, the file size (on success), and how long the download took.
3. **Given** any audit record produced by this feature, **When** it is inspected, **Then** it never contains the file's actual content or bytes.

---

### Edge Cases

- What happens when a user supplies the save option on a transformation that the transformation feature itself would reject (e.g., invalid format, oversized input)? The transformation is rejected exactly as it is today, before any saving is attempted; nothing is saved and no history entry gains a file reference.
- What happens when a download is requested for an entry that both belongs to the caller and has expired at the exact moment of the request? It is refused the same way as any other expired entry — the ownership check passing does not override the expiration check.
- What happens when an administrator's oversight permission is revoked between sign-in and an in-flight download request? The decision uses the permission held at request time, consistent with how the existing transformation-history read feature evaluates permissions.
- What happens when the same saved entry is downloaded concurrently by the same user multiple times? Each concurrent request independently succeeds and returns the same content, as long as the entry remains saved and unexpired.
- What happens when the retention period configuration is changed by an administrator while saved entries created under the old period already exist? Existing entries keep the expiration that was set when they were saved; only newly saved entries use the updated period, unless the administrator explicitly triggers a re-evaluation (out of scope for this feature).
- What happens when a saved file's on-disk (or backing-store) representation is missing even though the history entry still references it (data/storage drift)? The download is refused as unavailable, and this condition is logged as a failed download outcome for investigation, rather than surfacing a raw internal error to the caller.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept an optional save indicator on both the file transformation operation and the image transformation operation, defaulting to "do not save" when omitted.
- **FR-002**: System MUST reject a transformation request whose save indicator is present but not a recognized boolean-equivalent value, before running the transformation.
- **FR-003**: System MUST leave the transformation operation's response (status codes, streamed result, headers describing the result itself) unchanged regardless of whether saving is requested or whether saving succeeds or fails — saving is an additional side effect, never a precondition or blocker for returning the transformation result.
- **FR-004**: System MUST, only when the save indicator is enabled and the transformation succeeds, write the result to storage, obtain a unique reference to the stored file, and link that reference to the transformation's history entry together with an expiration set from the currently configured retention period.
- **FR-005**: System MUST, when the save indicator is disabled, omitted, or the transformation fails, create the transformation's history entry (consistent with existing history behavior) without any file reference.
- **FR-006**: System MUST NOT save a transformation result whose size exceeds the configured maximum size for saved results; when this limit is exceeded, the transformation response MUST still succeed and the history entry MUST record that saving did not occur.
- **FR-007**: System MUST NOT fail or alter the transformation response when writing the saved result to storage fails for any other reason; the history entry MUST record that saving did not occur.
- **FR-008**: System MUST allow an authenticated user to download the saved file of a transformation-history entry that belongs to them, via a dedicated self-service download operation identified by the history entry's own identifier.
- **FR-009**: System MUST reject the self-service download operation with an unauthenticated result when the caller is not signed in, before any entry is looked up.
- **FR-010**: System MUST refuse the self-service download operation when the referenced history entry belongs to a different user, without revealing whether a saved file exists for it.
- **FR-011**: System MUST refuse the self-service download operation, in a way indistinguishable from "entry not found," when the entry does not exist, has no saved file, or its saved file has expired.
- **FR-012**: System MUST allow an authenticated user holding a distinct transformation-history download oversight permission to download the saved file of any specified user's transformation-history entry, via a separate administrative download operation.
- **FR-013**: System MUST refuse the administrative download operation for a caller lacking the oversight permission before evaluating whether the target user or entry exists.
- **FR-014**: System MUST refuse the administrative download operation, in a way indistinguishable from "entry not found," when the specified user does not exist, the entry does not exist for that user, the entry has no saved file, or its saved file has expired.
- **FR-015**: Both download operations MUST, on success, stream the saved file's bytes to the caller with a content type reflecting the result's format and a content-disposition indicating the original result's filename, without loading the entire file into memory as a prerequisite for streaming.
- **FR-016**: Both download operations MUST return the same file content on repeated requests for the same entry for as long as that entry's saved file remains available (idempotent retrieval).
- **FR-017**: System MUST refuse a download request as unavailable (without exposing internal error details) when the history entry's saved-file reference no longer resolves to an actual stored file, and MUST record this condition for investigation.
- **FR-018**: System MUST return a server-side failure result — never a partial or corrupted file — when the storage backend is unreachable or a read fails while streaming a download.
- **FR-019**: System MUST allow an administrator to configure the retention period that governs both when a transformation-history entry is purged and when its saved file expires, with these two lifetimes always kept equal for any given entry.
- **FR-020**: System MUST run an automatic process that removes saved files and their history linkage once their configured retention period has elapsed, without requiring manual intervention, and MUST ensure a saved-file reference and its underlying stored file are always removed together (never leaving one without the other reachable).
- **FR-021**: The automatic removal process MUST continue processing other expired items when it fails to remove one particular item, rather than aborting the entire run.
- **FR-022**: System MUST record an audit entry for every save attempt (successful or not), capturing the acting user's id, the transformation-history identifier, the file identifier when one was produced, the outcome, the file size, and the time taken.
- **FR-023**: System MUST record an audit entry for every download attempt on either download operation (successful or refused), capturing the acting user's id, the target user's id for the administrative path, the transformation-history identifier, the file identifier when applicable, the outcome, the file size on success, and the time taken.
- **FR-024**: Audit entries produced by this feature MUST NOT contain the saved file's actual content or bytes.
- **FR-025**: System MUST NOT expose a saved file through any path other than the two authorized download operations described above (no unauthenticated or directly guessable file link).

### Key Entities

- **Saved Transformation File**: The stored copy of a transformation's result, created only when saving was requested and the transformation succeeded. Has a unique reference, an owner (the user who ran the transformation), a size, a format, an expiration time, and a link back to exactly one Transformation History Record. Ceases to be retrievable once its expiration passes, and is removed by the automatic cleanup process.
- **Transformation History Record** *(extends the entity defined by the existing transformation-history feature)*: Gains, for this feature, an optional reference to its Saved Transformation File and that file's expiration; a record with no such reference represents a transformation that was never saved or whose saved file has since been removed.
- **Retention Period Configuration**: An administrator-controlled setting defining how long both a Transformation History Record and any Saved Transformation File it references remain available before automatic removal. Applies uniformly to all users; a change to this setting affects newly saved files going forward, not the expiration already set on existing ones.
- **Transformation History Download Oversight Permission**: The access-control grant that allows an administrator to download another user's Saved Transformation File. Distinct from (but analogous to) the existing permission that gates viewing another user's history list; downloading one's own saved file never requires it.
- **Save/Download Audit Entry**: A log entry for one save or download attempt: acting user id, target user id (for administrative downloads), transformation-history identifier, file identifier (when applicable), action, outcome, file size, and duration — never the file's content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of transformation requests that enable saving, and complete successfully, result in a history entry that can be downloaded at least once immediately afterward.
- **SC-002**: 100% of transformation requests receive a response with the same status code and file content they would have received had saving not been requested, regardless of whether saving succeeds, fails, or is skipped due to size.
- **SC-003**: 100% of download attempts for another user's saved file by a caller without the oversight permission are refused, with zero file bytes disclosed.
- **SC-004**: 100% of download attempts for an unauthenticated caller are refused before any file is looked up.
- **SC-005**: 100% of download attempts against an entry that was never saved, does not exist, or has expired receive the same "unavailable" outcome, without revealing which of those three is the case.
- **SC-006**: Repeated downloads of the same still-valid saved entry return byte-identical content in 100% of tests.
- **SC-007**: 100% of saved files and their history linkage are removed together within one scheduled cleanup cycle after their configured retention period elapses, with zero orphaned files or dangling file references observed in testing.
- **SC-008**: 100% of save and download attempts (successful or not) produce a retrievable audit entry containing zero file content.
- **SC-009**: A user can download a previously saved result of typical size in under 3 seconds under normal operating conditions, without the server needing to hold the entire file in memory at once.

## Assumptions

- This feature builds directly on the existing file-transformation, image-transformation, and transformation-history features; it does not change their existing behavior beyond adding the save option and, for history, adding an optional file reference and its expiration.
- A save option equivalent to this specification's intent already exists on both transformation operations in the current implementation, accepting an optional flag with a default of "do not save," writing successful results to a private, non-web-accessible local storage location, and linking a unique file reference to the corresponding history entry. This specification treats that existing behavior as satisfying FR-001, FR-002 (for its currently accepted values), FR-003, FR-004 (except for setting an expiration, which does not yet exist), FR-005, and FR-007; the exact external parameter name and the addition of an expiration value are implementation decisions for the planning phase, not open product questions.
- No download capability, retention-period configuration, or automatic cleanup process exists yet for saved files; these are net-new capabilities this feature introduces (FR-008 through FR-021).
- The retention period is a single, system-wide setting managed by administrators (not per-user or per-role), consistent with how the transformation-history retention period is already described as administrator-configured; this feature extends that same configuration to also govern saved-file expiration, keeping the two lifetimes equal for any given entry.
- The transformation-history download oversight permission is a new, distinct permission from the existing one that gates viewing another user's history list, following the project's existing role/permission model; the Admin role is granted it by default.
- The maximum size for saved results reuses the size limits already enforced on transformation output; this feature does not introduce a separate, larger, or smaller limit unless a future decision changes that.
- When a saved file expires or is refused as unavailable, the caller receives a "not available" outcome rather than distinguishing "never saved" from "expired" from "not found" in the response, matching the pattern already used elsewhere in this project's access-control checks to avoid revealing information through error responses; internal audit logging still distinguishes these cases for investigation.
- The automatic cleanup process runs on a recurring schedule (not on every request) and is allowed to lag behind the exact expiration moment by up to one cleanup cycle; a request made after expiration but before the next cleanup cycle is still refused as unavailable even though the underlying file may not yet be physically deleted.
- Supporting multiple interchangeable storage backends (for example, swapping local storage for an external object store without code changes) is a valuable future capability but is not required for this feature to deliver its user-facing value, and is not covered by this specification's success criteria.
- Re-running a transformation from a saved entry, editing or renaming a saved entry, and bulk/manual deletion of saved files by their owner are all out of scope for this feature.
