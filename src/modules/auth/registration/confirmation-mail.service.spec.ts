import { Test, TestingModule } from '@nestjs/testing';
import { render } from '@react-email/render';
import type { ReactElement } from 'react';

import { ConfigService } from '@/core/config/config.service';
import { EmailService, SendMailOptions } from '@/core/email/email.service';
import { ConfirmationMailService } from './confirmation-mail.service';

describe('ConfirmationMailService', () => {
  const sendMail = jest.fn<Promise<void>, [SendMailOptions]>();
  let service: ConfirmationMailService;

  beforeEach(async () => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfirmationMailService,
        { provide: EmailService, useValue: { sendMail } },
        {
          provide: ConfigService,
          useValue: { get: () => 'http://localhost:5174' },
        },
      ],
    }).compile();

    service = module.get(ConfirmationMailService);
  });

  const sentHtml = async (): Promise<string> =>
    render(sendMail.mock.calls[0][0].react as ReactElement);

  it.each([
    [
      'sendConfirmationEmail' as const,
      'Confirm your registration',
      '/register/confirm/link',
    ],
    [
      'sendLoginVerificationEmail' as const,
      'Finish signing in',
      '/login/verify/link',
    ],
    [
      'sendPasswordResetEmail' as const,
      'Reset your password',
      '/reset-password',
    ],
    [
      'sendEmailChangeConfirmation' as const,
      'Confirm your new email address',
      '/account/email-change/confirm',
    ],
    [
      'sendAccountDeletionConfirmation' as const,
      'Confirm account deletion',
      '/account/delete/confirm',
    ],
  ])('%s sends the template for %s', async (method, subject, path) => {
    await service[method]('user@example.com', '123456', 'link-token');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const options = sendMail.mock.calls[0][0];
    expect(options.to).toBe('user@example.com');
    expect(options.subject).toBe(subject);
    expect(options.react).toBeDefined();

    const html = await sentHtml();
    expect(html).toContain('123456');
    expect(html).toContain(`http://localhost:5174${path}?token=link-token`);
  });
});
