import { env } from '../../config/env';
import { DevConsoleEmailService } from './devConsoleEmail.service';
import { EmailService } from './email.service';
import { MockEmailService } from './mockEmail.service';
import { SmtpEmailService } from './smtpEmail.service';

export { EmailMessage, EmailService } from './email.service';
export { MockEmailService } from './mockEmail.service';

export const KNOWN_EMAIL_PROVIDERS = ['smtp', 'console', 'mock'] as const;

export interface EmailFactoryOptions {
  // EMAIL_PROVIDER, already trimmed/lower-cased. undefined = automatic.
  provider?: string;
  nodeEnv: string;
  smtp: { host?: string; port?: number; user?: string; password?: string; from: string };
}

// The single place a mail provider is chosen (mirrors createPaymentProvider).
// Callers only ever see the EmailService interface, so adding Resend / SendGrid
// / SES later means adding a class and a case here - nothing else changes.
//
//   unset    -> SMTP if EMAIL_HOST/PORT/USER/PASSWORD are all set; otherwise the
//               dev console (development/test only). Production with no SMTP
//               refuses to start: silently "succeeding" without delivering
//               would look exactly like a real outage.
//   smtp     -> SMTP, and the four variables above are then required.
//   console  -> logs the message (incl. the reset link) to the server console.
//   mock     -> in-memory outbox for automated tests.
//   console and mock are never allowed in production.
export function createEmailService({ provider, nodeEnv, smtp }: EmailFactoryOptions): EmailService {
  const smtpReady = Boolean(smtp.host && smtp.port && smtp.user && smtp.password);
  const buildSmtp = (): EmailService =>
    new SmtpEmailService({
      host: smtp.host as string,
      port: smtp.port as number,
      user: smtp.user as string,
      password: smtp.password as string,
      from: smtp.from,
    });

  if (provider === undefined) {
    if (smtpReady) {
      return buildSmtp();
    }
    if (nodeEnv === 'production') {
      throw new Error(
        'Email is not configured (EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASSWORD): ' +
          'password reset emails cannot be sent in production without a real transport.',
      );
    }
    return new DevConsoleEmailService();
  }

  switch (provider) {
    case 'smtp':
      if (!smtpReady) {
        throw new Error('EMAIL_PROVIDER=smtp requires EMAIL_HOST, EMAIL_PORT, EMAIL_USER and EMAIL_PASSWORD.');
      }
      return buildSmtp();
    case 'console':
    case 'mock':
      if (nodeEnv === 'production') {
        throw new Error(
          `EMAIL_PROVIDER=${provider} is not allowed in production: it does not deliver email. Use smtp.`,
        );
      }
      return provider === 'mock' ? new MockEmailService() : new DevConsoleEmailService();
    default:
      throw new Error(
        `EMAIL_PROVIDER="${provider}" is not a known email provider. Known: ${KNOWN_EMAIL_PROVIDERS.join(', ')}.`,
      );
  }
}

// A single lazily-constructed instance, matching the existing
// services/storage/index.ts singleton pattern. Built once per process (not per
// request): constructing a fresh nodemailer transporter on every forgot-password
// call would be wasteful, and a misconfiguration should fail at startup, not
// mid-request.
export const emailService: EmailService = createEmailService({
  provider: env.email.provider,
  nodeEnv: env.nodeEnv,
  smtp: env.email,
});
