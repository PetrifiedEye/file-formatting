import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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

import { AccountDeletionAuditService } from './account-deletion-audit.service';
import {
  AccountDeletionService,
  AdminDeleteResult,
} from './account-deletion.service';
import { AdminUpdateEmailDto } from './dto/admin-update-email.dto';
import { ConfirmAccountDeletionDto } from './dto/confirm-account-deletion.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { InitiateEmailChangeDto } from './dto/initiate-email-change.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { EmailChangeService } from './email-change.service';
import {
  AccountDeletionAuditAction,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';
import {
  ProfileAuditAction,
  ProfileAuditOutcome,
} from './entities/profile-audit-event.entity';
import { User } from './entities/user.entity';
import { ProfileAuditService } from './profile-audit.service';
import { UsersService } from './users.service';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

function toUserProfileResponse(user: User): UserProfileResponseDto {
  return {
    id: user.id,
    photo: user.photoUrl,
    email: user.email,
    status: user.status,
    createdAt: user.createdAt,
  };
}

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly emailChangeService: EmailChangeService,
    private readonly profileAuditService: ProfileAuditService,
    private readonly accessConfigService: AccessConfigService,
    private readonly accountDeletionService: AccountDeletionService,
    private readonly accountDeletionAuditService: AccountDeletionAuditService,
  ) {}

  @Get(':userId')
  @ApiOperation({ summary: "Get a user's profile" })
  @ApiOkResponse({ type: UserProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async getProfile(
    @Param('userId') userId: string,
    @Req() request: RequestWithUser,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.getProfileFor(request.user, userId);
  }

  @Patch(':userId')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: "Update a user's profile photo" })
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({ type: UserProfileResponseDto })
  @ApiBadRequestResponse({
    description:
      'No photo part present, unrecognized field present, or invalid photo file',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async updateProfile(
    @Param('userId') userId: string,
    @Req() request: RequestWithUser,
  ): Promise<UserProfileResponseDto> {
    const isSelf = userId === request.user.id;
    const hasPermission = this.accessConfigService.hasPermission(
      request.user.roles,
      'users',
      'update',
    );

    if (!isSelf && !hasPermission) {
      await this.profileAuditService.record(
        request.user.id,
        userId,
        ProfileAuditAction.PROFILE_UPDATE,
        ProfileAuditOutcome.DENIED,
        ['photo'],
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    let photoBuffer: Buffer | undefined;
    let hasUnrecognizedField = false;

    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'photo' || photoBuffer) {
            hasUnrecognizedField = true;
            await part.toBuffer().catch(() => undefined);
            continue;
          }
          photoBuffer = await part.toBuffer();
        } else {
          hasUnrecognizedField = true;
        }
      }
    }

    if (hasUnrecognizedField || !photoBuffer) {
      await this.profileAuditService.record(
        request.user.id,
        userId,
        ProfileAuditAction.PROFILE_UPDATE,
        ProfileAuditOutcome.FAILURE,
        ['photo'],
      );
      throw new BadRequestException(
        'Request must contain exactly one "photo" file part and nothing else',
      );
    }

    let user: User;
    try {
      user = await this.usersService.updatePhoto(userId, photoBuffer);
    } catch (error) {
      const outcome =
        error instanceof BadRequestException
          ? ProfileAuditOutcome.FAILURE
          : ProfileAuditOutcome.NOT_FOUND;
      await this.profileAuditService.record(
        request.user.id,
        userId,
        ProfileAuditAction.PROFILE_UPDATE,
        outcome,
        ['photo'],
      );
      throw error;
    }

    await this.profileAuditService.record(
      request.user.id,
      userId,
      ProfileAuditAction.PROFILE_UPDATE,
      ProfileAuditOutcome.SUCCESS,
      ['photo'],
    );

    return isSelf
      ? toUserProfileResponse(user)
      : { id: user.id, photo: user.photoUrl };
  }

  @Post('me/email-change')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 600000 } })
  @ApiOperation({ summary: 'Initiate an email change for the caller' })
  @ApiOkResponse({ description: 'Confirmation sent to the new email' })
  @ApiBadRequestResponse({ description: 'Invalid email format' })
  @ApiConflictResponse({
    description: 'Email already used by another account',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async initiateEmailChange(
    @Req() request: RequestWithUser,
    @Body() dto: InitiateEmailChangeDto,
  ): Promise<{ message: string }> {
    const user = await this.requireCallerUser(request);
    return this.emailChangeService.initiate(user, dto.newEmail);
  }

  @Post('me/email-change/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @ApiOperation({ summary: 'Resend the pending email-change confirmation' })
  @ApiOkResponse({ description: 'New confirmation sent' })
  @ApiBadRequestResponse({ description: 'No pending email change request' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async resendEmailChange(
    @Req() request: RequestWithUser,
  ): Promise<{ message: string }> {
    const user = await this.requireCallerUser(request);
    return this.emailChangeService.resend(user);
  }

  @Post('me/email-change/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Confirm a pending email change' })
  @ApiOkResponse({ type: UserProfileResponseDto })
  @ApiBadRequestResponse({
    description: 'Wrong code, expired, or attempts exhausted',
  })
  @ApiConflictResponse({
    description: 'Email became taken by another account',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async confirmEmailChange(
    @Req() request: RequestWithUser,
    @Body() dto: ConfirmEmailChangeDto,
  ): Promise<UserProfileResponseDto> {
    const user = await this.requireCallerUser(request);
    const updated = await this.emailChangeService.confirm(user, dto.code);
    return toUserProfileResponse(updated);
  }

  @Patch(':userId/email')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: "Directly update another user's email (admin)" })
  @ApiOkResponse({ description: 'Email updated immediately' })
  @ApiBadRequestResponse({ description: 'Invalid email format' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Missing permission, or caller targeted themselves',
  })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiConflictResponse({
    description: 'Email already used by another account',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async updateEmailDirect(
    @Param('userId') userId: string,
    @Req() request: RequestWithUser,
    @Body() dto: AdminUpdateEmailDto,
  ): Promise<{ id: string; photo: string | null; email: string }> {
    const hasPermission = this.accessConfigService.hasPermission(
      request.user.roles,
      'users',
      'update-email',
    );

    if (!hasPermission || userId === request.user.id) {
      await this.profileAuditService.record(
        request.user.id,
        userId,
        ProfileAuditAction.ADMIN_EMAIL_UPDATE,
        ProfileAuditOutcome.DENIED,
        ['email'],
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    let user: User;
    try {
      user = await this.usersService.updateEmailDirect(userId, dto.email);
    } catch (error) {
      const outcome =
        error instanceof BadRequestException ||
        error instanceof ConflictException
          ? ProfileAuditOutcome.FAILURE
          : ProfileAuditOutcome.NOT_FOUND;
      await this.profileAuditService.record(
        request.user.id,
        userId,
        ProfileAuditAction.ADMIN_EMAIL_UPDATE,
        outcome,
        ['email'],
      );
      throw error;
    }

    await this.profileAuditService.record(
      request.user.id,
      userId,
      ProfileAuditAction.ADMIN_EMAIL_UPDATE,
      ProfileAuditOutcome.SUCCESS,
      ['email'],
    );

    return { id: user.id, photo: user.photoUrl, email: user.email };
  }

  @Post('me/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 600000 } })
  @ApiOperation({ summary: 'Initiate deletion of the caller’s own account' })
  @ApiAcceptedResponse({
    description: 'Confirmation sent; nothing deleted yet',
  })
  @ApiConflictResponse({ description: 'Account is already mid-deletion' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async initiateSelfDelete(
    @Req() request: RequestWithUser,
  ): Promise<{ message: string }> {
    const user = await this.requireCallerUser(request);
    return this.accountDeletionService.initiateSelfDelete(user);
  }

  @Post('me/delete/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @ApiOperation({ summary: 'Resend the pending self-deletion confirmation' })
  @ApiAcceptedResponse({ description: 'New confirmation sent' })
  @ApiBadRequestResponse({ description: 'No pending account deletion request' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async resendSelfDelete(
    @Req() request: RequestWithUser,
  ): Promise<{ message: string }> {
    const user = await this.requireCallerUser(request);
    return this.accountDeletionService.resendSelfDelete(user);
  }

  @Post('me/delete/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Confirm and complete self-deletion' })
  @ApiOkResponse({ description: 'Account deleted' })
  @ApiBadRequestResponse({
    description: 'Wrong code, expired, or attempts exhausted',
  })
  @ApiConflictResponse({ description: 'Account is already mid-deletion' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async confirmSelfDelete(
    @Req() request: RequestWithUser,
    @Body() dto: ConfirmAccountDeletionDto,
  ): Promise<{ message: string }> {
    const user = await this.requireCallerUser(request);
    return this.accountDeletionService.confirmSelfDelete(user, dto.code);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: "Directly delete another user's account (admin)" })
  @ApiOkResponse({ description: 'Account deleted, or already removed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Missing permission, or caller targeted themselves',
  })
  @ApiConflictResponse({ description: 'Account is already mid-deletion' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async adminDeleteUser(
    @Param('userId') userId: string,
    @Req() request: RequestWithUser,
  ): Promise<{ message: string }> {
    const hasPermission = this.accessConfigService.hasPermission(
      request.user.roles,
      'users',
      'delete',
    );

    if (!hasPermission || userId === request.user.id) {
      await this.accountDeletionAuditService.record(
        request.user.id,
        userId,
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.DENIED,
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    let result: AdminDeleteResult;
    try {
      result = await this.accountDeletionService.adminDelete(userId);
    } catch (error) {
      await this.accountDeletionAuditService.record(
        request.user.id,
        userId,
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.CONFLICT,
      );
      throw error;
    }

    await this.accountDeletionAuditService.record(
      request.user.id,
      userId,
      AccountDeletionAuditAction.ADMIN_DELETE,
      result.outcome === 'deleted'
        ? AccountDeletionAuditOutcome.SUCCESS
        : AccountDeletionAuditOutcome.NOT_FOUND,
    );

    return { message: result.message };
  }

  private async requireCallerUser(request: RequestWithUser): Promise<User> {
    const user = await this.usersService.findById(request.user.id);
    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return user;
  }
}
