import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';

import {
  JwtAuthGuard,
  RequestUser,
} from '@/modules/auth/guards/jwt-auth.guard';

import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { UsersService } from './users.service';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
}
