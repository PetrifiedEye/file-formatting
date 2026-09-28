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
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiResponse,
  ApiServiceUnavailableResponse,
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

import { CONVERTED_FILE_BASE_NAME } from './conversion.constants';
import {
  ConversionFormat,
  ConversionRetentionOutcome,
} from './conversion.enums';
import { ConversionService } from './conversion.service';
import type { ConversionResult, DocumentUpload } from './conversion.service';
import { ConversionErrorResponseDto } from './dto/conversion-error-response.dto';
import { SupportedFormatsResponseDto } from './dto/supported-formats-response.dto';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { DocumentUploadPipe } from '@/modules/conversion/upload/document-upload.pipe';
import { MultipartUpload } from '@/modules/conversion/upload/multipart-upload';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

/** The header's spelling is hyphenated; the enum's is not. */
const RETENTION_HEADER_VALUES: Record<ConversionRetentionOutcome, string> = {
  [ConversionRetentionOutcome.NOT_REQUESTED]: 'not-requested',
  [ConversionRetentionOutcome.STORED]: 'stored',
  [ConversionRetentionOutcome.FAILED]: 'failed',
};

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
  @ApiServiceUnavailableResponse({
    description:
      'Too many conversions are already running or waiting; retry shortly ' +
      '(`service_busy`).',
    type: ConversionErrorResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Unexpected failure.',
    type: ConversionErrorResponseDto,
  })
  async convert(
    @Req() request: RequestWithUser,
    // Reading the multipart body — the one genuinely HTTP part of the work —
    // is the pipe's; the attempt itself (clock, history row, log line) is the
    // service's.
    @MultipartUpload(DocumentUploadPipe) upload: DocumentUpload,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.conversionService.execute(
      request.user.id,
      upload,
    );

    this.send(reply, result);
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
