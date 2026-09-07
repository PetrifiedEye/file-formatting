import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { ConfigService } from '@/core/config/config.service';

import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { IssuedSession } from './session.service';
import { RegisterRequestDto } from './dto/register-request.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { ConfirmCodeRequestDto } from './dto/confirm-code-request.dto';
import { ConfirmSuccessResponseDto } from './dto/confirm-success-response.dto';
import { ResendRequestDto } from './dto/resend-request.dto';
import { ResendResponseDto } from './dto/resend-response.dto';
import { LoginRequestDto } from './dto/login-request.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { LoginVerifyRequestDto } from './dto/login-verify-request.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';

const SESSION_COOKIE_NAME = 'session';

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
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
    private readonly configService: ConfigService,
  ) {}

  private setSessionCookie(reply: FastifyReply, session: IssuedSession) {
    reply.setCookie(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.session.expiresAt,
    });
  }

  private clearSessionCookie(reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }

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

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  @ApiForbiddenResponse({ description: 'Email not confirmed' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async login(
    @Body() dto: LoginRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponseDto> {
    const { response, session } = await this.authService.login(
      dto,
      extractMeta(req),
    );

    if (session) {
      this.setSessionCookie(reply, session);
    }

    return response;
  }

  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Complete a pending sign-in verification' })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({
    description: 'Wrong/expired code or attempts exhausted',
  })
  @ApiNotFoundResponse({ description: 'No pending sign-in verification' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async verifyLogin(
    @Body() dto: LoginVerifyRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponseDto> {
    const { response, session } = await this.authService.verifyLogin(
      dto,
      extractMeta(req),
    );

    if (session) {
      this.setSessionCookie(reply, session);
    }

    return response;
  }

  @Get('login/verify/link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a pending sign-in verification via magic link',
  })
  @ApiQuery({ name: 'token', required: true, minLength: 32 })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid, expired, or already-used link',
  })
  async verifyLoginByLink(
    @Query('token') token: string,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponseDto> {
    const { response, session } = await this.authService.verifyLoginByLink(
      token,
      extractMeta(req),
    );

    if (session) {
      this.setSessionCookie(reply, session);
    }

    return response;
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @ApiOperation({ summary: 'Request a password reset email' })
  @ApiOkResponse({ description: 'Generic acknowledgement, always 200' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<{ message: string }> {
    return this.passwordResetService.requestReset(dto.email, extractMeta(req));
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a password reset with a new password' })
  @ApiOkResponse({ description: 'Password reset' })
  @ApiBadRequestResponse({
    description: 'Invalid/expired/used code, or password policy violation',
  })
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<{ message: string }> {
    return this.passwordResetService.confirmReset(dto, extractMeta(req));
  }

  @Get('password-reset/confirm/link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a password reset magic link for a code' })
  @ApiQuery({ name: 'token', required: true, minLength: 32 })
  @ApiOkResponse({ description: 'Email and code to submit to confirm' })
  @ApiBadRequestResponse({
    description: 'Invalid, expired, or already-used link',
  })
  async exchangePasswordResetLink(
    @Query('token') token: string,
  ): Promise<{ email: string; code: string }> {
    return this.passwordResetService.exchangeLinkToken(token);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: 'Log out and invalidate the current session' })
  @ApiOkResponse({ description: 'Signed out' })
  @ApiUnauthorizedResponse({ description: 'No valid session' })
  async logout(
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string | undefined>;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ message: string }> {
    const result = await this.authService.logout(
      req.cookies?.[SESSION_COOKIE_NAME],
      extractMeta(req),
    );

    this.clearSessionCookie(reply);

    return result;
  }
}
