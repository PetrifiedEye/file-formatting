import { Test, TestingModule } from '@nestjs/testing';

import { ConfigService } from '@/core/config/config.service';
import { EmailService } from './email.service';

describe('EmailService', () => {
  let service: EmailService;
  const sendMail = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    sendMail.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                SMTP_HOST: 'localhost',
                SMTP_PORT: '1025',
                SMTP_USER: '',
                SMTP_PASSWORD: '',
                SMTP_FROM: 'noreply@localhost',
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get(EmailService);
    (
      service as unknown as { transporter: { sendMail: typeof sendMail } }
    ).transporter = { sendMail };
  });

  it('sends email via SMTP transport', async () => {
    await service.sendMail({
      to: 'user@example.com',
      subject: 'Test',
      text: 'Hello',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'noreply@localhost',
        to: 'user@example.com',
        subject: 'Test',
        text: 'Hello',
      }),
    );
  });
});
