import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { validatePassword } from '@/modules/settings/password-policy.validator';

import { AccountDeletionChallenge } from '@/modules/users/entities/account-deletion-challenge.entity';
import { EmailChangeChallenge } from '@/modules/users/entities/email-change-challenge.entity';

import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';
import { LoginAuditService } from './login-audit.service';
import { AuthSessionService } from './auth-session.service';
import { SessionRevocationReason } from './entities/auth-session.entity';
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
    @InjectRepository(LoginChallenge)
    private readonly loginChallengeRepository: Repository<LoginChallenge>,
    @InjectRepository(ConfirmationChallenge)
    private readonly confirmationChallengeRepository: Repository<ConfirmationChallenge>,
    @InjectRepository(EmailChangeChallenge)
    private readonly emailChangeChallengeRepository: Repository<EmailChangeChallenge>,
    @InjectRepository(AccountDeletionChallenge)
    private readonly accountDeletionChallengeRepository: Repository<AccountDeletionChallenge>,
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
    private readonly confirmationMailService: ConfirmationMailService,
    private readonly loginAuditService: LoginAuditService,
    private readonly sessionService: AuthSessionService,
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

    // Only now, with the code proven, is it safe to say anything specific.
    // Reporting policy errors earlier made the response shape an enumeration
    // oracle: a registered address got a detailed list of policy violations
    // while an unknown one got the generic failure, so any weak password
    // revealed whether an address was registered.
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

    const passwordHash = await hashPassword(dto.newPassword);
    await this.applyReset(challenge, user, passwordHash);

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

  // Only consuming the challenge and rotating the password need to be atomic.
  // `confirmReset` itself must stay outside a transaction: it decrements the
  // attempt counter and writes FAILURE audit rows and then throws, which a
  // surrounding transaction would roll back.
  @Transactional()
  private async applyReset(
    challenge: PasswordResetChallenge,
    user: User,
    passwordHash: string,
  ): Promise<void> {
    challenge.consumedAt = new Date();
    await this.challengeRepository.save(challenge);
    await this.usersService.updatePassword(user, passwordHash);
    // A reset is the remedy for a compromised account, so every session opened
    // with the old password — including 30-day refresh tokens — dies with it.
    await this.sessionService.revokeAllForUser(
      user.id,
      SessionRevocationReason.PASSWORD_RESET,
    );
    await this.invalidateOtherChallenges(user.id);
  }

  /**
   * A reset is the remedy for a compromised account, so it has to end every
   * code already in flight — not only the sessions. An attacker who held a
   * `email_change` or `account_deletion` code from before the reset could
   * otherwise still redeem it afterwards and take the account back.
   */
  private async invalidateOtherChallenges(userId: string): Promise<void> {
    const invalidatedAt = new Date();
    const active = { userId, invalidatedAt: IsNull(), consumedAt: IsNull() };

    // Sequential, not Promise.all: this runs inside the @Transactional()
    // caller's single connection, and firing these concurrently on it made
    // node-postgres queue overlapping queries on the same client — the
    // source of intermittent ECONNRESET failures across the e2e suite.
    await this.loginChallengeRepository.update(active, { invalidatedAt });
    await this.confirmationChallengeRepository.update(active, {
      invalidatedAt,
    });
    await this.emailChangeChallengeRepository.update(active, { invalidatedAt });
    await this.accountDeletionChallengeRepository.update(active, {
      invalidatedAt,
    });
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
