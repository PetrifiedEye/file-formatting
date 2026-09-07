import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { LoginChallenge } from './entities/login-challenge.entity';
import {
  CONFIRMATION_TTL_MS,
  ConfirmationTokens,
  generateConfirmationTokens,
  hashSecret,
} from './utils/confirmation-token';

export interface IssuedLoginChallenge {
  challenge: LoginChallenge;
  tokens: ConfirmationTokens;
}

export enum LoginChallengeVerifyFailure {
  NOT_FOUND = 'not_found',
  EXPIRED = 'expired',
  ATTEMPTS_EXHAUSTED = 'attempts_exhausted',
  WRONG_CODE = 'wrong_code',
}

export type LoginChallengeVerifyResult =
  | { ok: true; challenge: LoginChallenge }
  | { ok: false; reason: LoginChallengeVerifyFailure };

@Injectable()
export class LoginChallengeService {
  constructor(
    @InjectRepository(LoginChallenge)
    private readonly challengeRepository: Repository<LoginChallenge>,
  ) {}

  async findActiveByUserId(userId: string): Promise<LoginChallenge | null> {
    return this.challengeRepository.findOne({
      where: { userId, invalidatedAt: IsNull(), consumedAt: IsNull() },
    });
  }

  async invalidateActiveForUser(userId: string): Promise<void> {
    const active = await this.findActiveByUserId(userId);
    if (active) {
      active.invalidatedAt = new Date();
      await this.challengeRepository.save(active);
    }
  }

  async issue(userId: string, now = new Date()): Promise<IssuedLoginChallenge> {
    await this.invalidateActiveForUser(userId);

    const tokens = generateConfirmationTokens();
    const challenge = this.challengeRepository.create({
      userId,
      otpHash: tokens.otpHash,
      linkTokenHash: tokens.linkTokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
      attemptsRemaining: 5,
    });

    const saved = await this.challengeRepository.save(challenge);
    return { challenge: saved, tokens };
  }

  async verifyByCode(
    userId: string,
    code: string,
  ): Promise<LoginChallengeVerifyResult> {
    const challenge = await this.findActiveByUserId(userId);
    return this.verifyChallenge(challenge, hashSecret(code), 'code');
  }

  async verifyByLinkToken(token: string): Promise<LoginChallengeVerifyResult> {
    const linkTokenHash = hashSecret(token);
    const challenge = await this.challengeRepository.findOne({
      where: {
        linkTokenHash,
        invalidatedAt: IsNull(),
        consumedAt: IsNull(),
      },
    });
    return this.verifyChallenge(challenge, linkTokenHash, 'link');
  }

  private async verifyChallenge(
    challenge: LoginChallenge | null,
    hash: string,
    mode: 'code' | 'link',
  ): Promise<LoginChallengeVerifyResult> {
    if (!challenge) {
      return { ok: false, reason: LoginChallengeVerifyFailure.NOT_FOUND };
    }

    if (Date.now() > challenge.expiresAt.getTime()) {
      return { ok: false, reason: LoginChallengeVerifyFailure.EXPIRED };
    }

    if (challenge.attemptsRemaining <= 0) {
      return {
        ok: false,
        reason: LoginChallengeVerifyFailure.ATTEMPTS_EXHAUSTED,
      };
    }

    const matches =
      mode === 'link'
        ? challenge.linkTokenHash === hash
        : challenge.otpHash === hash;

    if (!matches) {
      challenge.attemptsRemaining -= 1;
      await this.challengeRepository.save(challenge);
      return { ok: false, reason: LoginChallengeVerifyFailure.WRONG_CODE };
    }

    challenge.consumedAt = new Date();
    await this.challengeRepository.save(challenge);

    return { ok: true, challenge };
  }
}
