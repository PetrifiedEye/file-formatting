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

import { AuthService, IssuedTokens } from './auth.service';
import { PasswordResetService } from './password-reset.service';
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

const ACCESS_TOKEN_COOKIE_NAME = 'access_token';
const REFRESH_TOKEN_COOKIE_NAME = 'refresh_token';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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

  private setAuthCookies(reply: FastifyReply, tokens: IssuedTokens) {
    const secure = this.configService.get('NODE_ENV') === 'production';

    reply.setCookie(ACCESS_TOKEN_COOKIE_NAME, tokens.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    });
    reply.setCookie(REFRESH_TOKEN_COOKIE_NAME, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/auth',
      maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
    });
  }

  private clearAuthCookies(reply: FastifyReply) {
    reply.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' });
    reply.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: '/auth' });
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
    const { response, tokens } = await this.authService.login(
      dto,
      extractMeta(req),
    );

    if (tokens) {
      this.setAuthCookies(reply, tokens);
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
    const { response, tokens } = await this.authService.verifyLogin(
      dto,
      extractMeta(req),
    );

    if (tokens) {
      this.setAuthCookies(reply, tokens);
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
    const { response, tokens } = await this.authService.verifyLoginByLink(
      token,
      extractMeta(req),
    );

    if (tokens) {
      this.setAuthCookies(reply, tokens);
    }

    return response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Renew the session using the refresh token' })
  @ApiOkResponse({ description: 'Session refreshed' })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired refresh token',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async refresh(
    @Req()
    req: {
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string | undefined>;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ message: string }> {
    const tokens = await this.authService.refresh(
      req.cookies?.[REFRESH_TOKEN_COOKIE_NAME],
      extractMeta(req),
    );

    this.setAuthCookies(reply, tokens);

    return { message: 'Session refreshed.' };
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
  @ApiOperation({ summary: 'Log out and clear the session cookies' })
  @ApiOkResponse({ description: 'Signed out' })
  logout(@Res({ passthrough: true }) reply: FastifyReply): { message: string } {
    const result = this.authService.logout();

    this.clearAuthCookies(reply);

    return result;
  }
}
