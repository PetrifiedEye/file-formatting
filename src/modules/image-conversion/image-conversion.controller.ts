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
  ImageFormat,
  ConversionRetentionOutcome,
} from '@/modules/conversion/conversion.enums';
import { ConversionErrorResponseDto } from '@/modules/conversion/dto/conversion-error-response.dto';

import { SupportedImageFormatsResponseDto } from './dto/supported-image-formats-response.dto';
import {
  CONVERTED_IMAGE_BASE_NAME,
  IMAGE_RETENTION_HEADER,
} from './image-conversion.constants';
import { ImageConversionService } from './image-conversion.service';
import type {
  ImageConversionResult,
  MultipartSource,
} from './image-conversion.service';

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
 * `POST /api/images/convert` and `GET /api/images/convert/formats`.
 *
 * The `api/` segment is part of the controller path because the application
 * registers no global prefix — adding one would silently relocate every
 * existing route.
 *
 * There is no conversion logic here at all: the service owns the attempt (the
 * clock, the multipart read, the history row, the log line) and this shapes
 * the response. The split matters because everything the service owns has to
 * happen on the failure paths too, where there is no response to shape.
 */
@ApiTags('image-conversion')
@Controller('api/images/convert')
@UseGuards(JwtAuthGuard)
export class ImageConversionController {
  constructor(private readonly images: ImageConversionService) {}

  /**
   * Every direction the service accepts, built from the registry.
   *
   * Not a constant, and not a second list kept in step with the first: this is
   * the same computation `POST /api/images/convert` consults, so the two
   * cannot disagree (FR-013, SC-010). Registering a fourth handler widens this
   * response with no edit here.
   */
  @Get('formats')
  @ApiOperation({
    summary: 'List every image conversion direction the service accepts',
    description:
      "Derived from the registered handlers' capabilities at request time. A " +
      'format with no encoder cannot appear as a target, which is why `svg` ' +
      'never does.',
  })
  @ApiOkResponse({ type: SupportedImageFormatsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  supportedFormats(): SupportedImageFormatsResponseDto {
    return { formats: this.images.describeFormats() };
  }

  @Post()
  // A conversion creates nothing; Nest's default 201 for POST would be wrong.
  @HttpCode(HttpStatus.OK)
  // Tighter than `/api/convert`'s 10/minute: an image conversion costs more
  // memory and more CPU than a document conversion (FR-016).
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Convert an uploaded image into another format',
    description:
      'Returns the converted image as an attachment named ' +
      '`converted.<ext>`. The response is complete or an error — never a ' +
      'partially written file. `X-Image-Conversion-Retention` reports what ' +
      'happened to an optional `store=true`: a storage failure does not fail ' +
      'the conversion.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The image to convert. Exactly one.',
        },
        targetFormat: {
          type: 'string',
          enum: Object.values(ImageFormat),
          description:
            'Must differ from the detected source format. `svg` is accepted ' +
            'as a value but no direction produces it.',
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
    description: 'The converted image, as an attachment.',
    // Declared on this response rather than with `@ApiProduces`, which applies
    // to the whole operation and would label the JSON error bodies below as
    // `image/png` — a document that disagrees with what a caller receives.
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        description: 'Always `attachment; filename="converted.<ext>"`.',
        schema: { type: 'string' },
      },
      [IMAGE_RETENTION_HEADER]: {
        description:
          '`not-requested`, `stored`, or `failed`. `failed` means the ' +
          'conversion succeeded and the image is valid — only keeping a copy ' +
          'did not.',
        schema: {
          type: 'string',
          enum: Object.values(RETENTION_HEADER_VALUES),
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing or empty file, bad or same target format, an invalid image, ' +
      'an SVG carrying active content or an external reference, a DOCTYPE, a ' +
      'pixel or dimension budget, an oversized result, or a timeout.',
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
      'The source format could not be determined, the target format is not ' +
      'supported, or a raster source named `svg` as its target — ' +
      'vectorisation is never performed.',
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
    const result = await this.images.execute(
      request.user.id,
      request as unknown as MultipartSource,
    );

    this.send(reply, result);
  }

  /**
   * Write the response.
   *
   * Headers are set here and nowhere earlier: by this point the converted
   * image exists in full, so there is no state in which a partial file has
   * been sent (FR-012).
   */
  private send(reply: FastifyReply, result: ImageConversionResult): void {
    void reply
      .status(HttpStatus.OK)
      .header('Content-Type', result.mediaType)
      .header(
        IMAGE_RETENTION_HEADER,
        RETENTION_HEADER_VALUES[result.retentionOutcome],
      )
      .header(
        'Content-Disposition',
        // Always `converted`, never derived from the uploaded name (FR-011).
        `attachment; filename="${CONVERTED_IMAGE_BASE_NAME}.${result.extension}"`,
      )
      .send(result.buffer);
  }
}
