import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { EmailService } from '@/core/email/email.service';

@Injectable()
export class ConfirmationMailService {
  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async sendConfirmationEmail(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    const baseUrl = this.configService.get('APP_BASE_URL');
    const link = `${baseUrl}/auth/register/confirm/link?token=${linkToken}`;

    const text = [
      'Confirm your registration',
      '',
      `Your confirmation code: ${otp}`,
      '',
      `Or click this link: ${link}`,
      '',
      'This code and link expire in 10 minutes.',
    ].join('\n');

    await this.emailService.sendMail({
      to,
      subject: 'Confirm your registration',
      text,
    });
  }
}
