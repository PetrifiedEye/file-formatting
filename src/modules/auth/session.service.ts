import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { Session } from './entities/session.entity';
import { hashSecret, SESSION_TTL_MS } from './utils/confirmation-token';

export interface IssuedSession {
  session: Session;
  token: string;
}

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
  ) {}

  async issue(
    user: User,
    ipAddress?: string | null,
    userAgent?: string | null,
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();

    const session = this.sessionRepository.create({
      userId: user.id,
      tokenHash: hashSecret(token),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      invalidatedAt: null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent?.slice(0, 512) ?? null,
    });

    const saved = await this.sessionRepository.save(session);

    return { session: saved, token };
  }

  async validate(rawToken: string): Promise<Session | null> {
    const tokenHash = hashSecret(rawToken);

    return this.sessionRepository.findOne({
      where: {
        tokenHash,
        invalidatedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  async invalidate(sessionId: string): Promise<void> {
    await this.sessionRepository.update(
      { id: sessionId, invalidatedAt: IsNull() },
      { invalidatedAt: new Date() },
    );
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.sessionRepository.update(
      { userId, invalidatedAt: IsNull() },
      { invalidatedAt: new Date() },
    );
  }
}
