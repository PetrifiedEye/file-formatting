import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';

import {
  AuthSession,
  SessionRevocationReason,
} from './entities/auth-session.entity';
import { REFRESH_TOKEN_TTL_MS } from './token.service';

@Injectable()
export class AuthSessionService {
  constructor(
    @InjectRepository(AuthSession)
    private readonly sessionRepository: Repository<AuthSession>,
  ) {}

  /** Opens a session that lives exactly as long as the refresh token it backs. */
  async start(userId: string): Promise<AuthSession> {
    const now = new Date();

    return this.sessionRepository.save(
      this.sessionRepository.create({
        userId,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        revokedAt: null,
        revokedReason: null,
      }),
    );
  }

  /** Returns the session only if it is still usable by that user. */
  async findActive(
    sessionId: string,
    userId: string,
  ): Promise<AuthSession | null> {
    return this.sessionRepository.findOne({
      where: {
        id: sessionId,
        userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  async touch(sessionId: string): Promise<void> {
    await this.sessionRepository.update(
      { id: sessionId },
      { lastUsedAt: new Date() },
    );
  }

  async revoke(
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<void> {
    await this.sessionRepository.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Revokes every live session of a user; returns how many were still open. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevocationReason,
  ): Promise<number> {
    const result = await this.sessionRepository.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    return result.affected ?? 0;
  }
}
