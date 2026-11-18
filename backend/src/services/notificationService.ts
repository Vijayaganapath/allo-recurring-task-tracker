import nodemailer from 'nodemailer';
import { Pool } from 'mysql2/promise';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class NotificationService {
  private transporter: nodemailer.Transporter;

  constructor(private db: Pool) {
    const host = process.env.SMTP_HOST || 'mailpit';
    const port = Number(process.env.SMTP_PORT) || 1025;
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';

    const authConfig = (user !== '' && pass !== '') ? { user, pass } : undefined;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      auth: authConfig
    });
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    const from = process.env.EMAIL_FROM || 'no-reply@alloinnoware.com';
    let status = 'SENT';

    try {
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || options.subject
      });
      return true;
    } catch (err: any) {
      status = 'FAILED';
      console.error(`[NotificationService] Failed to send email to ${options.to}:`, err.message);
      return false;
    } finally {
      try {
        await this.db.query(
          'INSERT INTO notification_log (to_email, subject, status, created_at) VALUES (?, ?, ?, NOW())',
          [options.to, options.subject, status]
        );
      } catch (logErr) {
        console.error('[NotificationService] Failed to write notification_log:', logErr);
      }
    }
  }
}
