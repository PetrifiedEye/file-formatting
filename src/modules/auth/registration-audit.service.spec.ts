import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  RegistrationAuditEvent,
  RegistrationAuditEventType,
  RegistrationAuditOutcome,
} from './entities/registration-audit-event.entity';
import { RegistrationAuditService } from './registration-audit.service';

describe('RegistrationAuditService', () => {
  let service: RegistrationAuditService;
  const savedEvents: Partial<RegistrationAuditEvent>[] = [];

  const repository = {
    create: jest.fn((data: Partial<RegistrationAuditEvent>) => data),
    save: jest.fn((event: Partial<RegistrationAuditEvent>) => {
      savedEvents.push(event);
      return Promise.resolve(event);
    }),
    count: jest.fn().mockResolvedValue(0),
  };

  beforeEach(async () => {
    savedEvents.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationAuditService,
        {
          provide: getRepositoryToken(RegistrationAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(RegistrationAuditService);
  });

  it('records audit events without secrets', async () => {
    await service.record(
      RegistrationAuditEventType.REGISTRATION_ATTEMPT,
      RegistrationAuditOutcome.SUCCESS,
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
});
