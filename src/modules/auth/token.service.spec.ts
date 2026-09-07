import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';

import { ConfigService } from '@/core/config/config.service';

import { TokenService, TokenVerificationError } from './token.service';

describe('TokenService', () => {
  let service: TokenService;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return 'access-secret';
      if (key === 'JWT_REFRESH_SECRET') return 'refresh-secret';
      return '';
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        JwtService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(TokenService);
  });

  describe('access token', () => {
    it('signs and verifies a round trip', async () => {
      const token = await service.signAccessToken('user-1');
      const payload = await service.verifyAccessToken(token);

      expect(payload).toEqual({ sub: 'user-1' });
    });

    it('rejects a token signed with the wrong secret', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'access' },
        { secret: 'wrong-secret', expiresIn: '15m' },
      );

      let error: unknown;
      try {
        await service.verifyAccessToken(token);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe(
        'invalid_signature',
      );
    });

    it('rejects an expired token', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'access' },
        { secret: 'access-secret', expiresIn: '-30s' },
      );

      let error: unknown;
      try {
        await service.verifyAccessToken(token);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe('expired');
    });

    it('rejects a malformed token', async () => {
      let error: unknown;
      try {
        await service.verifyAccessToken('not-a-jwt');
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe('malformed');
    });

    it('rejects a token with the wrong typ', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'refresh' },
        { secret: 'access-secret', expiresIn: '15m' },
      );

      let error: unknown;
      try {
        await service.verifyAccessToken(token);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).toBe('malformed');
    });

    it('accepts a token within the clock-skew tolerance', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'access' },
        { secret: 'access-secret', expiresIn: '-3s' },
      );

      await expect(service.verifyAccessToken(token)).resolves.toEqual({
        sub: 'user-1',
      });
    });
  });

  describe('refresh token', () => {
    it('signs and verifies a round trip', async () => {
      const token = await service.signRefreshToken('user-1');
      const payload = await service.verifyRefreshToken(token);

      expect(payload).toEqual({ sub: 'user-1' });
    });

    it('rejects a token signed with the wrong secret', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'refresh' },
        { secret: 'wrong-secret', expiresIn: '30d' },
      );

      await expect(service.verifyRefreshToken(token)).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
    });

    it('rejects an expired token', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'refresh' },
        { secret: 'refresh-secret', expiresIn: '-30s' },
      );

      let error: unknown;
      try {
        await service.verifyRefreshToken(token);
      } catch (err) {
        error = err;
      }

      expect((error as TokenVerificationError).reason).toBe('expired');
    });

    it('rejects a token with the wrong typ', async () => {
      const jwtService = new JwtService();
      const token = await jwtService.signAsync(
        { sub: 'user-1', typ: 'access' },
        { secret: 'refresh-secret', expiresIn: '30d' },
      );

      await expect(service.verifyRefreshToken(token)).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
    });

    it('an access token cannot be used as a refresh token even with the right secret guessed', async () => {
      const accessToken = await service.signAccessToken('user-1');

      await expect(
        service.verifyRefreshToken(accessToken),
      ).rejects.toBeInstanceOf(TokenVerificationError);
    });
  });
});
