import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import {
  CONFIRMATION_TTL_MS,
  ConfirmationTokens,
} from './utils/confirmation-token';

export interface CreateChallengeInput {
  userId: string;
  tokens: ConfirmationTokens;
  lastSentAt: Date;
}

@Injectable()
export class ConfirmationChallengeService {
  constructor(
    @InjectRepository(ConfirmationChallenge)
    private readonly challengeRepository: Repository<ConfirmationChallenge>,
  ) {}

  async findActiveByUserId(
    userId: string,
  ): Promise<ConfirmationChallenge | null> {
    return this.challengeRepository.findOne({
      where: {
        userId,
        invalidatedAt: IsNull(),
        consumedAt: IsNull(),
      },
    });
  }

  async findActiveByLinkTokenHash(
    linkTokenHash: string,
  ): Promise<ConfirmationChallenge | null> {
    return this.challengeRepository.findOne({
      where: {
        linkTokenHash,
        invalidatedAt: IsNull(),
        consumedAt: IsNull(),
      },
      relations: ['user'],
    });
  }

  async findByLinkTokenHash(
    linkTokenHash: string,
  ): Promise<ConfirmationChallenge | null> {
    return this.challengeRepository.findOne({
      where: { linkTokenHash },
      relations: ['user'],
    });
  }

  async invalidateActiveForUser(userId: string): Promise<void> {
    const active = await this.findActiveByUserId(userId);
    if (active) {
      active.invalidatedAt = new Date();
      await this.challengeRepository.save(active);
    }
  }

  async createChallenge(
    input: CreateChallengeInput,
  ): Promise<ConfirmationChallenge> {
    await this.invalidateActiveForUser(input.userId);

    const expiresAt = new Date(
      input.lastSentAt.getTime() + CONFIRMATION_TTL_MS,
    );

    const challenge = this.challengeRepository.create({
      userId: input.userId,
      otpHash: input.tokens.otpHash,
      linkTokenHash: input.tokens.linkTokenHash,
      issuedAt: input.lastSentAt,
      expiresAt,
      attemptsRemaining: 5,
      lastSentAt: input.lastSentAt,
    });

    return this.challengeRepository.save(challenge);
  }

  async save(challenge: ConfirmationChallenge): Promise<ConfirmationChallenge> {
    return this.challengeRepository.save(challenge);
  }
}
