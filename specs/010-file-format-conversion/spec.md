# Feature Specification: File Format Conversion

**Feature Branch**: `010-file-format-conversion`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "Общие требования к трансформации файлов. Модули трансформации файлов должны обеспечивать лёгкую интеграцию и модификацию; добавление нового модуля не должно требовать изменений существующих контрактов. История всех операций трансформации сохраняется в БД с полной информацией о процессе и привязкой к пользователю. Опционально — сохранение результирующего файла в хранилище приложения по выбору пользователя (локальное хранилище). Трансформация текстовых форматов: конвертация между CSV, JSON, XML, YAML (12 направлений) для аутентифицированного пользователя (access JWT в cookie). POST /api/convert (multipart: file, targetFormat) возвращает потоковый файл; GET /api/convert/formats возвращает допустимые направления. Лимиты размера задаются администратором отдельно для каждого входного формата. Ответы 200/400/401/413/415. Аудит: userId, sourceFormat, targetFormat, fileSize, результат, длительность; содержимое файла не логировать. НФТ: запрет внешних сущностей в XML, ограничение глубины/размера структуры, потоковая обработка, таймаут конвертации, корректная обработка Unicode/BOM/пустых файлов, атомарность ответа, соответствие JSON RFC 8259, YAML 1.2, XML 1.0, CSV RFC 4180."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Signed-in user converts a file between text formats (Priority: P1)

A signed-in user uploads a structured text file (CSV, JSON, XML, or YAML) and names the format they want back. The system recognises the uploaded file's format, reads its contents, produces an equivalent document in the requested format, and returns it as a downloadable file. If the two formats are the same, or the file cannot be understood, the user is told what went wrong instead of receiving a broken file.

**Why this priority**: This is the feature. Without it nothing else in this specification has a purpose. All twelve conversion directions are variations of the same journey and are delivered together.

**Independent Test**: Sign in, upload a small well-formed file in each of the four supported formats, request each of the three other formats, and verify that a downloadable file in the requested format is returned and that its content carries the same data as the input.

**Acceptance Scenarios**:

1. **Given** a signed-in user and a well-formed CSV file, **When** they request conversion to JSON, **Then** they receive a downloadable JSON file whose records correspond one-to-one with the CSV data rows.
2. **Given** a signed-in user and a well-formed JSON file, **When** they request conversion to CSV, **Then** they receive a downloadable CSV file whose header row names the record fields and whose data rows carry the record values.
3. **Given** a signed-in user and a well-formed file in any supported format, **When** they request conversion to any of the other three supported formats, **Then** they receive a downloadable file in the requested format — all twelve source-to-target directions succeed.
4. **Given** a signed-in user and a supported file, **When** the conversion succeeds, **Then** the response is marked as a file attachment named `converted` with the file extension of the requested format, and is labelled with the media type of that format.
5. **Given** a signed-in user, **When** they request a target format equal to the detected source format, **Then** the request is rejected as an unsupported conversion direction and no file is returned.
6. **Given** a signed-in user and a file whose content cannot be parsed as its apparent format, **When** they submit it, **Then** the request is rejected with a message identifying the problem, and no partial output file is returned.

---

### User Story 2 - Client discovers which conversions are available (Priority: P1)

A signed-in client asks the system which conversions it can perform and receives the list of source formats, each with the target formats it can be converted into. The client uses this to build its format picker rather than hard-coding the list.

**Why this priority**: Without a discoverable list, every client must duplicate knowledge of supported directions, and adding a format later silently breaks clients. It is small, independently testable, and needed as soon as any conversion exists.

**Independent Test**: Sign in, request the supported-formats list, and verify it names each supported source format with its permitted targets, and that every listed direction actually succeeds when attempted.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they request the supported conversion directions, **Then** they receive a list of entries, each naming one source format and the target formats available for it.
2. **Given** the supported-formats list, **When** it is compared against the conversion capability, **Then** every direction it advertises is accepted by the conversion operation, and no direction it omits is accepted.
3. **Given** an unauthenticated caller, **When** they request the supported conversion directions, **Then** the request is rejected as unauthenticated.

---

### User Story 3 - Every conversion attempt is recorded against its user (Priority: P1)

Each conversion attempt — successful or failed — is recorded in durable storage and tied to the user who made it. The record describes the attempt: which user, what was uploaded (name, detected source format, size), what was asked for, whether it succeeded, the failure reason when it did not, when it started, and how long it took. The uploaded and produced file contents are never part of this record.

**Why this priority**: The requirement is stated as unconditional ("история всех операций"), it is the basis for support, abuse investigation, and billing later, and it must exist from the first conversion rather than be retrofitted.

**Independent Test**: Perform one successful and one failing conversion as a known user, then inspect stored history and verify exactly two records exist for that user with the correct formats, sizes, outcomes, and durations, and that neither record contains file content.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** a conversion succeeds, **Then** a history record is stored for that user with the source format, target format, original file name, input size, a success outcome, the start time, and the duration.
2. **Given** a signed-in user, **When** a conversion fails for any reason (unparsable input, oversized input, unsupported format, timeout), **Then** a history record is stored for that user with a failure outcome and a failure reason identifying the category of error.
3. **Given** any stored history record, **When** it is inspected, **Then** it contains no bytes of the uploaded or produced file.
4. **Given** a conversion that fails, **When** the response is returned to the user, **Then** the history record is still present — recording the attempt does not depend on the conversion succeeding.

---

### User Story 4 - User optionally keeps the converted file in application storage (Priority: P2)

When submitting a conversion, the user may ask for the result to be kept in the application's storage in addition to being downloaded. When they do, the produced file is stored and the history record for that conversion points at the stored file. When they do not ask for it, nothing is retained beyond the history record.

**Why this priority**: Explicitly optional in the requirement ("опционально"). Conversions are fully usable without it, so it can follow the core journey, but it is a distinct, independently testable slice.

**Independent Test**: Run the same conversion twice — once asking to keep the result, once not — and verify a stored file exists and is referenced by history only for the first, and that the download response is identical in both cases.

**Acceptance Scenarios**:

1. **Given** a signed-in user converting a file, **When** they ask for the result to be kept, **Then** the converted file is placed in application storage and the conversion's history record references it.
2. **Given** a signed-in user converting a file, **When** they do not ask for the result to be kept, **Then** no converted file is retained and the history record carries no stored-file reference.
3. **Given** a conversion that fails, **When** the user had asked for the result to be kept, **Then** no file is stored, because there is no complete result.
4. **Given** a user who asked to keep a result, **When** the file cannot be stored, **Then** the user is still told whether the conversion itself succeeded and the history record reflects the storage failure rather than silently claiming the file was kept.

---

### User Story 5 - Oversized, unsupported, and unauthenticated requests are refused safely (Priority: P1)

Requests that exceed the administrator-configured size limit for their source format, carry an unsupported or undetectable format, omit required inputs, or arrive without a valid session are refused with a distinct, correct outcome for each case — before the system spends effort parsing or converting.

**Why this priority**: These paths guard the service against resource exhaustion and unauthorised use. They must hold from day one, and each is independently testable.

**Independent Test**: With limits configured per source format, submit: an oversized file of each format, a file of an unsupported format, an empty file, a request with a missing or invalid target format, and a request with no session — verifying each produces its own distinct refusal and no conversion work is performed.

**Acceptance Scenarios**:

1. **Given** an unauthenticated caller, **When** they submit a conversion request, **Then** the request is rejected as unauthenticated and no file is processed.
2. **Given** a signed-in user and a file larger than the configured limit for its source format, **When** they submit it, **Then** the request is rejected as too large, naming the applicable limit, and the file is not parsed.
3. **Given** administrator-configured limits that differ per source format, **When** a file of one format is submitted at a size that is within its own format's limit but above another format's limit, **Then** it is accepted — the limit applied is the one for the detected source format.
4. **Given** a signed-in user and a file whose format is neither CSV, JSON, XML, nor YAML, **When** they submit it, **Then** the request is rejected as an unsupported media type.
5. **Given** a signed-in user, **When** they submit a request with no file, an empty file, or a missing or unrecognised target format, **Then** the request is rejected as a bad request with a message naming the offending input.

---

### Edge Cases

- **Empty input**: A zero-byte file is rejected as a bad request. A file that is syntactically valid but carries no records (for example a CSV with only a header row, or an empty JSON array) converts successfully to an empty-but-valid document in the target format.
- **Byte order mark**: A leading UTF-8 BOM is consumed during reading and does not appear in the output or corrupt the first field name.
- **Non-UTF-8 input**: Content that is not valid UTF-8 is rejected as a bad request rather than silently producing replacement characters.
- **Unicode content**: Non-Latin characters, emoji, and combining sequences survive every conversion direction unchanged.
- **Extension disagrees with content**: When the file name's extension and the file's actual content indicate different formats, the content decides; if the content matches no supported format, the request is refused as unsupported.
- **XML external entities**: An XML document that declares external or recursive entities is refused; no external resource is fetched and no entity expansion is performed.
- **Excessive nesting or breadth**: Input whose structure exceeds the configured depth or element-count limits is refused as a bad request rather than being processed to exhaustion.
- **Conversion timeout**: A conversion that exceeds the configured time budget is abandoned, refused to the caller, and recorded as a timed-out attempt; no partial file is returned.
- **Ragged CSV rows**: Rows with fewer or more fields than the header are handled by a documented, deterministic rule rather than failing unpredictably.
- **Structures that do not fit a table**: Deeply nested or heterogeneous data converted into CSV follows a documented, deterministic flattening rule; data that cannot be represented at all is refused with an explanatory message rather than silently dropped.
- **XML shapes without a JSON equivalent**: Attributes, repeated sibling elements, mixed content, and the absence of a root element in tabular sources are handled by documented, deterministic rules.
- **Failure mid-stream**: If conversion fails after output has begun being produced, the caller receives an error rather than a truncated file.
- **Concurrent conversions**: Several conversions running at once do not block one another or the rest of the service.

## Requirements *(mandatory)*

### Functional Requirements

#### Conversion

- **FR-001**: System MUST accept a file upload together with a requested target format from a signed-in user and return the converted file.
- **FR-002**: System MUST support CSV, JSON, XML, and YAML as both source and target formats, covering all twelve distinct source-to-target directions.
- **FR-003**: System MUST determine the source format from the uploaded file's content, using the file name extension only as a secondary hint, and MUST reject files whose format cannot be determined as unsupported.
- **FR-004**: System MUST reject a request whose target format is missing, is not one of the four supported formats, or equals the detected source format.
- **FR-005**: System MUST reject a request with no file part or with a zero-byte file.
- **FR-006**: System MUST validate that the input is syntactically well-formed for its detected format before conversion and MUST refuse malformed input with a message identifying the problem.
- **FR-007**: System MUST return a successful result as a downloadable attachment named `converted` with the target format's file extension, labelled with the target format's media type.
- **FR-008**: System MUST return either a complete, valid result file or an error — never a partially written result.
- **FR-009**: System MUST apply documented, deterministic rules for conversion directions where the mapping is ambiguous (record shape for tabular-to-structured, flattening for structured-to-tabular, attribute and repeated-element handling for XML, root element naming and array representation for structured-to-XML), and those rules MUST be recorded in project documentation.
- **FR-010**: System MUST preserve the data's Unicode content across every conversion direction, consuming any input byte order mark and emitting UTF-8 output.
- **FR-011**: System MUST expose the supported conversion directions to signed-in clients as a list of source formats each paired with its permitted target formats.
- **FR-012**: System MUST keep the advertised list of conversion directions consistent with what the conversion operation actually accepts.

#### Access control

- **FR-013**: System MUST require a valid authenticated session for both conversion and format discovery, and MUST reject unauthenticated requests without processing any file.
- **FR-014**: System MUST attribute every conversion to the authenticated user who requested it.
- **FR-015**: System MUST apply rate limiting to the conversion operation to protect against abuse.

#### Limits and safety

- **FR-016**: System MUST enforce a maximum input size configured by an administrator separately for each source format, and MUST reject an oversized file as too large before parsing it.
- **FR-017**: System MUST enforce configured limits on structural depth and total element count of parsed input and refuse input that exceeds them.
- **FR-018**: System MUST refuse XML input that declares external entities, and MUST NOT resolve external references or perform unbounded entity expansion.
- **FR-019**: System MUST abandon any conversion that exceeds a configured time budget and report it as a failure.
- **FR-020**: System MUST reject input that is not valid UTF-8.

#### History

- **FR-021**: System MUST store a durable history record for every conversion attempt, successful or failed, linked to the requesting user.
- **FR-022**: Each history record MUST carry: requesting user, original file name, detected source format, requested target format, input size, outcome (success or failure), failure reason and error category when failed, start time, and duration.
- **FR-023**: System MUST NOT store or log the contents of uploaded or produced files in history records or application logs.
- **FR-024**: System MUST record the attempt even when the conversion fails or the caller disconnects before receiving the result.

#### Optional result storage

- **FR-025**: System MUST let the user request, as part of the conversion request, that the converted file be retained in application storage; the default when unspecified is not to retain it.
- **FR-026**: System MUST store the converted file only when retention was requested and the conversion completed successfully, and MUST link the stored file to that conversion's history record.
- **FR-027**: System MUST keep stored files private to the user who created them.
- **FR-028**: System MUST report a storage failure distinctly from a conversion failure, and MUST NOT record a file as retained when it was not.

#### Extensibility

- **FR-029**: System MUST structure format handling so that introducing an additional format or conversion direction requires adding new implementations of the existing abstractions rather than modifying the existing conversion contracts, controller, or already-supported format handlers.
- **FR-030**: System MUST derive the advertised conversion directions from the registered format handlers, so a newly registered format appears in discovery without further changes.

#### Observability

- **FR-031**: System MUST log each conversion attempt with requesting user, source format, target format, input size, outcome with error code when failed, and duration.

### Key Entities *(include if data involved)*

- **Conversion Record**: One conversion attempt. Holds the requesting user, original file name, detected source format, requested target format, input size, output size when successful, outcome, failure reason and error category when failed, whether retention was requested, start time, duration, and an optional reference to a Stored File. Never holds file content.
- **Stored File**: A converted result the user chose to retain. Holds its owning user, the conversion it came from, its format, its size, when it was stored, and where it resides in application storage.
- **User**: The existing authenticated account. Owns Conversion Records and Stored Files.
- **Format Limit Configuration**: Administrator-set maximum accepted input size per source format, plus the structural depth, element-count, and time limits applied during conversion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All twelve conversion directions succeed on well-formed input, and data converted from one format to another and back is equivalent to the original for data expressible in both formats.
- **SC-002**: A user converting a file of one megabyte or less receives the result in under five seconds at typical load.
- **SC-003**: Conversions that exceed the configured time budget are abandoned and reported within that budget, with no request exceeding it by more than a further five seconds.
- **SC-004**: 100% of conversion attempts — successful, failed, and timed out — appear in history attributed to the correct user.
- **SC-005**: No stored history record or log line contains any content from an uploaded or produced file, verified by inspection across every error and success path.
- **SC-006**: Files exceeding their source format's configured limit are refused without the system reading the whole file, and the service continues serving other requests unaffected.
- **SC-007**: XML input declaring external entities is refused in 100% of attempts, with no outbound request made to any referenced resource.
- **SC-008**: Ten concurrent conversions of one-megabyte files complete without any unrelated request being delayed by more than one second.
- **SC-009**: Adding one new format to the system requires no edits to existing format handlers, the conversion request contract, or the discovery response shape — demonstrated by a worked example in project documentation.
- **SC-010**: The discovery list and the set of directions actually accepted match exactly, verified automatically.
- **SC-011**: Every documented ambiguous-direction rule has a test that pins the chosen behaviour.

## Assumptions

- Authentication reuses the existing access-JWT-in-cookie session established by the earlier auth features; no new sign-in path is introduced here.
- Conversion is available to any authenticated user regardless of role; no dedicated conversion permission is introduced.
- "Full information about the process" in history means process metadata (names, formats, sizes, outcome, timing) plus an optional pointer to a retained result file — not the file contents themselves, which the audit requirements explicitly forbid recording.
- Result retention targets the local file system of the application host, as stated; no external object store is introduced in this feature.
- Conversion is synchronous: the user waits for the response and receives the file in it. No background job queue or polling is introduced.
- Default per-format size limits ship with the application and are overridable by an administrator through application configuration; changing them does not require code changes.
- Format detection inspects a bounded prefix of the uploaded content; it does not need to read the whole file to classify it.
- The ambiguous-direction rules (FR-009) are chosen by the implementation and fixed in documentation; this specification requires them to be deterministic and documented, not any particular choice.
- Existing global rate limiting applies; no conversion-specific quota (per-user daily allowance, concurrent-conversion cap) is defined in this feature.
- Retained files have no automatic expiry in this feature; retention lifecycle management is out of scope.
- Reading back conversion history and downloading retained files are out of scope for this feature — this feature produces the records and files; surfacing them to users is a separate feature.
