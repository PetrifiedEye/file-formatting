import { Test, TestingModule } from '@nestjs/testing';
import * as React from 'react';

import { ConfigService } from '@/core/config/config.service';
import { VerificationEmail } from './templates/verification-email';
import { EmailService } from './email.service';

describe('EmailService', () => {
  const sendMail = jest.fn<Promise<void>, [{ html: string; text: string }]>();

  const build = async (
    overrides: Record<string, string> = {},
  ): Promise<EmailService> => {
    const values: Record<string, string> = {
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      SMTP_FROM: 'noreply@localhost',
      ...overrides,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => values[key],
            getBoolean: (key: string) => values[key] === 'true',
          },
        },
      ],
    }).compile();

    return module.get(EmailService);
  };

  const transportOptions = (service: EmailService): { secure: boolean } =>
    (service as unknown as { transporter: { options: { secure: boolean } } })
      .transporter.options;

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
  });

  it('sends email via SMTP transport', async () => {
    const service = await build();
    (
      service as unknown as { transporter: { sendMail: typeof sendMail } }
    ).transporter = { sendMail };

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

  it('renders a React Email template into both bodies', async () => {
    const service = await build();
    (
      service as unknown as { transporter: { sendMail: typeof sendMail } }
    ).transporter = { sendMail };

    await service.sendMail({
      to: 'user@example.com',
      subject: 'Confirm your registration',
      react: React.createElement(VerificationEmail, {
        heading: 'Confirm your registration',
        intro: 'Use the code below to finish creating your account.',
        otp: '123456',
        actionUrl: 'http://localhost:5174/register/confirm/link?token=abc',
        actionLabel: 'Confirm registration',
        expiresInMinutes: 10,
      }),
    });

    const sent = sendMail.mock.calls[0][0];

    expect(sent.html).toContain('<!DOCTYPE html');
    expect(sent.html).toContain('123456');
    expect(sent.html).toContain(
      'http://localhost:5174/register/confirm/link?token=abc',
    );
    // Clients that refuse HTML still need the code and the link.
    expect(sent.text).toContain('123456');
    expect(sent.text).toContain(
      'http://localhost:5174/register/confirm/link?token=abc',
    );
    expect(sent.text).not.toContain('<');
  });

  it('rejects a message with neither a template nor text', async () => {
    const service = await build();
    (
      service as unknown as { transporter: { sendMail: typeof sendMail } }
    ).transporter = { sendMail };

    await expect(
      service.sendMail({ to: 'user@example.com', subject: 'Empty' }),
    ).rejects.toThrow(/react.+text/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('leaves TLS off for the plaintext development transport', async () => {
    const service = await build();

    expect(transportOptions(service).secure).toBe(false);
  });

  it('keeps STARTTLS ports unsecured so nodemailer can upgrade them', async () => {
    const service = await build({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
    });

    expect(transportOptions(service).secure).toBe(false);
  });

  it('enables implicit TLS when SMTP_SECURE is set', async () => {
    const service = await build({ SMTP_SECURE: 'true' });

    expect(transportOptions(service).secure).toBe(true);
  });

  it('enables implicit TLS on port 465 even when the flag is off', async () => {
    const service = await build({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'false',
    });

    expect(transportOptions(service).secure).toBe(true);
  });
});
