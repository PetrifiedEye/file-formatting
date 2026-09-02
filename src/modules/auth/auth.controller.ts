import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { RegisterRequestDto } from './dto/register-request.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { ConfirmCodeRequestDto } from './dto/confirm-code-request.dto';
import { ConfirmSuccessResponseDto } from './dto/confirm-success-response.dto';
import { ResendRequestDto } from './dto/resend-request.dto';
import { ResendResponseDto } from './dto/resend-response.dto';

function extractMeta(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}) {
  const rawAgent = req.headers['user-agent'];
  const userAgent = Array.isArray(rawAgent) ? rawAgent[0] : (rawAgent ?? null);

  return {
    ipAddress: req.ip ?? null,
    userAgent,
  };
}

@ApiTags('Registration')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new account' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid email or password format' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async register(
    @Body() dto: RegisterRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<RegisterResponseDto> {
    return this.authService.register(dto, extractMeta(req));
  }

  @Post('register/confirm/code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm registration with OTP' })
  @ApiOkResponse({ type: ConfirmSuccessResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid, expired, or exhausted attempts',
  })
  @ApiNotFoundResponse({ description: 'No pending registration for email' })
  async confirmByCode(
    @Body() dto: ConfirmCodeRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<ConfirmSuccessResponseDto> {
    return this.authService.confirmByCode(dto, extractMeta(req));
  }

  @Get('register/confirm/link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm registration via magic link' })
  @ApiQuery({ name: 'token', required: true, minLength: 32 })
  @ApiOkResponse({ type: ConfirmSuccessResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid, expired, or already-used link',
  })
  async confirmByLink(
    @Query('token') token: string,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<ConfirmSuccessResponseDto> {
    return this.authService.confirmByLink(token, extractMeta(req));
  }

  @Post('register/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @ApiOperation({ summary: 'Resend confirmation email' })
  @ApiOkResponse({ type: ResendResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'Resend too soon or email cap exceeded',
  })
  async resendConfirmation(
    @Body() dto: ResendRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<ResendResponseDto> {
    return this.authService.resendConfirmation(dto, extractMeta(req));
  }
}
