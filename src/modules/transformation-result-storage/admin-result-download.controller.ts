import {
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
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
import { AccessConfigService } from '@/modules/rbac/access-config.service';
import { UsersService } from '@/modules/users/users.service';

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

@ApiTags('admin-transformation-results')
@Controller('admin/users')
@UseGuards(JwtAuthGuard)
@UseFilters(TransformationResultAuditFilter)
export class AdminResultDownloadController {
  constructor(
    private readonly downloads: TransformationResultDownloadService,
    private readonly accessConfigService: AccessConfigService,
    private readonly usersService: UsersService,
    private readonly auditService: TransformationResultAuditService,
  ) {}

  @Get(':userId/transformations/history/:itemId/download')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: "Download a user's saved transformation result",
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
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
  @ApiBadRequestResponse({ description: 'Invalid userId or itemId' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({
    description: 'User or transformation result not available',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiResponse({ status: 500, description: 'Storage or streaming failure' })
  async download(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Req() request: RequestWithUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const startedMs = Date.now();
    const identity = {
      actorUserId: request.user.id,
      targetUserId: userId,
    };

    if (
      !this.accessConfigService.hasPermission(
        request.user.roles,
        'transformation-history',
        'download-any',
      )
    ) {
      await this.auditService.record({
        ...identity,
        conversionRecordId: itemId,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.DENIED,
        durationMs: Date.now() - startedMs,
      });
      throw new ForbiddenException('Insufficient permissions');
    }

    if (!(await this.usersService.findById(userId))) {
      await this.auditService.record({
        ...identity,
        conversionRecordId: itemId,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.NOT_FOUND,
        durationMs: Date.now() - startedMs,
      });
      throw new NotFoundException('Transformation result not available');
    }

    let download: TransformationResultDownload;
    try {
      download = await this.downloads.prepare(userId, itemId);
    } catch (error) {
      const outcome =
        error instanceof TransformationResultDownloadException
          ? error.auditOutcome
          : TransformationResultAuditOutcome.STORAGE_FAILED;

      await this.auditService.record({
        ...identity,
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
      identity,
      startedMs,
    );
  }
}
