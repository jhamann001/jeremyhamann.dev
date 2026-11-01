import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import logger from '../lib/logger.js';
import { readSecret } from '../lib/secrets.js';
import { messagesAllowed } from './serviceModeState.js';
import { recordOutbox } from '../demo/outbox.js';

const host = readSecret('SMTP_HOST');
const port = parseInt(readSecret('SMTP_PORT') || '587', 10);
const user = readSecret('SMTP_USER');
const pass = readSecret('SMTP_PASS');
const from = readSecret('SMTP_FROM') || user;

// EMAIL_TRANSPORT=outbox keeps mail in the demo outbox instead of delivering it: nodemailer still builds
// the message (as JSON), and the outbox stores it for the Outbox screen.
const toOutbox = process.env.EMAIL_TRANSPORT === 'outbox';

const transporter: Mail | null = toOutbox
  ? nodemailer.createTransport({ jsonTransport: true })
  : host && user && pass
    ? nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
    : null;

if (!transporter) {
  logger.warn('SMTP not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — invite emails disabled');
}

export async function sendInviteEmail(opts: {
  to: string;
  inviteeName: string;
  role: string;
  invitedBy: string;
}): Promise<void> {
  if (!messagesAllowed()) {
    logger.info({ event: 'email_send_suppressed' }, 'Invite email skipped: service is not active');
    return;
  }
  if (!transporter) {
    throw new Error('SMTP not configured — invite email cannot be sent');
  }

  const loginUrl = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();

  try {
    const info = await transporter.sendMail({
      from: toOutbox ? from || 'trade-requests@example.com' : from,
      to: opts.to,
      subject: "You've been invited to the Trade Request app",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 0;">
          <h2 style="margin: 0 0 16px;">Welcome, ${escapeHtml(opts.inviteeName)}!</h2>
          <p style="color: #374151; line-height: 1.6;">
            <strong>${escapeHtml(opts.invitedBy)}</strong> has invited you to the Trade Request app
            as <strong>${escapeHtml(opts.role)}</strong>.
          </p>
          <p style="color: #374151; line-height: 1.6;">
            Sign in with your <strong>${escapeHtml(opts.to)}</strong> Google account to get started:
          </p>
          <p style="margin: 24px 0;">
            <a href="${loginUrl}" style="
              display: inline-block;
              padding: 12px 24px;
              background: #2563eb;
              color: #fff;
              text-decoration: none;
              border-radius: 6px;
              font-weight: 600;
            ">Sign in to Trade Request</a>
          </p>
          <p style="color: #6b7280; font-size: 14px;">
            If you weren't expecting this invitation, you can safely ignore this email.
          </p>
        </div>
      `,
    });
    if (toOutbox) {
      const message = JSON.parse(String(info.message)) as { subject?: string; html?: string };
      await recordOutbox({ transport: 'email', destination: opts.to, subject: message.subject ?? null, body: message.html ?? '' });
    }
    logger.info({ to: opts.to }, 'Invite email sent');
  } catch (err) {
    logger.error({ err, to: opts.to }, 'Failed to send invite email');
    throw err;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
