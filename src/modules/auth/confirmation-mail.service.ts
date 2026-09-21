import { Injectable } from '@nestjs/common';
import * as React from 'react';

import { ConfigService } from '@/core/config/config.service';
import { EmailService } from '@/core/email/email.service';
import { VerificationEmail } from '@/core/email/templates/verification-email';

/** Lifetime of every one-time code and confirmation link issued below. */
const EXPIRES_IN_MINUTES = 10;

interface VerificationMail {
  /** Path the confirmation link points at, relative to `APP_BASE_URL`. */
  path: string;
  subject: string;
  intro: string;
  actionLabel: string;
}

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
    await this.send(to, otp, linkToken, {
      path: '/register/confirm/link',
      subject: 'Confirm your registration',
      intro: 'Use the code below to finish creating your account.',
      actionLabel: 'Confirm registration',
    });
  }

  async sendLoginVerificationEmail(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    await this.send(to, otp, linkToken, {
      path: '/login/verify/link',
      subject: 'Finish signing in',
      intro: 'Use the code below to finish signing in.',
      actionLabel: 'Finish signing in',
    });
  }

  async sendPasswordResetEmail(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    await this.send(to, otp, linkToken, {
      path: '/reset-password',
      subject: 'Reset your password',
      intro: 'Use the code below to choose a new password.',
      actionLabel: 'Reset password',
    });
  }

  async sendEmailChangeConfirmation(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    await this.send(to, otp, linkToken, {
      path: '/account/email-change/confirm',
      subject: 'Confirm your new email address',
      intro: 'Use the code below to confirm your new email address.',
      actionLabel: 'Confirm email address',
    });
  }

  async sendAccountDeletionConfirmation(
    to: string,
    otp: string,
    linkToken: string,
  ): Promise<void> {
    await this.send(to, otp, linkToken, {
      path: '/account/delete/confirm',
      subject: 'Confirm account deletion',
      intro: 'Use the code below to confirm deletion of your account.',
      actionLabel: 'Confirm deletion',
    });
  }

  private async send(
    to: string,
    otp: string,
    linkToken: string,
    mail: VerificationMail,
  ): Promise<void> {
    const baseUrl = this.configService.get('APP_BASE_URL');
    const actionUrl = `${baseUrl}${mail.path}?token=${linkToken}`;

    await this.emailService.sendMail({
      to,
      subject: mail.subject,
      react: React.createElement(VerificationEmail, {
        heading: mail.subject,
        intro: mail.intro,
        otp,
        actionUrl,
        actionLabel: mail.actionLabel,
        expiresInMinutes: EXPIRES_IN_MINUTES,
      }),
    });
  }
}
