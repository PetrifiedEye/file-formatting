import {
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  JwtAuthGuard,
  RequestUser,
} from '@/modules/auth/guards/jwt-auth.guard';

import { TransformationResultAuditFilter } from './transformation-result-audit.filter';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';
import {
  type TransformationResultDownload,
  TransformationResultDownloadException,
  TransformationResultDownloadService,
} from './transformation-result-download.service';
import { sendTransformationResult } from './transformation-result-streaming';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

@ApiTags('transformation-results')
@Controller('api/transformations/history')
@UseGuards(JwtAuthGuard)
@UseFilters(TransformationResultAuditFilter)
export class SelfResultDownloadController {
  constructor(
    private readonly downloads: TransformationResultDownloadService,
    private readonly auditService: TransformationResultAuditService,
  ) {}

  @Get(':itemId/download')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Download your saved transformation result' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Saved result streamed as an attachment',
    content: {
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
    headers: {
      'Content-Disposition': { schema: { type: 'string' } },
      'Content-Length': { schema: { type: 'integer' } },
      'Content-Encoding': { schema: { type: 'string', example: 'identity' } },
      'Cache-Control': {
        schema: { type: 'string', example: 'private, no-store' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid itemId' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiNotFoundResponse({
    description: 'Transformation result not available',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiResponse({ status: 500, description: 'Storage or streaming failure' })
  async download(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Req() request: RequestWithUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const startedMs = Date.now();
    let download: TransformationResultDownload;

    try {
      download = await this.downloads.prepare(request.user.id, itemId);
    } catch (error) {
      const outcome =
        error instanceof TransformationResultDownloadException
          ? error.auditOutcome
          : TransformationResultAuditOutcome.STORAGE_FAILED;

      await this.auditService.record({
        actorUserId: request.user.id,
        conversionRecordId: itemId,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome,
        durationMs: Date.now() - startedMs,
      });

      if (error instanceof TransformationResultDownloadException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Unable to download transformation result',
      );
    }

    sendTransformationResult(
      reply,
      download,
      this.auditService,
      { actorUserId: request.user.id },
      startedMs,
    );
  }
}
