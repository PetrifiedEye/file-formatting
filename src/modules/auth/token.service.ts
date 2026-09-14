import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';

import { ConfigService } from '@/core/config/config.service';

export type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  sub: string;
  typ: TokenType;
  /** Id of the `auth_sessions` row backing this token — what makes it revocable. */
  sid: string;
}

export interface VerifiedToken {
  sub: string;
  sessionId: string;
}

export type TokenFailureReason = 'malformed' | 'invalid_signature' | 'expired';

export class TokenVerificationError extends Error {
  constructor(public readonly reason: TokenFailureReason) {
    super(`Token verification failed: ${reason}`);
  }
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_TOLERANCE_SECONDS = 5;

/** Session rows are given the refresh token's lifetime; keep the two in step. */
export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signAccessToken(userId: string, sessionId: string): Promise<string> {
    return this.sign(
      userId,
      sessionId,
      'access',
      this.accessSecret(),
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  async signRefreshToken(userId: string, sessionId: string): Promise<string> {
    return this.sign(
      userId,
      sessionId,
      'refresh',
      this.refreshSecret(),
      REFRESH_TOKEN_TTL_SECONDS,
    );
  }

  async verifyAccessToken(token: string): Promise<VerifiedToken> {
    return this.verify(token, 'access', this.accessSecret());
  }

  async verifyRefreshToken(token: string): Promise<VerifiedToken> {
    return this.verify(token, 'refresh', this.refreshSecret());
  }

  private async sign(
    userId: string,
    sessionId: string,
    typ: TokenType,
    secret: string,
    expiresIn: number,
  ): Promise<string> {
    const payload: TokenPayload = { sub: userId, typ, sid: sessionId };

    return this.jwtService.signAsync(payload, { secret, expiresIn });
  }

  private async verify(
    token: string,
    expectedTyp: TokenType,
    secret: string,
  ): Promise<VerifiedToken> {
    let payload: TokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      throw this.classifyVerifyError(error);
    }

    if (payload.typ !== expectedTyp) {
      throw new TokenVerificationError('malformed');
    }

    // Tokens issued before sessions existed carry no `sid` and cannot be tied
    // to a revocable session, so they are rejected outright.
    if (!payload.sid) {
      throw new TokenVerificationError('malformed');
    }

    return { sub: payload.sub, sessionId: payload.sid };
  }

  private classifyVerifyError(error: unknown): TokenVerificationError {
    if (error instanceof TokenExpiredError) {
      return new TokenVerificationError('expired');
    }

    if (error instanceof JsonWebTokenError) {
      const reason: TokenFailureReason = error.message.includes('malformed')
        ? 'malformed'
        : 'invalid_signature';
      return new TokenVerificationError(reason);
    }

    return new TokenVerificationError('malformed');
  }

  private accessSecret(): string {
    return this.configService.get('JWT_ACCESS_SECRET');
  }

  private refreshSecret(): string {
    return this.configService.get('JWT_REFRESH_SECRET');
  }
}
