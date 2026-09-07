import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { LoginChallenge } from './entities/login-challenge.entity';
import {
  LoginChallengeService,
  LoginChallengeVerifyFailure,
} from './login-challenge.service';
import { hashSecret } from './utils/confirmation-token';

describe('LoginChallengeService', () => {
  let service: LoginChallengeService;
  let repository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock<Promise<LoginChallenge>, [challenge: LoginChallenge]>;
  };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn(),
      create: jest.fn(
        (data: Partial<LoginChallenge>) => data as LoginChallenge,
      ),
      save: jest.fn((challenge: LoginChallenge) =>
        Promise.resolve({ ...challenge, id: challenge.id ?? 'challenge-1' }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoginChallengeService,
        { provide: getRepositoryToken(LoginChallenge), useValue: repository },
      ],
    }).compile();

    service = module.get(LoginChallengeService);
  });

  describe('issue', () => {
    it('invalidates any prior pending challenge and creates a new one', async () => {
      repository.findOne.mockResolvedValueOnce({
        id: 'old-challenge',
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.issue('user-1');

      const savedInvalidation = repository.save.mock.calls[0][0];
      expect(savedInvalidation.id).toBe('old-challenge');
      expect(savedInvalidation.invalidatedAt).toBeInstanceOf(Date);
      expect(result.challenge).toBeDefined();
      expect(result.tokens.otp).toHaveLength(6);
    });
  });

  describe('verifyByCode', () => {
    it('succeeds and consumes the challenge for a correct code', async () => {
      const otp = '123456';
      repository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret(otp),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.verifyByCode('user-1', otp);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.challenge.consumedAt).toBeInstanceOf(Date);
      }
    });

    it('decrements attempts and fails for a wrong code', async () => {
      repository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.verifyByCode('user-1', '000000');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(LoginChallengeVerifyFailure.WRONG_CODE);
      }
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ attemptsRemaining: 4 }),
      );
    });

    it('fails when the challenge has expired', async () => {
      repository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        expiresAt: new Date(Date.now() - 1000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.verifyByCode('user-1', '123456');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(LoginChallengeVerifyFailure.EXPIRED);
      }
    });

    it('fails when attempts are exhausted', async () => {
      repository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 0,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.verifyByCode('user-1', '123456');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(
          LoginChallengeVerifyFailure.ATTEMPTS_EXHAUSTED,
        );
      }
    });

    it('fails when no active challenge is found', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.verifyByCode('user-1', '123456');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(LoginChallengeVerifyFailure.NOT_FOUND);
      }
    });
  });

  describe('verifyByLinkToken', () => {
    it('succeeds for a correct link token', async () => {
      const linkToken = 'valid-link-token';
      repository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret(linkToken),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.verifyByLinkToken(linkToken);

      expect(result.ok).toBe(true);
    });
  });
});
