import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { ConfirmationMailService } from '@/modules/auth/confirmation-mail.service';
import {
  CONFIRMATION_TTL_MS,
  RESEND_INTERVAL_MS,
  generateConfirmationTokens,
  hashSecret,
} from '@/modules/auth/utils/confirmation-token';

import { EmailChangeChallenge } from './entities/email-change-challenge.entity';
import {
  ProfileAuditAction,
  ProfileAuditOutcome,
} from './entities/profile-audit-event.entity';
import { User } from './entities/user.entity';
import { ProfileAuditService } from './profile-audit.service';
import { UsersService } from './users.service';

const GENERIC_CONFIRM_FAILURE =
  'Unable to confirm email change. Please check your code or request a new one.';

@Injectable()
export class EmailChangeService {
  constructor(
    @InjectRepository(EmailChangeChallenge)
    private readonly challengeRepository: Repository<EmailChangeChallenge>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly usersService: UsersService,
    private readonly confirmationMailService: ConfirmationMailService,
    private readonly profileAuditService: ProfileAuditService,
  ) {}

  async initiate(user: User, newEmail: string): Promise<{ message: string }> {
    const existing = await this.usersRepository.findOne({
      where: { email: newEmail },
    });
    if (existing && existing.id !== user.id) {
      await this.profileAuditService.record(
        user.id,
        user.id,
        ProfileAuditAction.EMAIL_CHANGE_INITIATED,
        ProfileAuditOutcome.FAILURE,
        ['email'],
      );
      throw new ConflictException('Email already in use');
    }

    await this.invalidateActiveForUser(user.id);

    const now = new Date();
    const tokens = generateConfirmationTokens();
    const challenge = this.challengeRepository.create({
      userId: user.id,
      newEmail,
      otpHash: tokens.otpHash,
      linkTokenHash: tokens.linkTokenHash,
      issuedAt: now,
      lastSentAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      attemptsRemaining: 5,
    });
    await this.challengeRepository.save(challenge);

    await this.profileAuditService.record(
      user.id,
      user.id,
      ProfileAuditAction.EMAIL_CHANGE_INITIATED,
      ProfileAuditOutcome.SUCCESS,
      ['email'],
    );

    await this.confirmationMailService.sendEmailChangeConfirmation(
      newEmail,
      tokens.otp,
      tokens.linkToken,
    );

    await this.profileAuditService.record(
      user.id,
      user.id,
      ProfileAuditAction.EMAIL_CHANGE_SENT,
      ProfileAuditOutcome.SUCCESS,
      ['email'],
    );

    return {
      message: 'Confirmation instructions have been sent to the new email.',
    };
  }

  async resend(user: User): Promise<{ message: string }> {
    const challenge = await this.findActiveByUserId(user.id);

    if (!challenge) {
      throw new BadRequestException('No pending email change request');
    }

    const now = new Date();
    if (now.getTime() - challenge.lastSentAt.getTime() < RESEND_INTERVAL_MS) {
      throw new HttpException(
        'Please wait before requesting another code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const tokens = generateConfirmationTokens();
    challenge.otpHash = tokens.otpHash;
    challenge.linkTokenHash = tokens.linkTokenHash;
    challenge.issuedAt = now;
    challenge.lastSentAt = now;
    challenge.expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS);
    await this.challengeRepository.save(challenge);

    await this.confirmationMailService.sendEmailChangeConfirmation(
      challenge.newEmail,
      tokens.otp,
      tokens.linkToken,
    );

    await this.profileAuditService.record(
      user.id,
      user.id,
      ProfileAuditAction.EMAIL_CHANGE_RESENT,
      ProfileAuditOutcome.SUCCESS,
      ['email'],
    );

    return { message: 'A new confirmation code has been sent.' };
  }

  async confirm(user: User, code: string): Promise<User> {
    const challenge = await this.findActiveByUserId(user.id);

    if (!challenge) {
      await this.recordFailure(user.id, ProfileAuditAction.EMAIL_CHANGE_FAILED);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (this.isExpired(challenge.expiresAt)) {
      await this.recordFailure(
        user.id,
        ProfileAuditAction.EMAIL_CHANGE_EXPIRED,
      );
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (challenge.attemptsRemaining <= 0) {
      await this.recordFailure(user.id, ProfileAuditAction.EMAIL_CHANGE_FAILED);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const codeHash = hashSecret(code);
    const matches =
      codeHash === challenge.otpHash || codeHash === challenge.linkTokenHash;

    if (!matches) {
      // Persisted outside the transactional completion path below so the
      // decrement survives even though this method throws afterward.
      challenge.attemptsRemaining -= 1;
      await this.challengeRepository.save(challenge);
      await this.recordFailure(user.id, ProfileAuditAction.EMAIL_CHANGE_FAILED);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    return this.completeConfirm(user, challenge);
  }

  @Transactional()
  private async completeConfirm(
    user: User,
    challenge: EmailChangeChallenge,
  ): Promise<User> {
    const existing = await this.usersRepository.findOne({
      where: { email: challenge.newEmail },
    });
    if (existing && existing.id !== user.id) {
      await this.recordFailure(user.id, ProfileAuditAction.EMAIL_CHANGE_FAILED);
      throw new ConflictException('Email already in use');
    }

    challenge.consumedAt = new Date();
    await this.challengeRepository.save(challenge);

    user.email = challenge.newEmail;
    const updated = await this.usersRepository.save(user);

    await this.profileAuditService.record(
      user.id,
      user.id,
      ProfileAuditAction.EMAIL_CHANGE_CONFIRMED,
      ProfileAuditOutcome.SUCCESS,
      ['email'],
    );

    return updated;
  }

  private async findActiveByUserId(
    userId: string,
  ): Promise<EmailChangeChallenge | null> {
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
    userId: string,
    action: ProfileAuditAction,
  ): Promise<void> {
    await this.profileAuditService.record(
      userId,
      userId,
      action,
      ProfileAuditOutcome.FAILURE,
      ['email'],
    );
  }
}
