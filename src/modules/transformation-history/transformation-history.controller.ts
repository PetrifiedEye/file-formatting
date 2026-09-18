import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
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
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

import {
  JwtAuthGuard,
  RequestUser,
} from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';
import { UsersService } from '@/modules/users/users.service';

import { TransformationHistoryAuditOutcome } from './entities/transformation-history-audit-event.entity';
import { TransformationHistoryAuditFilter } from './transformation-history-audit.filter';
import { TransformationHistoryAuditService } from './transformation-history-audit.service';

import { TransformationHistoryPageDto } from './dto/transformation-history-page.dto';
import { TransformationHistoryQueryDto } from './dto/transformation-history-query.dto';
import { TransformationHistoryService } from './transformation-history.service';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

@ApiTags('transformation-history')
@Controller('api/transformations')
@UseGuards(JwtAuthGuard)
// Scoped to this controller rather than registered as an APP_FILTER, and that
// is load-bearing: only one filter handles a given exception, and a second
// global filter catching UnauthorizedException/BadRequestException/
// ThrottlerException would take those away from `UserDirectoryAuditFilter`,
// silently emptying feature 010's audit trail. Controller-scoped, it sees its
// own routes and nothing else.
@UseFilters(TransformationHistoryAuditFilter)
export class TransformationHistoryController {
  constructor(
    private readonly transformationHistoryService: TransformationHistoryService,
    private readonly accessConfigService: AccessConfigService,
    private readonly usersService: UsersService,
    private readonly auditService: TransformationHistoryAuditService,
  ) {}

  /**
   * Which filter *kinds* the caller used — never what they were set to
   * (FR-018). Knowing an admin narrowed by source format is oversight;
   * knowing which format they were looking for is not.
   */
  private filtersUsed(query: TransformationHistoryQueryDto) {
    return {
      typeFilterUsed: query.type !== undefined,
      sourceFormatFilterUsed: query.sourceFormat !== undefined,
      targetFormatFilterUsed: query.targetFormat !== undefined,
      statusFilterUsed: query.status !== undefined,
      dateRangeFilterUsed:
        query.createdAtFrom !== undefined || query.createdAtTo !== undefined,
    };
  }

  /**
   * The caller's own history. Being signed in is the whole authorization
   * story — no permission is consulted, deliberately (FR-001): a permission
   * that could be revoked would make a user's own record unreadable to them.
   */
  @Get('history')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'Read your own file and image transformation history',
  })
  @ApiOkResponse({ type: TransformationHistoryPageDto })
  @ApiBadRequestResponse({ description: 'Invalid query options or cursor' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async getOwnHistory(
    @Query() query: TransformationHistoryQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<TransformationHistoryPageDto> {
    const page = await this.transformationHistoryService.getHistory(
      request.user.id,
      query,
    );

    await this.auditService.record({
      actorUserId: request.user.id,
      outcome: TransformationHistoryAuditOutcome.SUCCESS,
      resultCount: page.items.length,
      ...this.filtersUsed(query),
    });

    return page;
  }

  /**
   * Another user's history, for oversight.
   *
   * The permission is checked here rather than by a class-level guard because
   * this controller also carries a self route that must never require one — a
   * single guard cannot express "permission on this route, none on that one"
   * (the same reason `UsersController` checks `users:list` by hand).
   *
   * The check runs before the existence check, deliberately: answering 404 to
   * a caller who may not read anyone's history would turn this route into an
   * account-enumeration oracle.
   */
  @Get('history/:userId')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: "Read another user's transformation history" })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: TransformationHistoryPageDto })
  @ApiBadRequestResponse({
    description: 'Invalid userId, query options or cursor',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'No such user' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async getUserHistory(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: TransformationHistoryQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<TransformationHistoryPageDto> {
    const hasPermission = this.accessConfigService.hasPermission(
      request.user.roles,
      'transformation-history',
      'read-any',
    );

    if (!hasPermission) {
      await this.auditService.record({
        actorUserId: request.user.id,
        targetUserId: userId,
        outcome: TransformationHistoryAuditOutcome.DENIED,
        ...this.filtersUsed(query),
      });
      throw new ForbiddenException('Insufficient permissions');
    }

    const target = await this.usersService.findById(userId);

    if (!target) {
      await this.auditService.record({
        actorUserId: request.user.id,
        targetUserId: userId,
        outcome: TransformationHistoryAuditOutcome.NOT_FOUND,
        ...this.filtersUsed(query),
      });
      throw new NotFoundException('User not found');
    }

    const page = await this.transformationHistoryService.getHistory(
      userId,
      query,
    );

    await this.auditService.record({
      actorUserId: request.user.id,
      targetUserId: userId,
      outcome: TransformationHistoryAuditOutcome.SUCCESS,
      resultCount: page.items.length,
      ...this.filtersUsed(query),
    });

    return page;
  }
}
