import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { validatePassword } from '@/modules/settings/password-policy.validator';

import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';
import { LoginAuditService } from './login-audit.service';
import { SessionService } from './session.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import type { RequestMeta } from './auth.service';
import { normalizeEmail } from './utils/email-normalizer';
import { hashPassword } from './utils/password-hasher';
import {
  CONFIRMATION_TTL_MS,
  generateConfirmationTokens,
  hashSecret,
} from './utils/confirmation-token';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';

const REQUEST_MESSAGE =
  'If this email is registered, password reset instructions have been sent.';
const RESET_SUCCESS_MESSAGE = 'Your password has been reset. Please sign in.';
const GENERIC_CONFIRM_FAILURE =
  'Unable to reset password. Please check your code or request a new one.';

export interface ExchangedLinkToken {
  email: string;
  code: string;
}

@Injectable()
export class PasswordResetService {
  constructor(
    @InjectRepository(PasswordResetChallenge)
    private readonly challengeRepository: Repository<PasswordResetChallenge>,
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
    private readonly sessionService: SessionService,
    private readonly confirmationMailService: ConfirmationMailService,
    private readonly loginAuditService: LoginAuditService,
  ) {}

  async requestReset(
    email: string,
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    const normalizedEmail = normalizeEmail(email);
    const settings = await this.settingsService.getSettings();

    if (!settings.passwordRecoveryConfirmationEnabled) {
      return { message: REQUEST_MESSAGE };
    }

    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (!user || user.status !== UserStatus.ACTIVE) {
      return { message: REQUEST_MESSAGE };
    }

    const now = new Date();
    await this.invalidateActiveForUser(user.id);

    const tokens = generateConfirmationTokens();
    const challenge = this.challengeRepository.create({
      userId: user.id,
      otpHash: tokens.otpHash,
      linkTokenHash: tokens.linkTokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      attemptsRemaining: 5,
    });
    await this.challengeRepository.save(challenge);

    await this.confirmationMailService.sendPasswordResetEmail(
      normalizedEmail,
      tokens.otp,
      tokens.linkToken,
    );

    await this.loginAuditService.record(
      LoginAuditEventType.PASSWORD_RESET_REQUESTED,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    return { message: REQUEST_MESSAGE };
  }

  @Transactional()
  async confirmReset(
    dto: PasswordResetConfirmDto,
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    const normalizedEmail = normalizeEmail(dto.email);
    const user = await this.usersService.findByNormalizedEmail(normalizedEmail);

    if (!user) {
      await this.recordFailure(
        normalizedEmail,
        undefined,
        meta,
        'unknown_email',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const settings = await this.settingsService.getSettings();
    const passwordResult = validatePassword(dto.newPassword, settings);
    if (!passwordResult.valid) {
      await this.recordFailure(
        normalizedEmail,
        user.id,
        meta,
        'invalid_password',
      );
      throw new BadRequestException(passwordResult.errors);
    }

    const challenge = await this.findActiveByUserId(user.id);

    if (!challenge || this.isExpired(challenge.expiresAt)) {
      await this.recordFailure(normalizedEmail, user.id, meta, 'expired_code');
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (challenge.attemptsRemaining <= 0) {
      await this.recordFailure(
        normalizedEmail,
        user.id,
        meta,
        'attempts_exhausted',
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const codeHash = hashSecret(dto.code);
    const matches =
      codeHash === challenge.otpHash || codeHash === challenge.linkTokenHash;

    if (!matches) {
      challenge.attemptsRemaining -= 1;
      await this.challengeRepository.save(challenge);
      await this.recordFailure(normalizedEmail, user.id, meta, 'wrong_code');
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    challenge.consumedAt = new Date();
    await this.challengeRepository.save(challenge);

    const passwordHash = await hashPassword(dto.newPassword);
    await this.usersService.updatePassword(user, passwordHash);
    await this.sessionService.invalidateAllForUser(user.id);

    await this.loginAuditService.record(
      LoginAuditEventType.PASSWORD_RESET_ATTEMPT,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail,
        userId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );

    return { message: RESET_SUCCESS_MESSAGE };
  }

  async exchangeLinkToken(token: string): Promise<ExchangedLinkToken> {
    const linkTokenHash = hashSecret(token);
    const challenge = await this.challengeRepository.findOne({
      where: {
        linkTokenHash,
        invalidatedAt: IsNull(),
        consumedAt: IsNull(),
      },
      relations: ['user'],
    });

    if (!challenge || this.isExpired(challenge.expiresAt)) {
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    return { email: challenge.user.email, code: token };
  }

  private async findActiveByUserId(
    userId: string,
  ): Promise<PasswordResetChallenge | null> {
    return this.challengeRepository.findOne({
      where: { userId, invalidatedAt: IsNull(), consumedAt: IsNull() },
    });
  }

  private async invalidateActiveForUser(userId: string): Promise<void> {
    const active = await this.findActiveByUserId(userId);
    if (active) {
      active.invalidatedAt = new Date();
      await this.challengeRepository.save(active);
    }
  }

  private isExpired(expiresAt: Date): boolean {
    return Date.now() > expiresAt.getTime();
  }

  private async recordFailure(
    normalizedEmail: string,
    userId: string | undefined,
    meta: RequestMeta,
    failureReason: string,
  ): Promise<void> {
    await this.loginAuditService.record(
      LoginAuditEventType.PASSWORD_RESET_ATTEMPT,
      LoginAuditOutcome.FAILURE,
      {
        normalizedEmail,
        userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        failureReason,
      },
    );
  }
}
