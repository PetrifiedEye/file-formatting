import { Injectable, Logger } from '@nestjs/common';
import { render } from '@react-email/render';
import { createTransport, Transporter } from 'nodemailer';
import type { ReactElement } from 'react';

import { ConfigService } from '@/core/config/config.service';

export interface SendMailOptions {
  to: string;
  subject: string;
  /**
   * React Email template. Rendered to the HTML body and, unless `text` is
   * given, to the plain-text alternative every client falls back to.
   */
  react?: ReactElement;
  text?: string;
  html?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    const user = this.configService.get('SMTP_USER');
    const pass = this.configService.get('SMTP_PASSWORD');
    const port = Number(this.configService.get('SMTP_PORT'));

    this.transporter = createTransport({
      host: this.configService.get('SMTP_HOST'),
      port,
      // Port 465 is implicit TLS and never negotiates, so it is forced on
      // regardless of the flag — every other port (587, 25, Mailpit's 1025)
      // starts plaintext and is upgraded by STARTTLS when the server offers it.
      secure: this.configService.getBoolean('SMTP_SECURE') || port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    const from = this.configService.get('SMTP_FROM');
    const { html, text } = await this.renderBodies(options);

    await this.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text,
      html,
    });

    this.logger.log(`Email sent to ${options.to}: ${options.subject}`);
  }

  /**
   * Both bodies are always sent: the HTML one is what recipients see, and the
   * plain-text one keeps the message readable in clients that refuse HTML and
   * stops spam filters from scoring the mail as HTML-only.
   */
  private async renderBodies(
    options: SendMailOptions,
  ): Promise<{ html: string; text: string }> {
    if (options.react) {
      const [html, text] = await Promise.all([
        options.html ? Promise.resolve(options.html) : render(options.react),
        options.text
          ? Promise.resolve(options.text)
          : render(options.react, { plainText: true }),
      ]);

      return { html, text };
    }

    if (options.text === undefined) {
      throw new Error('sendMail requires either a `react` template or `text`');
    }

    return { html: options.html ?? options.text, text: options.text };
  }
}
