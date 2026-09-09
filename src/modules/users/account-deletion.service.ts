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
import { LocalFileStorageService } from '@/core/storage/local-file-storage.service';

import { AccountDeletionAuditService } from './account-deletion-audit.service';
import { AccountDeletionChallenge } from './entities/account-deletion-challenge.entity';
import {
  AccountDeletionAuditAction,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

const GENERIC_CONFIRM_FAILURE =
  'Unable to confirm account deletion. Please check your code or request a new one.';

interface ClaimResult {
  outcome: 'claimed' | 'not_found' | 'conflict';
  relativeAssetPath: string | null;
}

export interface AdminDeleteResult {
  message: string;
  outcome: 'deleted' | 'already_removed';
}

@Injectable()
export class AccountDeletionService {
  constructor(
    @InjectRepository(AccountDeletionChallenge)
    private readonly challengeRepository: Repository<AccountDeletionChallenge>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly usersService: UsersService,
    private readonly confirmationMailService: ConfirmationMailService,
    private readonly storageService: LocalFileStorageService,
    private readonly auditService: AccountDeletionAuditService,
  ) {}

  async initiateSelfDelete(user: User): Promise<{ message: string }> {
    if (user.deletionStartedAt) {
      throw new ConflictException('Account is already being deleted');
    }

    await this.invalidateActiveForUser(user.id);

    const now = new Date();
    const tokens = generateConfirmationTokens();
    const challenge = this.challengeRepository.create({
      userId: user.id,
      otpHash: tokens.otpHash,
      linkTokenHash: tokens.linkTokenHash,
      issuedAt: now,
      lastSentAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      attemptsRemaining: 5,
    });
    await this.challengeRepository.save(challenge);

    await this.confirmationMailService.sendAccountDeletionConfirmation(
      user.email,
      tokens.otp,
      tokens.linkToken,
    );

    await this.auditService.record(
      user.id,
      user.id,
      AccountDeletionAuditAction.SELF_DELETE_INITIATED,
      AccountDeletionAuditOutcome.SUCCESS,
    );

    return {
      message: 'Confirmation instructions have been sent to your email.',
    };
  }

  async resendSelfDelete(user: User): Promise<{ message: string }> {
    const challenge = await this.findActiveByUserId(user.id);

    if (!challenge) {
      throw new BadRequestException('No pending account deletion request');
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

    await this.confirmationMailService.sendAccountDeletionConfirmation(
      user.email,
      tokens.otp,
      tokens.linkToken,
    );

    await this.auditService.record(
      user.id,
      user.id,
      AccountDeletionAuditAction.SELF_DELETE_RESENT,
      AccountDeletionAuditOutcome.SUCCESS,
    );

    return { message: 'A new confirmation code has been sent.' };
  }

  async confirmSelfDelete(
    user: User,
    code: string,
  ): Promise<{ message: string }> {
    const challenge = await this.findActiveByUserId(user.id);

    if (!challenge) {
      await this.recordSelfFailure(user.id);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (this.isExpired(challenge.expiresAt)) {
      await this.recordSelfFailure(user.id);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    if (challenge.attemptsRemaining <= 0) {
      await this.recordSelfFailure(user.id);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const codeHash = hashSecret(code);
    const matches =
      codeHash === challenge.otpHash || codeHash === challenge.linkTokenHash;

    if (!matches) {
      challenge.attemptsRemaining -= 1;
      await this.challengeRepository.save(challenge);
      await this.recordSelfFailure(user.id);
      throw new BadRequestException(GENERIC_CONFIRM_FAILURE);
    }

    const result = await this.claimAndDelete(user.id, challenge);

    if (result.outcome !== 'claimed') {
      await this.auditService.record(
        user.id,
        user.id,
        AccountDeletionAuditAction.SELF_DELETE_FAILED,
        AccountDeletionAuditOutcome.CONFLICT,
      );
      throw new ConflictException('Account is already being deleted');
    }

    if (result.relativeAssetPath) {
      await this.storageService.delete(result.relativeAssetPath);
    }

    await this.auditService.record(
      user.id,
      user.id,
      AccountDeletionAuditAction.SELF_DELETE_CONFIRMED,
      AccountDeletionAuditOutcome.SUCCESS,
    );

    return { message: 'Your account has been deleted.' };
  }

  async adminDelete(targetId: string): Promise<AdminDeleteResult> {
    const result = await this.claimAndDelete(targetId);

    if (result.outcome === 'not_found') {
      return { message: 'already removed', outcome: 'already_removed' };
    }

    if (result.outcome === 'conflict') {
      throw new ConflictException('Account is already being deleted');
    }

    if (result.relativeAssetPath) {
      await this.storageService.delete(result.relativeAssetPath);
    }

    return { message: 'deleted', outcome: 'deleted' };
  }

  @Transactional()
  private async claimAndDelete(
    userId: string,
    challenge?: AccountDeletionChallenge,
  ): Promise<ClaimResult> {
    const [claimed]: [Array<{ photoUrl: string | null }>, number] =
      await this.usersRepository.manager.query(
        `UPDATE users SET deletion_started_at = now() WHERE id = $1 AND deletion_started_at IS NULL RETURNING photo_url AS "photoUrl"`,
        [userId],
      );

    if (claimed.length === 0) {
      const existing = await this.usersRepository.findOne({
        where: { id: userId },
      });
      return {
        outcome: existing ? 'conflict' : 'not_found',
        relativeAssetPath: null,
      };
    }

    if (challenge) {
      challenge.consumedAt = new Date();
      await this.challengeRepository.save(challenge);
    }

    await this.redactPriorAuditEmails(userId);

    const user = await this.usersRepository.findOneOrFail({
      where: { id: userId },
    });
    const relativeAssetPath = this.usersService.toRelativeAssetPath(
      user.photoUrl,
    );
    await this.usersService.deleteUser(user);

    return { outcome: 'claimed', relativeAssetPath };
  }

  private async redactPriorAuditEmails(userId: string): Promise<void> {
    await this.usersRepository.manager.query(
      `UPDATE login_audit_events SET normalized_email = NULL WHERE user_id = $1`,
      [userId],
    );
    await this.usersRepository.manager.query(
      `UPDATE registration_audit_events SET normalized_email = NULL WHERE user_id = $1`,
      [userId],
    );
  }

  private async findActiveByUserId(
    userId: string,
  ): Promise<AccountDeletionChallenge | null> {
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

  private async recordSelfFailure(userId: string): Promise<void> {
    await this.auditService.record(
      userId,
      userId,
      AccountDeletionAuditAction.SELF_DELETE_FAILED,
      AccountDeletionAuditOutcome.FAILURE,
    );
  }
}
