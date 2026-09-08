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
    const link = `${baseUrl}/register/confirm/link?token=${linkToken}`;

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

  async sendLoginVerificationEmail(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    const baseUrl = this.configService.get('APP_BASE_URL');
    const link = `${baseUrl}/login/verify/link?token=${linkToken}`;

    const text = [
      'Finish signing in',
      '',
      `Your sign-in code: ${otp}`,
      '',
      `Or click this link: ${link}`,
      '',
      'This code and link expire in 10 minutes.',
    ].join('\n');

    await this.emailService.sendMail({
      to,
      subject: 'Finish signing in',
      text,
    });
  }

  async sendPasswordResetEmail(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    const baseUrl = this.configService.get('APP_BASE_URL');
    const link = `${baseUrl}/reset-password?token=${linkToken}`;

    const text = [
      'Reset your password',
      '',
      `Your password reset code: ${otp}`,
      '',
      `Or click this link: ${link}`,
      '',
      'This code and link expire in 10 minutes.',
    ].join('\n');

    await this.emailService.sendMail({
      to,
      subject: 'Reset your password',
      text,
    });
  }

  async sendEmailChangeConfirmation(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    const baseUrl = this.configService.get('APP_BASE_URL');
    const link = `${baseUrl}/account/email-change/confirm?token=${linkToken}`;

    const text = [
      'Confirm your new email address',
      '',
      `Your confirmation code: ${otp}`,
      '',
      `Or click this link: ${link}`,
      '',
      'This code and link expire in 10 minutes.',
    ].join('\n');

    await this.emailService.sendMail({
      to,
      subject: 'Confirm your new email address',
      text,
    });
  }
}
