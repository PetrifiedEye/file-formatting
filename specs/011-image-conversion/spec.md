# Feature Specification: Image Conversion

**Feature Branch**: `011-image-conversion`

**Created**: 2026-09-17

**Status**: Draft

**Input**: User description: "Трансформация изображений. Конвертация изображений между форматами PNG, JPEG, SVG для аутентифицированного пользователя (access JWT в cookie). Поддерживаемые направления: png→jpeg, jpeg→png, svg→png, svg→jpeg; векторизация (PNG/JPEG → SVG) не поддерживается никогда. POST /api/images/convert (multipart: file, targetFormat) возвращает потоковый файл с Content-Type и Content-Disposition: attachment; filename=\"converted.<ext>\". GET /api/images/convert/formats возвращает допустимые направления. Лимиты размера задаются администратором отдельно для каждого входного формата (PNG, JPEG, SVG). Максимальные размеры (ширина/высота) выходного растрового изображения при растеризации SVG задаются администратором в конфигурации или хардкодятся; фон по умолчанию #ffffff. Ответы 200/400/401/413/415. Аудит: userId, sourceFormat, targetFormat, fileSize, результат (success/error + код), длительность; содержимое изображения не логировать. НФТ: проверка SVG на отсутствие активного содержимого и внешних ресурсов, ограничение количества пикселей при декодировании, защита от decompression bomb, потоковая обработка, таймаут конвертации (например 30 сек), корректная обработка альфа-канала PNG, атомарность ответа."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Signed-in user converts between raster image formats (Priority: P1)

A signed-in user uploads a PNG or a JPEG image, names the other raster format as the one they want back, and receives a downloadable image in that format carrying the same picture. When a PNG carrying transparency is converted to JPEG — a format that cannot hold transparency — the transparent areas are filled with the configured background colour rather than turning black or producing a corrupt file.

**Why this priority**: PNG ↔ JPEG is the most common image conversion and is usable on its own without any vector handling. It is the smallest slice that delivers the feature's value.

**Independent Test**: Sign in, upload a PNG and request JPEG, then upload a JPEG and request PNG; verify each returns a downloadable file that is a valid image in the requested format, with the same visible picture and the same pixel dimensions as the input.

**Acceptance Scenarios**:

1. **Given** a signed-in user and a valid PNG image, **When** they request conversion to JPEG, **Then** they receive a downloadable JPEG file whose pixel dimensions match the source image.
2. **Given** a signed-in user and a valid JPEG image, **When** they request conversion to PNG, **Then** they receive a downloadable PNG file whose pixel dimensions match the source image.
3. **Given** a signed-in user and a PNG containing transparent or partially transparent pixels, **When** they request conversion to JPEG, **Then** the transparent areas are composited onto the configured background colour and the resulting JPEG is a valid, fully opaque image.
4. **Given** a successful conversion, **When** the response is delivered, **Then** it is marked as a file attachment named `converted` with the requested format's file extension and is labelled with that format's media type.
5. **Given** a signed-in user and a file whose bytes are not a valid image of its apparent format, **When** they submit it, **Then** the request is refused with a message identifying the problem and no partial image is returned.

---

### User Story 2 - Signed-in user rasterises an SVG into PNG or JPEG (Priority: P1)

A signed-in user uploads an SVG drawing and asks for PNG or JPEG. The system renders the drawing into pixels at the size the drawing itself declares, over the configured background colour, and returns the rendered image as a download. Drawings that would render larger than the administrator's maximum output dimensions, or that declare no size at all, are refused with an explanation rather than consuming unbounded resources.

**Why this priority**: Rasterisation is the second half of the stated scope and covers two of the four supported directions. It is independently testable and delivers value on its own, but it depends on no other story.

**Independent Test**: Sign in, upload an SVG with a declared size, request PNG and then JPEG, and verify each returns a valid raster image whose dimensions match the SVG's declared size; then upload an SVG declaring a size above the configured maximum and verify it is refused.

**Acceptance Scenarios**:

1. **Given** a signed-in user and an SVG declaring an intrinsic size, **When** they request conversion to PNG, **Then** they receive a downloadable PNG whose width and height match the declared intrinsic size.
2. **Given** a signed-in user and an SVG declaring an intrinsic size, **When** they request conversion to JPEG, **Then** they receive a downloadable JPEG of those dimensions, rendered over the configured background colour.
3. **Given** an SVG whose intrinsic size exceeds the configured maximum output width or height, **When** conversion is requested, **Then** the request is refused as a bad request naming the applicable maximum, and no rendering is performed.
4. **Given** an SVG that declares no intrinsic size and no way to derive one, **When** conversion is requested, **Then** the request is refused with a message stating that the drawing's size cannot be determined.
5. **Given** an SVG that the renderer cannot process (unsupported or malformed drawing features), **When** conversion is requested, **Then** the request is refused with a rasterisation failure message and no partial image is returned.

---

### User Story 3 - Unsafe and abusive uploads are refused before any work is done (Priority: P1)

Uploads that carry active content, reference external resources, exceed the size limit configured for their format, or expand to an unreasonable number of pixels from a small file are refused. Each case produces its own distinct outcome, and the refusal happens before the system spends effort decoding or rendering.

**Why this priority**: These paths are what make it safe to accept arbitrary user images at all. SVG is an executable, network-capable document format, and raster decoders are a classic memory-exhaustion target. This must hold from the first conversion.

**Independent Test**: With per-format limits configured, submit: an SVG containing a script element, an SVG referencing an external entity or remote image, an oversized file of each format, and a small raster file declaring enormous dimensions — verifying each is refused with its own distinct outcome, that no outbound network request is made, and that the service keeps serving other requests.

**Acceptance Scenarios**:

1. **Given** an SVG containing a script element, an event-handler attribute, or any other active content, **When** it is submitted, **Then** it is refused as unsafe and never rendered.
2. **Given** an SVG declaring an external entity or referencing an external resource by URL, **When** it is submitted, **Then** it is refused and no outbound request is made to that resource.
3. **Given** a file larger than the limit configured for its detected source format, **When** it is submitted, **Then** it is refused as too large, naming the applicable limit, and the image is not decoded.
4. **Given** per-format limits that differ, **When** a file is submitted at a size within its own format's limit but above another format's limit, **Then** it is accepted — the limit applied is the one for the detected source format.
5. **Given** a small raster file that declares pixel dimensions whose product exceeds the configured decoding pixel budget, **When** it is submitted, **Then** it is refused before the pixel data is decoded and the service's memory use is unaffected.
6. **Given** a conversion that exceeds the configured time budget, **When** the budget elapses, **Then** the conversion is abandoned, the caller is told it failed, and no partial image is returned.

---

### User Story 4 - Client discovers the available image conversion directions (Priority: P2)

A signed-in client asks which image conversions the system can perform and receives each source format paired with the target formats it can be converted into. The client builds its format picker from this list instead of hard-coding the directions, so the permanently unsupported ones never appear as options.

**Why this priority**: Small and independently testable, and it prevents every client from duplicating the direction table — but conversion works without it, so it follows the conversion stories.

**Independent Test**: Sign in, request the supported-directions list, and verify it names PNG→JPEG, JPEG→PNG, and SVG→PNG/JPEG and nothing else, and that every direction it advertises actually succeeds while every direction it omits is refused.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they request the supported image conversion directions, **Then** they receive a list of entries, each naming one source format and the target formats available for it.
2. **Given** the returned list, **When** it is inspected, **Then** PNG offers JPEG, JPEG offers PNG, SVG offers PNG and JPEG, and no entry offers SVG as a target.
3. **Given** the returned list, **When** it is compared against the conversion operation, **Then** every advertised direction is accepted and every unadvertised direction is refused.
4. **Given** an unauthenticated caller, **When** they request the list, **Then** the request is rejected as unauthenticated.

---

### User Story 5 - Requests with wrong parameters, formats, or no session are refused distinctly (Priority: P2)

Requests missing a file, carrying an empty file, naming a missing or unrecognised target format, asking for a permanently unsupported direction, uploading a non-image file, or arriving without a valid session each receive their own correct, distinguishable refusal.

**Why this priority**: Correct error separation is what makes the endpoint usable by a client and diagnosable in support. It is independently testable but has no value before conversion itself exists.

**Independent Test**: Submit each malformed request variant in turn and verify each produces its own distinct outcome and that no conversion work is performed in any of them.

**Acceptance Scenarios**:

1. **Given** an unauthenticated caller, **When** they submit a conversion request, **Then** it is rejected as unauthenticated and no file is processed.
2. **Given** a signed-in user, **When** they submit a request with no file part or a zero-byte file, **Then** it is refused as a bad request naming the missing input.
3. **Given** a signed-in user, **When** they submit a request with a missing target format or one outside the accepted set, **Then** it is refused as a bad request.
4. **Given** a signed-in user and a PNG or JPEG, **When** they request SVG as the target, **Then** it is refused as an unsupported conversion direction, stating that vectorisation is not supported.
5. **Given** a signed-in user, **When** the requested target format equals the detected source format, **Then** it is refused as an unsupported conversion direction.
6. **Given** a signed-in user and a file that is neither PNG, JPEG, nor SVG, **When** they submit it, **Then** it is refused as an unsupported media type.

---

### User Story 6 - User optionally keeps the converted image in application storage (Priority: P2)

When submitting an image conversion, the user may ask for the result to be kept in the application's storage in addition to being downloaded — the same optional retention already available for text-format conversions. When they do, the converted image is stored and the history record for that attempt points at the stored file. When they do not ask for it, nothing beyond the history record is retained.

**Why this priority**: Image conversion now shares its durable history with the rest of the conversion feature, and that history already carries optional retention; offering the same choice for images keeps the two capabilities consistent. It is independently testable and not required for conversion itself to work.

**Independent Test**: Run the same conversion twice — once asking to keep the result, once not — and verify a stored image exists and is referenced by history only for the first, and that the download response is identical in both cases.

**Acceptance Scenarios**:

1. **Given** a signed-in user converting an image, **When** they ask for the result to be kept, **Then** the converted image is placed in application storage and the conversion's history record references it.
2. **Given** a signed-in user converting an image, **When** they do not ask for the result to be kept, **Then** no converted image is retained and the history record carries no stored-file reference.
3. **Given** a conversion that fails, **When** the user had asked for the result to be kept, **Then** no file is stored, because there is no complete result.
4. **Given** a user who asked to keep a result, **When** the file cannot be stored, **Then** they are still told whether the conversion itself succeeded, and the history record reflects the storage failure rather than silently claiming the file was kept.

---

### Edge Cases

- **Extension disagrees with content**: When the file name's extension and the file's actual bytes indicate different formats, the content decides; if the content matches no supported image format, the upload is refused as unsupported.
- **Empty and truncated files**: A zero-byte file is a bad request. A file with a valid image header but truncated pixel data is refused as an invalid image, not returned as a partial picture.
- **Raster decompression bomb**: A small file declaring very large dimensions is refused on its declared pixel count, before any pixel buffer is allocated.
- **SVG billion-laughs**: An SVG using nested entity expansion to inflate is refused; no entity expansion is performed.
- **SVG with fractional, percentage, or unit-bearing sizes**: Declared sizes that are not whole pixels are resolved to whole pixels by a documented, deterministic rule before the maximum-dimension check.
- **SVG sized only by `viewBox`**: A drawing with a view box but no declared width and height has its size derived from the view box; a drawing with neither is refused as having no determinable size.
- **SVG referencing fonts or images**: External references are refused; embedded (inline) resources are rendered without any network access.
- **PNG without transparency to JPEG**: Converts normally; the background colour has no visible effect.
- **Greyscale, indexed-colour, and 16-bit-per-channel PNGs**: Decoded and re-encoded correctly rather than refused.
- **Animated or multi-frame input**: Only the first frame is converted, or the file is refused — the chosen behaviour is documented and fixed by a test.
- **Embedded metadata**: Orientation is applied to the output pixels so the picture is not rotated; other metadata (location, camera, colour profile beyond what is needed for correct colour) is not carried into the result.
- **Failure mid-stream**: If encoding fails after output has begun, the caller receives an error rather than a truncated image file.
- **Caller disconnects**: The conversion is abandoned and the attempt is still recorded.
- **Concurrent conversions**: Several conversions running at once do not exhaust memory or block unrelated requests.

## Requirements *(mandatory)*

### Functional Requirements

#### Conversion

- **FR-001**: System MUST accept an image upload together with a requested target format from a signed-in user and return the converted image as a downloadable file.
- **FR-002**: System MUST support exactly these conversion directions: PNG→JPEG, JPEG→PNG, SVG→PNG, SVG→JPEG.
- **FR-003**: System MUST permanently refuse conversion of any raster source (PNG, JPEG) to SVG, and MUST NOT advertise such a direction.
- **FR-004**: System MUST determine the source format from the uploaded file's content, using the file name extension only as a secondary hint, and MUST refuse a file whose format cannot be determined as an unsupported media type.
- **FR-005**: System MUST refuse a request whose target format is missing, is not one of the accepted format names, equals the detected source format, or names an unsupported direction.
- **FR-006**: System MUST refuse a request with no file part or with a zero-byte file.
- **FR-007**: System MUST verify that the upload is a valid image of its detected format before conversion and MUST refuse invalid or corrupt images with a message identifying the problem.
- **FR-008**: System MUST preserve the source image's pixel dimensions in raster-to-raster conversions.
- **FR-009**: System MUST composite any transparency onto the configured background colour when the target format cannot represent an alpha channel, and MUST preserve the alpha channel when the target format can.
- **FR-010**: System MUST rasterise SVG input at the drawing's intrinsic size, rendered over the configured background colour, and MUST refuse a drawing whose size cannot be determined.
- **FR-011**: System MUST return a successful result as a downloadable attachment named `converted` with the target format's file extension, labelled with the target format's media type.
- **FR-012**: System MUST return either a complete, valid image or an error — never a partially written result.
- **FR-013**: System MUST expose the supported image conversion directions to signed-in clients as a list of source formats each paired with its permitted target formats, derived from what the conversion operation actually accepts.

#### Access control

- **FR-014**: System MUST require a valid authenticated session for both image conversion and direction discovery, and MUST reject unauthenticated requests without processing any file.
- **FR-015**: System MUST attribute every image conversion attempt to the authenticated user who requested it.
- **FR-016**: System MUST apply rate limiting to the image conversion operation to protect against abuse.

#### Limits and safety

- **FR-017**: System MUST enforce a maximum upload size configured by an administrator separately for each source format (PNG, JPEG, SVG), and MUST refuse an oversized upload as too large before decoding or rendering it.
- **FR-018**: System MUST enforce administrator-configured maximum output width and height for SVG rasterisation and MUST refuse, as a bad request, any drawing whose rendered size would exceed them.
- **FR-019**: System MUST enforce a maximum total pixel count when decoding raster input and MUST refuse input exceeding it before allocating pixel memory, so that a small file declaring enormous dimensions cannot exhaust memory.
- **FR-020**: System MUST refuse SVG input containing active content — scripts, event-handler attributes, or any other executable construct.
- **FR-021**: System MUST refuse SVG input that declares external entities or references external resources, and MUST NOT issue any network request while processing an upload.
- **FR-022**: System MUST abandon any conversion that exceeds a configured time budget and report it as a failure.
- **FR-023**: System MUST bound the number of conversions processed concurrently so that simultaneous requests cannot exhaust memory or processing capacity.

#### History and optional result storage

- **FR-024**: System MUST store a durable history record for every image conversion attempt, successful or failed, in the same conversion history used by other transformation features, linked to the requesting user.
- **FR-025**: Each history record MUST carry: requesting user, original file name, detected source format, requested target format, upload size, outcome (success or failure), failure reason and error category when failed, start time, and duration.
- **FR-026**: System MUST NOT store or log the contents of uploaded or produced images, nor any pixel data or embedded metadata from them, in history records or application logs.
- **FR-027**: System MUST record the attempt even when the conversion fails, times out, or the caller disconnects before receiving the result.
- **FR-028**: System MUST let the user request, as part of the conversion request, that the converted image be retained in application storage; the default when unspecified is not to retain it.
- **FR-029**: System MUST store the converted image only when retention was requested and the conversion completed successfully, and MUST link the stored file to that conversion's history record.
- **FR-030**: System MUST keep stored images private to the user who created them.
- **FR-031**: System MUST report a storage failure distinctly from a conversion failure, and MUST NOT record an image as retained when it was not.
- **FR-032**: System MUST log every image conversion attempt with the requesting user, detected source format, requested target format, upload size in bytes, outcome (success, or failure with its error code), and duration, independent of and in addition to the history record.

#### Extensibility

- **FR-033**: System MUST structure image format handling so that adding another image format or direction requires adding new implementations of the existing abstractions rather than modifying the request contract, the discovery response shape, or already-supported format handlers.
- **FR-034**: System MUST express the set of permitted directions as data rather than as branching logic, so that discovery and enforcement cannot diverge.

### Key Entities *(include if data involved)*

- **Image Conversion Attempt**: One request to convert an image, recorded in the same conversion history as text-format conversions. Carries the requesting user, original file name, detected source format, requested target format, upload size, outcome, failure reason and category when failed, whether retention was requested, start time, duration, and an optional reference to a Retained Image. Never carries image content.
- **Retained Image**: A converted image result the user chose to keep. Holds its owning user, the conversion attempt it came from, its format, its size, when it was stored, and where it resides in application storage.
- **Image Format Limit Configuration**: Administrator-set values governing image conversion — maximum upload size per source format (PNG, JPEG, SVG), maximum output width and height for SVG rasterisation, maximum decoded pixel count, rasterisation background colour, conversion time budget, and concurrency bound.
- **User**: The existing authenticated account that owns conversion attempts and retained images.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All four supported directions succeed on valid input, and the returned file opens as a valid image of the requested format in standard image viewers.
- **SC-002**: Raster-to-raster conversion preserves pixel dimensions exactly, and the visible picture is unchanged apart from the losses inherent to the target format.
- **SC-003**: A PNG with transparency converted to JPEG produces a fully opaque image whose formerly transparent pixels carry the configured background colour, verified pixel-wise.
- **SC-004**: A user converting an image of two megabytes or less receives the result in under five seconds at typical load.
- **SC-005**: Conversions exceeding the configured time budget are abandoned and reported within that budget, with no request exceeding it by more than a further five seconds.
- **SC-006**: SVG uploads containing active content or external references are refused in 100% of attempts, with no outbound network request made during processing — verified with network egress observed.
- **SC-007**: A raster file under one hundred kilobytes declaring dimensions above the pixel budget is refused without the process's memory use rising measurably.
- **SC-008**: Files exceeding their source format's configured limit are refused without the whole upload being read, and the service continues serving other requests unaffected.
- **SC-009**: Every attempt to convert PNG or JPEG to SVG is refused, and no discovery response ever lists SVG as a target.
- **SC-010**: The advertised direction list and the set of directions actually accepted match exactly, verified automatically.
- **SC-011**: 100% of conversion attempts — successful, failed, and timed out — are recorded and attributed to the correct user.
- **SC-012**: No log line or stored record contains any content from an uploaded or produced image, verified by inspection across every error and success path.
- **SC-013**: Ten concurrent conversions of two-megabyte images complete without any unrelated request being delayed by more than one second.
- **SC-014**: Adding one new image format requires no edits to existing image format handlers, the request contract, or the discovery response shape — demonstrated by a worked example in project documentation.
- **SC-015**: When retention is requested and the conversion succeeds, the stored image is retrievable by the owning user and by no one else; when retention is not requested, or the conversion fails, no image file is left behind.

## Assumptions

- Authentication reuses the existing access-JWT-in-cookie session established by the earlier auth features; no new sign-in path is introduced here.
- Image conversion is available to any authenticated user regardless of role; no dedicated permission is introduced.
- Image conversion is a separate capability from the existing text-format conversion, exposed on its own route, because image directions are an explicit allow-list rather than every source-to-target pair, and images do not pass through the text pipeline's document model.
- The accepted values for the requested target format are `png`, `jpeg`, and `svg`. `svg` is a syntactically valid value but no supported direction produces it, so requesting it is always refused as an unsupported direction rather than as a malformed parameter.
- The literal strings in the example discovery response (`"png link"`, `"jpeg link"`, `"svg link"`) are read as the format names `png`, `jpeg`, and `svg`; "link" is taken as a transcription artefact and not part of the contract.
- The conversion request carries the file, the target format, and an optional flag asking for the result to be retained. Output width, height, and background colour are not caller-supplied in this feature: rasterisation uses the SVG's own intrinsic size and the administrator-configured background, defaulting to `#ffffff`.
- JPEG output quality is a fixed, documented default rather than a caller-supplied parameter.
- Maximum output dimensions for rasterisation, the decoded pixel budget, the conversion time budget (default thirty seconds), and the concurrency bound ship as application defaults and are overridable by an administrator through application configuration without code changes.
- Format detection inspects a bounded prefix of the upload; it does not read the whole file to classify it.
- Conversion is synchronous: the user waits for the response and receives the image in it. No background job queue or polling is introduced.
- Existing global rate limiting applies; no image-specific quota (per-user daily allowance, concurrent-conversion cap per user) is defined in this feature.
- Image conversion attempts and retained images share the durable conversion history and application storage introduced by the text-format conversion feature (`010-file-format-conversion`); this feature extends that history and storage to image attempts rather than introducing a parallel mechanism.
- Retained images have no automatic expiry in this feature; retention lifecycle management is out of scope.
- Reading back conversion history and downloading retained images are out of scope for this feature — it produces the records and files; surfacing them to users is a separate feature.
- Image editing operations (resize, crop, quality tuning, colour-profile conversion, compression settings) are out of scope; this feature converts between container formats only.
