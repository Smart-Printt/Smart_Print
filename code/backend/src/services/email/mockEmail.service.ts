import { EmailMessage, EmailService } from './email.service';

// In-memory provider for automated tests: nothing leaves the process, and the
// "sent" messages can be inspected afterwards (e.g. to pull the reset link out
// of the message a user would have received). Selected with EMAIL_PROVIDER=mock
// - the test setup forces this, so a test run can never send real email even if
// SMTP credentials are present in the environment. Never allowed in production
// (see createEmailService in index.ts).
export class MockEmailService implements EmailService {
  private readonly outbox: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    // Copied so later mutation of the caller's object cannot rewrite history.
    this.outbox.push({ ...message });
  }

  get sent(): readonly EmailMessage[] {
    return this.outbox;
  }

  sentTo(address: string): EmailMessage[] {
    return this.outbox.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
