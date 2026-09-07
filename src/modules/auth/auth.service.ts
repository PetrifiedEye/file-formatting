import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { validatePassword } from '@/modules/settings/password-policy.validator';
import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import { ConfirmationChallengeService } from './confirmation-challenge.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import {
  RegistrationAuditEventType,
  RegistrationAuditOutcome,
} from './entities/registration-audit-event.entity';
import { RegistrationAuditService } from './registration-audit.service';
import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';
import { LoginAuditService } from './login-audit.service';
import { TokenService } from './token.service';
import {
  LoginChallengeService,
  LoginChallengeVerifyFailure,
} from './login-challenge.service';
import { normalizeEmail } from './utils/email-normalizer';
import {
  EMAIL_CAP_MAX,
  EMAIL_CAP_WINDOW_MS,
  generateConfirmationTokens,
  hashSecret,
  PENDING_TTL_MS,
  RESEND_INTERVAL_MS,
} from './utils/confirmation-token';
import { hashPassword, verifyPassword } from './utils/password-hasher';
import { RegisterRequestDto } from './dto/register-request.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { ConfirmCodeRequestDto } from './dto/confirm-code-request.dto';
import { ConfirmSuccessResponseDto } from './dto/confirm-success-response.dto';
import { ResendRequestDto } from './dto/resend-request.dto';
import { ResendResponseDto } from './dto/resend-response.dto';
import { LoginRequestDto } from './dto/login-request.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { LoginVerifyRequestDto } from './dto/login-verify-request.dto';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const CONFIRMATION_ON_MESSAGE =
  'If this email is eligible, registration instructions have been sent.';
const CONFIRMATION_OFF_MESSAGE =
  'If this email is eligible, your account is ready to sign in.';
const RESEND_MESSAGE =
  'If a pending registration exists, a new confirmation email has been sent.';
const CONFIRM_SUCCESS_MESSAGE =
  'Your account is ready. You may sign in with your credentials.';
const GENERIC_CONFIRM_FAILURE =
  'Unable to confirm registration. Please check your code or request a new one.';
const GENERIC_NOT_FOUND = 'No pending registration found for this email.';
const LOGIN_SUCCESS_MESSAGE = 'Signed in.';
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';
const PENDING_CONFIRMATION_MESSAGE =
  'Please confirm your email before signing in.';
const LOGOUT_MESSAGE = 'Signed out.';
const VERIFICATION_REQUIRED_MESSAGE =
  'Enter the code sent to your email to finish signing in.';
const GENERIC_LOGIN_VERIFY_FAILURE =
  'Unable to verify sign-in. Please check your code or start over.';
const GENERIC_LOGIN_VERIFY_NOT_FOUND =
  'No pending sign-in verification found for this email.';
const LOCKOUT_MESSAGE = 'Too many failed attempts. Try again later.';
const REFRESH_FAILURE_MESSAGE = 'Authentication required';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  response: LoginResponseDto;
  tokens?: IssuedTokens;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
    private readonly auditService: RegistrationAuditService,
    private readonly challengeService: ConfirmationChallengeService,
    private readonly confirmationMailService: ConfirmationMailService,
    private readonly loginAuditService: LoginAuditService,
    private readonly tokenService: TokenService,
    private readonly loginChallengeService: LoginChallengeService,
  ) {}

  private async issueTokens(userId: string): Promise<IssuedTokens> {
    const [accessToken, refreshToken] = await Promise.all([
      this.tokenService.signAccessToken(userId),
      this.tokenService.signRefreshToken(userId),
    ]);

    return { accessToken, refreshToken };
  }

  async login(dto: LoginRequestDto, meta: RequestMeta): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(dto.email);
    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (user && this.usersService.isLockedOut(user)) {
      await this.loginAuditService.record(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.LOCKED_OUT,
        {
          normalizedEmail,
          userId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'locked_out',
        },
      );
      throw new HttpException({ message: LOCKOUT_MESSAGE }, HttpStatus.LOCKED);
    }

    const passwordValid = user
      ? await verifyPassword(dto.password, user.passwordHash)
      : false;

    if (!user || !passwordValid) {
      if (user) {
        await this.usersService.recordFailedLogin(user);
      }

      await this.loginAuditService.record(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.FAILURE,
        {
          normalizedEmail,
          userId: user?.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'invalid_credentials',
        },
      );
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    if (user.status === UserStatus.PENDING_CONFIRMATION) {
      await this.loginAuditService.record(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.FAILURE,
        {
          normalizedEmail,
          userId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'email_not_confirmed',
        },
      );
      throw new ForbiddenException({
        message: PENDING_CONFIRMATION_MESSAGE,
        canResend: true,
      });
    }

    await this.usersService.recordSuccessfulLogin(user);

    await this.loginAuditService.record(
      LoginAuditEventType.LOGIN_ATTEMPT,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    const settings = await this.settingsService.getSettings();

    if (settings.signInConfirmationEnabled) {
      const { tokens } = await this.loginChallengeService.issue(user.id);
      await this.confirmationMailService.sendLoginVerificationEmail(
        normalizedEmail,
        tokens.otp,
        tokens.linkToken,
      );

      return {
        response: {
          message: VERIFICATION_REQUIRED_MESSAGE,
          verificationRequired: true,
        },
      };
    }

    const tokens = await this.issueTokens(user.id);

    return {
      response: {
        message: LOGIN_SUCCESS_MESSAGE,
        verificationRequired: false,
      },
      tokens,
    };
  }

  @Transactional()
  async verifyLogin(
    dto: LoginVerifyRequestDto,
    meta: RequestMeta = {},
  ): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(dto.email);
    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (!user) {
      await this.recordLoginVerifyFailure(
        normalizedEmail,
        undefined,
        'no_pending_verification',
      );
      throw new NotFoundException(GENERIC_LOGIN_VERIFY_NOT_FOUND);
    }

    const result = await this.loginChallengeService.verifyByCode(
      user.id,
      dto.code,
    );

    if (!result.ok && result.reason === LoginChallengeVerifyFailure.NOT_FOUND) {
      await this.recordLoginVerifyFailure(
        normalizedEmail,
        user.id,
        result.reason,
      );
      throw new NotFoundException(GENERIC_LOGIN_VERIFY_NOT_FOUND);
    }

    return this.finalizeLoginVerification(result, normalizedEmail, user, meta);
  }

  @Transactional()
  async verifyLoginByLink(
    token: string,
    meta: RequestMeta = {},
  ): Promise<LoginResult> {
    const result = await this.loginChallengeService.verifyByLinkToken(token);

    if (!result.ok) {
      await this.recordLoginVerifyFailure('unknown', undefined, result.reason);
      throw new BadRequestException(GENERIC_LOGIN_VERIFY_FAILURE);
    }

    const user = await this.usersService.findById(result.challenge.userId);
    if (!user) {
      throw new BadRequestException(GENERIC_LOGIN_VERIFY_FAILURE);
    }

    return this.finalizeLoginVerification(result, user.email, user, meta);
  }

  private async finalizeLoginVerification(
    result:
      | { ok: true; challenge: { userId: string } }
      | {
          ok: false;
          reason: LoginChallengeVerifyFailure;
        },
    normalizedEmail: string,
    user: User,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    if (!result.ok) {
      await this.recordLoginVerifyFailure(
        normalizedEmail,
        user.id,
        result.reason,
      );
      throw new BadRequestException(GENERIC_LOGIN_VERIFY_FAILURE);
    }

    const tokens = await this.issueTokens(user.id);

    await this.loginAuditService.record(
      LoginAuditEventType.LOGIN_VERIFICATION_ATTEMPT,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    return {
      response: {
        message: LOGIN_SUCCESS_MESSAGE,
        verificationRequired: false,
      },
      tokens,
    };
  }

  private async recordLoginVerifyFailure(
    normalizedEmail: string,
    userId: string | undefined,
    failureReason: string,
  ): Promise<void> {
    await this.loginAuditService.record(
      LoginAuditEventType.LOGIN_VERIFICATION_ATTEMPT,
      LoginAuditOutcome.FAILURE,
      {
        normalizedEmail,
        userId,
        failureReason,
      },
    );
  }

  logout(): { message: string } {
    return { message: LOGOUT_MESSAGE };
  }

  async refresh(
    rawRefreshToken: string | undefined,
    meta: RequestMeta,
  ): Promise<IssuedTokens> {
    if (!rawRefreshToken) {
      await this.recordRefreshFailure(undefined, meta, 'missing');
      throw new UnauthorizedException(REFRESH_FAILURE_MESSAGE);
    }

    let sub: string;
    try {
      ({ sub } = await this.tokenService.verifyRefreshToken(rawRefreshToken));
    } catch {
      await this.recordRefreshFailure(undefined, meta, 'invalid');
      throw new UnauthorizedException(REFRESH_FAILURE_MESSAGE);
    }

    const user = await this.usersService.findById(sub);

    if (!user) {
      await this.recordRefreshFailure(sub, meta, 'user_not_found');
      throw new UnauthorizedException(REFRESH_FAILURE_MESSAGE);
    }

    if (user.status !== UserStatus.ACTIVE) {
      await this.recordRefreshFailure(user.id, meta, 'user_inactive');
      throw new UnauthorizedException(REFRESH_FAILURE_MESSAGE);
    }

    const tokens = await this.issueTokens(user.id);

    await this.loginAuditService.record(
      LoginAuditEventType.TOKEN_REFRESH_ATTEMPT,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail: user.email,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    return tokens;
  }

  private async recordRefreshFailure(
    userId: string | undefined,
    meta: RequestMeta,
    failureReason: string,
  ): Promise<void> {
    await this.loginAuditService.record(
      LoginAuditEventType.TOKEN_REFRESH_ATTEMPT,
      LoginAuditOutcome.FAILURE,
      {
        normalizedEmail: 'unknown',
        userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        failureReason,
      },
    );
  }

  async register(
    dto: RegisterRequestDto,
    meta: RequestMeta,
  ): Promise<RegisterResponseDto> {
    const normalizedEmail = normalizeEmail(dto.email);
    const settings = await this.settingsService.getSettings();

    const passwordResult = validatePassword(dto.password, settings);
    if (!passwordResult.valid) {
      await this.auditService.record(
        RegistrationAuditEventType.REGISTRATION_ATTEMPT,
        RegistrationAuditOutcome.FAILURE,
        {
          normalizedEmail,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'invalid_password',
        },
      );
      throw new BadRequestException(passwordResult.errors);
    }

    await this.usersService.deleteExpiredPendingUsers();

    const existing =
      await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (existing?.status === UserStatus.ACTIVE) {
      await this.auditService.record(
        RegistrationAuditEventType.REGISTRATION_ATTEMPT,
        RegistrationAuditOutcome.FAILURE,
        {
          normalizedEmail,
          userId: existing.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'duplicate_email',
        },
      );

      return this.buildRegisterResponse(
        settings.registrationConfirmationEnabled,
      );
    }

    if (existing?.status === UserStatus.PENDING_CONFIRMATION) {
      if (settings.registrationConfirmationEnabled) {
        return this.handlePendingReRegister(existing, normalizedEmail, meta);
      }

      await this.auditService.record(
        RegistrationAuditEventType.REGISTRATION_ATTEMPT,
        RegistrationAuditOutcome.FAILURE,
        {
          normalizedEmail,
          userId: existing.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'duplicate_email',
        },
      );

      return this.buildRegisterResponse(false);
    }

    const passwordHash = await hashPassword(dto.password);

    if (!settings.registrationConfirmationEnabled) {
      const user = await this.usersService.create({
        email: normalizedEmail,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
        pendingExpiresAt: null,
      });

      await this.auditService.record(
        RegistrationAuditEventType.REGISTRATION_ATTEMPT,
        RegistrationAuditOutcome.SUCCESS,
        {
          normalizedEmail,
          userId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      );

      return this.buildRegisterResponse(false);
    }

    const now = new Date();
    const pendingExpiresAt = new Date(now.getTime() + PENDING_TTL_MS);

    const user = await this.usersService.create({
      email: normalizedEmail,
      passwordHash,
      status: UserStatus.PENDING_CONFIRMATION,
      pendingExpiresAt,
    });

    await this.sendConfirmationEmail(user, normalizedEmail, meta, now);

    await this.auditService.record(
      RegistrationAuditEventType.REGISTRATION_ATTEMPT,
      RegistrationAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    return this.buildRegisterResponse(true);
  }

  @Transactional()
  async confirmByCode(
    dto: ConfirmCodeRequestDto,
    meta: RequestMeta,
  ): Promise<ConfirmSuccessResponseDto> {
    const normalizedEmail = normalizeEmail(dto.email);
    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (!user || user.status !== UserStatus.PENDING_CONFIRMATION) {
      await this.auditService.record(
        RegistrationAuditEventType.CONFIRMATION_ATTEMPT,
        RegistrationAuditOutcome.FAILURE,
        {
          normalizedEmail,
          userId: user?.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'no_pending_registration',
        },
      );
      throw new NotFoundException(GENERIC_NOT_FOUND);
    }

    const challenge = await this.challengeService.findActiveByUserId(user.id);

    if (!challenge || this.isChallengeExpired(challenge.expiresAt)) {
      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'expired_code',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (challenge.attemptsRemaining <= 0) {
      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'attempts_exhausted',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const codeHash = hashSecret(dto.code);
    if (codeHash !== challenge.otpHash) {
      challenge.attemptsRemaining -= 1;
      await this.challengeService.save(challenge);

      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'wrong_code',
        { attemptsRemaining: challenge.attemptsRemaining },
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    await this.activateUserWithChallenge(
      user,
      challenge,
      normalizedEmail,
      meta,
    );

    return { message: CONFIRM_SUCCESS_MESSAGE, accountReady: true };
  }

  @Transactional()
  async confirmByLink(
    token: string,
    meta: RequestMeta,
  ): Promise<ConfirmSuccessResponseDto> {
    if (!token || token.length < 32) {
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const linkTokenHash = hashSecret(token);
    const challenge =
      await this.challengeService.findByLinkTokenHash(linkTokenHash);

    if (!challenge) {
      await this.auditService.record(
        RegistrationAuditEventType.CONFIRMATION_ATTEMPT,
        RegistrationAuditOutcome.FAILURE,
        {
          normalizedEmail: 'unknown',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          failureReason: 'invalid_link',
        },
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const user = challenge.user;
    const normalizedEmail = user.email;

    // A link that already activated the account is safe to replay
    // idempotently (e.g. the user double-clicked the email link).
    if (challenge.consumedAt) {
      if (user.status === UserStatus.ACTIVE) {
        return { message: CONFIRM_SUCCESS_MESSAGE, accountReady: true };
      }

      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'invalid_link',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (challenge.invalidatedAt) {
      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'invalid_link',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (user.status === UserStatus.ACTIVE) {
      return { message: CONFIRM_SUCCESS_MESSAGE, accountReady: true };
    }

    if (this.isChallengeExpired(challenge.expiresAt)) {
      await this.recordConfirmFailure(
        normalizedEmail,
        user.id,
        meta,
        'expired_link',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    await this.activateUserWithChallenge(
      user,
      challenge,
      normalizedEmail,
      meta,
    );

    return { message: CONFIRM_SUCCESS_MESSAGE, accountReady: true };
  }

  async resendConfirmation(
    dto: ResendRequestDto,
    meta: RequestMeta,
  ): Promise<ResendResponseDto> {
    const normalizedEmail = normalizeEmail(dto.email);
    const settings = await this.settingsService.getSettings();

    if (!settings.registrationConfirmationEnabled) {
      return { message: RESEND_MESSAGE };
    }

    await this.usersService.deleteExpiredPendingUsers();

    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (!user || user.status !== UserStatus.PENDING_CONFIRMATION) {
      return { message: RESEND_MESSAGE };
    }

    const activeChallenge = await this.challengeService.findActiveByUserId(
      user.id,
    );

    if (activeChallenge) {
      const elapsed = Date.now() - activeChallenge.lastSentAt.getTime();
      if (elapsed < RESEND_INTERVAL_MS) {
        throw new HttpException(
          'Please wait before requesting another confirmation email.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const now = new Date();
    await this.enforceEmailCap(normalizedEmail, now);

    await this.sendConfirmationEmail(user, normalizedEmail, meta, now);

    return { message: RESEND_MESSAGE };
  }

  private async handlePendingReRegister(
    user: User,
    normalizedEmail: string,
    meta: RequestMeta,
  ): Promise<RegisterResponseDto> {
    const activeChallenge = await this.challengeService.findActiveByUserId(
      user.id,
    );

    if (activeChallenge) {
      const elapsed = Date.now() - activeChallenge.lastSentAt.getTime();
      if (elapsed < RESEND_INTERVAL_MS) {
        throw new HttpException(
          'Please wait before requesting another confirmation email.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const now = new Date();
    await this.enforceEmailCap(normalizedEmail, now);
    await this.sendConfirmationEmail(user, normalizedEmail, meta, now);

    await this.auditService.record(
      RegistrationAuditEventType.REGISTRATION_ATTEMPT,
      RegistrationAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { reRegisterPending: true },
      },
    );

    return this.buildRegisterResponse(true);
  }

  private async sendConfirmationEmail(
    user: User,
    normalizedEmail: string,
    meta: RequestMeta,
    now: Date,
  ): Promise<void> {
    await this.enforceEmailCap(normalizedEmail, now);

    const tokens = generateConfirmationTokens();
    await this.challengeService.createChallenge({
      userId: user.id,
      tokens,
      lastSentAt: now,
    });

    await this.usersService.updatePendingExpiry(
      user,
      new Date(now.getTime() + PENDING_TTL_MS),
    );

    await this.confirmationMailService.sendConfirmationEmail(
      normalizedEmail,
      tokens.otp,
      tokens.linkToken,
    );

    await this.auditService.record(
      RegistrationAuditEventType.CONFIRMATION_EMAIL_SENT,
      RegistrationAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );
  }

  private async enforceEmailCap(
    normalizedEmail: string,
    now: Date,
  ): Promise<void> {
    const since = new Date(now.getTime() - EMAIL_CAP_WINDOW_MS);
    const count = await this.auditService.countConfirmationEmailsSince(
      normalizedEmail,
      since,
    );

    if (count >= EMAIL_CAP_MAX) {
      throw new HttpException(
        'Too many confirmation emails sent. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async activateUserWithChallenge(
    user: User,
    challenge: ConfirmationChallenge,
    normalizedEmail: string,
    meta: RequestMeta,
  ): Promise<void> {
    challenge.consumedAt = new Date();
    await this.challengeService.save(challenge);
    await this.usersService.activate(user);

    await this.auditService.record(
      RegistrationAuditEventType.CONFIRMATION_ATTEMPT,
      RegistrationAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );
  }

  private async recordConfirmFailure(
    normalizedEmail: string,
    userId: string,
    meta: RequestMeta,
    failureReason: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.record(
      RegistrationAuditEventType.CONFIRMATION_ATTEMPT,
      RegistrationAuditOutcome.FAILURE,
      {
        normalizedEmail,
        userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        failureReason,
        metadata,
      },
    );
  }

  private isChallengeExpired(expiresAt: Date): boolean {
    return Date.now() > expiresAt.getTime();
  }

  private buildRegisterResponse(
    confirmationRequired: boolean,
  ): RegisterResponseDto {
    return {
      message: confirmationRequired
        ? CONFIRMATION_ON_MESSAGE
        : CONFIRMATION_OFF_MESSAGE,
      confirmationRequired,
    };
  }
}
