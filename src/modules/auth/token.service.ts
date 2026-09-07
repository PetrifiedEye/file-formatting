import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import type { StringValue } from 'ms';

import { ConfigService } from '@/core/config/config.service';

export type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  sub: string;
  typ: TokenType;
}

export type TokenFailureReason = 'malformed' | 'invalid_signature' | 'expired';

export class TokenVerificationError extends Error {
  constructor(public readonly reason: TokenFailureReason) {
    super(`Token verification failed: ${reason}`);
  }
}

const ACCESS_TOKEN_TTL: StringValue = '15m';
const REFRESH_TOKEN_TTL: StringValue = '30d';
const CLOCK_TOLERANCE_SECONDS = 5;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signAccessToken(userId: string): Promise<string> {
    return this.sign(userId, 'access', this.accessSecret(), ACCESS_TOKEN_TTL);
  }

  async signRefreshToken(userId: string): Promise<string> {
    return this.sign(
      userId,
      'refresh',
      this.refreshSecret(),
      REFRESH_TOKEN_TTL,
    );
  }

  async verifyAccessToken(token: string): Promise<{ sub: string }> {
    return this.verify(token, 'access', this.accessSecret());
  }

  async verifyRefreshToken(token: string): Promise<{ sub: string }> {
    return this.verify(token, 'refresh', this.refreshSecret());
  }

  private async sign(
    userId: string,
    typ: TokenType,
    secret: string,
    expiresIn: StringValue,
  ): Promise<string> {
    const payload: TokenPayload = { sub: userId, typ };

    return this.jwtService.signAsync(payload, { secret, expiresIn });
  }

  private async verify(
    token: string,
    expectedTyp: TokenType,
    secret: string,
  ): Promise<{ sub: string }> {
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

    return { sub: payload.sub };
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
