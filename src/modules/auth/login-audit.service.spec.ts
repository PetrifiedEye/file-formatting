import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  LoginAuditEvent,
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';
import { LoginAuditService } from './login-audit.service';

describe('LoginAuditService', () => {
  let service: LoginAuditService;
  const savedEvents: Partial<LoginAuditEvent>[] = [];

  const repository = {
    create: jest.fn((data: Partial<LoginAuditEvent>) => data),
    save: jest.fn((event: Partial<LoginAuditEvent>) => {
      savedEvents.push(event);
      return Promise.resolve(event);
    }),
  };

  beforeEach(async () => {
    savedEvents.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoginAuditService,
        {
          provide: getRepositoryToken(LoginAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(LoginAuditService);
  });

  it('records audit events without secrets', async () => {
    await service.record(
      LoginAuditEventType.LOGIN_ATTEMPT,
      LoginAuditOutcome.SUCCESS,
      {
        normalizedEmail: 'user@example.com',
        userId: 'user-1',
        ipAddress: '127.0.0.1',
      },
    );

    expect(savedEvents).toHaveLength(1);
    const event = savedEvents[0];
    expect(event.normalizedEmail).toBe('user@example.com');
    expect(event).not.toHaveProperty('password');
    expect(event).not.toHaveProperty('otp');
    expect(event).not.toHaveProperty('linkToken');
    expect(JSON.stringify(event)).not.toMatch(/password|otp|linkToken/i);
  });

  it('records an event with no matching user (unknown email)', async () => {
    await service.record(
      LoginAuditEventType.LOGIN_ATTEMPT,
      LoginAuditOutcome.FAILURE,
      {
        normalizedEmail: 'unknown@example.com',
        failureReason: 'invalid_credentials',
      },
    );

    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0].userId).toBeNull();
    expect(savedEvents[0].failureReason).toBe('invalid_credentials');
  });
});
