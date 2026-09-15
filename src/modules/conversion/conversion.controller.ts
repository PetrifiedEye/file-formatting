import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  JwtAuthGuard,
  RequestUser,
} from '@/modules/auth/guards/jwt-auth.guard';

import {
  CONVERTED_FILE_BASE_NAME,
  ConversionErrorCode,
} from './conversion.constants';
import {
  ConversionFormat,
  ConversionRetentionOutcome,
} from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionService } from './conversion.service';
import type {
  AttemptState,
  ConversionResult,
  ReceivedUpload,
} from './conversion.service';
import { ConversionErrorResponseDto } from './dto/conversion-error-response.dto';
import { ConvertRequestDto } from './dto/convert-request.dto';
import { SupportedFormatsResponseDto } from './dto/supported-formats-response.dto';
import { FormatRegistryService } from './format-registry.service';
import { UploadReader } from './upload-reader';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

/** The header's spelling is hyphenated; the enum's is not. */
const RETENTION_HEADER_VALUES: Record<ConversionRetentionOutcome, string> = {
  [ConversionRetentionOutcome.NOT_REQUESTED]: 'not-requested',
  [ConversionRetentionOutcome.STORED]: 'stored',
  [ConversionRetentionOutcome.FAILED]: 'failed',
};

const FILE_PART = 'file';
const FIELD_PARTS = ['targetFormat', 'store'];

/**
 * `POST /api/convert` and `GET /api/convert/formats`.
 *
 * The `api/` segment is part of the controller path because the application
 * registers no global prefix — adding one would silently relocate every
 * existing route.
 */
@ApiTags('conversion')
@Controller('api/convert')
@UseGuards(JwtAuthGuard)
export class ConversionController {
  constructor(
    private readonly conversionService: ConversionService,
    private readonly registry: FormatRegistryService,
  ) {}

  /**
   * Every direction the service accepts, built from the registry.
   *
   * Not a constant, and not a second list kept in step with the first: this is
   * the same computation `POST /api/convert` consults, so the two cannot
   * disagree (FR-012, FR-030). Registering a fifth handler widens this response
   * with no edit here.
   */
  @Get('formats')
  @ApiOperation({
    summary: 'List every conversion direction the service accepts',
    description:
      'Derived from the registered format handlers at request time, so the ' +
      'set advertised here is exactly the set POST /api/convert accepts.',
  })
  @ApiOkResponse({ type: SupportedFormatsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  supportedFormats(): SupportedFormatsResponseDto {
    return { formats: this.registry.describe() };
  }

  @Post()
  // A conversion creates nothing; Nest's default 201 for POST would be wrong.
  @HttpCode(HttpStatus.OK)
  // Conversion is the most expensive thing this service does per request, so
  // it carries a tighter limit than the global one (FR-015). Discovery keeps
  // the global ThrottlerGuard.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Convert an uploaded file into another format',
    description:
      'Returns the converted document as an attachment named ' +
      '`converted.<ext>`. The response is complete or an error — never a ' +
      'partially written file. `X-Conversion-Retention` reports what happened ' +
      'to an optional `store=true`: a storage failure does not fail the ' +
      'conversion.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiProduces(
    'text/csv',
    'application/json',
    'application/xml',
    'application/yaml',
  )
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The document to convert. Exactly one.',
        },
        targetFormat: {
          type: 'string',
          enum: Object.values(ConversionFormat),
          description: 'Must differ from the detected source format.',
        },
        store: {
          type: 'string',
          enum: ['true', 'false'],
          default: 'false',
          description: 'Keep the result in application storage.',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'The converted document, as an attachment.',
    schema: { type: 'string', format: 'binary' },
    headers: {
      'Content-Disposition': {
        description: 'Always `attachment; filename="converted.<ext>"`.',
        schema: { type: 'string' },
      },
      'X-Conversion-Retention': {
        description: '`not-requested`, `stored`, or `failed`.',
        schema: {
          type: 'string',
          enum: Object.values(RETENTION_HEADER_VALUES),
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing or empty file, bad or same target format, malformed input, ' +
      'non-UTF-8, a DOCTYPE declaration, a structural limit, or a timeout.',
    type: ConversionErrorResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiPayloadTooLargeResponse({
    description:
      "Larger than the detected source format's configured limit, which the " +
      'message names.',
    type: ConversionErrorResponseDto,
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'The source format could not be determined, or the target format is ' +
      'not supported.',
    type: ConversionErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Unexpected failure.',
    type: ConversionErrorResponseDto,
  })
  async convert(
    @Req() request: RequestWithUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // The service owns the attempt: the clock, the history row, and the log
    // line. All the controller contributes is the part of the work that is
    // genuinely HTTP — reading a multipart body — and the response.
    const result = await this.conversionService.execute(
      request.user.id,
      async (state) => {
        const collected = await this.collectParts(request, state);
        const fields = await this.validateFields(collected.fields);

        state.targetFormat = fields.targetFormat;
        state.retentionRequested = fields.store === 'true';

        if (!collected.received) {
          throw new ConversionException(ConversionErrorCode.MISSING_FILE);
        }

        return {
          received: collected.received,
          targetFormat: fields.targetFormat,
        };
      },
    );

    this.send(reply, result);
  }

  /**
   * Read the multipart body.
   *
   * The file part is consumed here, as it arrives, rather than buffered for
   * later: `busboy` will not advance to the next part until the current one is
   * drained, and consuming it under the per-format budget is the only way an
   * oversized upload can be refused without being read to the end (SC-006).
   *
   * The consequence, stated rather than hidden: a request that is both
   * oversized *and* missing `targetFormat` is answered 413, not 400. The field
   * may legitimately arrive after the file, so there is no ordering in which
   * both refusals could take precedence.
   */
  private async collectParts(
    request: RequestWithUser,
    state: AttemptState,
  ): Promise<{
    received?: ReceivedUpload;
    fields: Record<string, string>;
  }> {
    if (!request.isMultipart()) {
      throw new ConversionException(ConversionErrorCode.MISSING_FILE);
    }

    const fields: Record<string, string> = {};
    let received: ReceivedUpload | undefined;

    // Per-call limits: the global registration in `main.ts` keeps its own
    // `PHOTO_MAX_SIZE_BYTES` ceiling for the photo route and is not loosened.
    const parts = request.parts({
      limits: { fileSize: this.registry.maxConfiguredInputBytes(), files: 1 },
    });

    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== FILE_PART || received) {
          // Drain before refusing: an undrained part stalls the iterator.
          await part.toBuffer().catch(() => undefined);
          throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
        }

        state.originalFileName = part.filename ?? '';

        const reader = new UploadReader(part.file, {
          hardLimit: this.registry.maxConfiguredInputBytes(),
        });

        try {
          received = await this.conversionService.receive(
            reader,
            state.originalFileName,
          );
          state.sourceFormat = received.sourceFormat;
        } finally {
          // Read from the reader rather than the result, so a refusal records
          // a size too. For a 413 this is the point at which the budget was
          // exceeded — deliberately not the file's true size, because the rest
          // of it was never read (SC-006).
          state.inputSizeBytes = reader.bytesRead;
        }
        continue;
      }

      if (!FIELD_PARTS.includes(part.fieldname) || part.fieldname in fields) {
        throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
      }

      fields[part.fieldname] = String(part.value);

      // Recorded as soon as it is seen, not after validation: an attempt that
      // fails later should still show what the caller asked for. A `store`
      // arriving *after* the file part cannot be recovered if the file itself
      // is refused — nothing has been sent yet at that point.
      if (part.fieldname === 'store') {
        state.retentionRequested = fields.store === 'true';
      }
    }

    return { received, fields };
  }

  /**
   * Validate the non-file parts explicitly.
   *
   * The global `ValidationPipe` never sees a multipart body, so the DTO is
   * applied by hand here rather than being quietly skipped.
   */
  private async validateFields(
    fields: Record<string, string>,
  ): Promise<ConvertRequestDto> {
    if (fields.targetFormat === undefined) {
      throw new ConversionException(ConversionErrorCode.MISSING_TARGET_FORMAT);
    }

    const dto = plainToInstance(ConvertRequestDto, fields);
    const failures = await validate(dto, { whitelist: true });

    for (const failure of failures) {
      // Each field has its own code so the caller can tell the refusals apart.
      throw new ConversionException(
        failure.property === 'store'
          ? ConversionErrorCode.INVALID_STORE_FLAG
          : ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    // A format may be spelled correctly and still have no handler registered.
    if (!this.registry.handlerFor(dto.targetFormat)) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    return dto;
  }

  /**
   * Write the response.
   *
   * Headers are set here and nowhere earlier: by this point the converted
   * document exists in full, so there is no state in which a partial file has
   * been sent (FR-008).
   */
  private send(reply: FastifyReply, result: ConversionResult): void {
    void reply
      .status(HttpStatus.OK)
      .header('Content-Type', `${result.mediaType}; charset=utf-8`)
      .header(
        // `failed` means the conversion succeeded and the file below is valid
        // — only keeping a copy did not (FR-028). A response header is the one
        // channel that can say so alongside a binary body.
        'X-Conversion-Retention',
        RETENTION_HEADER_VALUES[result.retentionOutcome],
      )
      .header(
        'Content-Disposition',
        // Always `converted`, never derived from the uploaded name (FR-007).
        `attachment; filename="${CONVERTED_FILE_BASE_NAME}.${result.extension}"`,
      )
      .send(result.buffer);
  }
}
