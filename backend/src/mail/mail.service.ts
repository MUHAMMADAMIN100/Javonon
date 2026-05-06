import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private apiKey: string | null;
  private fromEmail: string;
  private fromName: string;
  private adminEmail: string | null;

  constructor(private config: ConfigService) {
    this.apiKey = config.get<string>('BREVO_API_KEY') || null;
    this.fromEmail = config.get<string>('MAIL_FROM_EMAIL') || '';
    this.fromName = config.get<string>('MAIL_FROM_NAME') || 'Javonon';
    this.adminEmail = config.get<string>('ADMIN_EMAIL') || null;

    if (this.apiKey && this.fromEmail) {
      this.logger.log(`Mail enabled (Brevo API, from ${this.fromEmail})`);
    } else {
      this.logger.warn('Mail disabled (BREVO_API_KEY or MAIL_FROM_EMAIL not set)');
    }
  }

  async send(to: string, subject: string, html: string) {
    if (!this.apiKey || !this.fromEmail) return;
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: this.fromName, email: this.fromEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Mail send failed: ${res.status} ${body}`);
      }
    } catch (err) {
      this.logger.error('Mail send failed', err as Error);
    }
  }

  async sendToAdmin(subject: string, html: string) {
    if (!this.adminEmail) return;
    return this.send(this.adminEmail, subject, html);
  }
}
