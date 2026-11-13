import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { MockEmailService, createEmailService, emailService } from '../src/services/email';
import { DevConsoleEmailService } from '../src/services/email/devConsoleEmail.service';
import { SmtpEmailService } from '../src/services/email/smtpEmail.service';

const app = createApp();
const PREFIX = 'emailprov.';
const SMTP = { host: 'smtp.example.test', port: 587, user: 'u', password: 'p', from: 'SmartPrint <no-reply@example.test>' };
const NO_SMTP = { from: SMTP.from };

afterAll(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe('MockEmailService', () => {
  const message = { to: 'A@Example.com', subject: 's', text: 't' };

  it('records messages in memory and delivers nothing', async () => {
    const mock = new MockEmailService();
    await mock.send(message);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toEqual(message);
  });

  it('keeps its own copy: mutating the original afterwards cannot rewrite what was "sent"', async () => {
    const mock = new MockEmailService();
    const original = { ...message };
    await mock.send(original);
    original.to = 'attacker@example.com';
    expect(mock.sent[0]!.to).toBe('A@Example.com');
  });

  it('finds messages by recipient (case-insensitive) and can be cleared', async () => {
    const mock = new MockEmailService();
    await mock.send(message);
    await mock.send({ ...message, to: 'b@example.com' });
    expect(mock.sentTo('a@example.com')).toHaveLength(1);
    mock.clear();
    expect(mock.sent).toHaveLength(0);
  });
});

describe('createEmailService - provider selection', () => {
  it('automatic + SMTP fully configured -> SMTP (also in production)', () => {
    expect(createEmailService({ nodeEnv: 'development', smtp: SMTP })).toBeInstanceOf(SmtpEmailService);
    expect(createEmailService({ nodeEnv: 'production', smtp: SMTP })).toBeInstanceOf(SmtpEmailService);
  });

  it.each(['development', 'test'])('automatic + no SMTP -> the dev console in %s', (nodeEnv) => {
    expect(createEmailService({ nodeEnv, smtp: NO_SMTP })).toBeInstanceOf(DevConsoleEmailService);
  });

  it('automatic + no SMTP in production -> refuses (never "succeeds" without delivering)', () => {
    expect(() => createEmailService({ nodeEnv: 'production', smtp: NO_SMTP })).toThrow(/email is not configured/i);
  });

  it('a partly configured SMTP counts as not configured', () => {
    expect(() => createEmailService({ nodeEnv: 'production', smtp: { ...SMTP, password: undefined } })).toThrow(/email is not configured/i);
    expect(createEmailService({ nodeEnv: 'development', smtp: { ...SMTP, host: undefined } })).toBeInstanceOf(DevConsoleEmailService);
  });

  it.each(['development', 'test'])('explicit mock and console work in %s', (nodeEnv) => {
    expect(createEmailService({ provider: 'mock', nodeEnv, smtp: NO_SMTP })).toBeInstanceOf(MockEmailService);
    expect(createEmailService({ provider: 'console', nodeEnv, smtp: NO_SMTP })).toBeInstanceOf(DevConsoleEmailService);
  });

  it.each(['mock', 'console'])('explicit %s is refused in production, even with SMTP configured', (provider) => {
    expect(() => createEmailService({ provider, nodeEnv: 'production', smtp: SMTP })).toThrow(/not allowed in production/i);
  });

  it('explicit smtp needs the four SMTP settings', () => {
    expect(() => createEmailService({ provider: 'smtp', nodeEnv: 'development', smtp: NO_SMTP })).toThrow(/requires EMAIL_HOST/);
    expect(createEmailService({ provider: 'smtp', nodeEnv: 'production', smtp: SMTP })).toBeInstanceOf(SmtpEmailService);
  });

  it('an unknown provider name is a startup error, not a silent fallback', () => {
    expect(() => createEmailService({ provider: 'sendgrid', nodeEnv: 'development', smtp: SMTP })).toThrow(/not a known email provider/);
  });
});

describe('the test environment can never send real email', () => {
  it('uses the in-memory mock provider', () => {
    expect(emailService).toBeInstanceOf(MockEmailService);
  });
});

describe('the reset email a user receives', () => {
  const mock = emailService as MockEmailService;

  async function registerAndRequest(label: string) {
    const email = `${PREFIX}${label}.${Date.now()}@${env.allowedStudentEmailDomain}`;
    const reg = await request(app).post('/api/auth/register').send({ name: 'Email Prov', email, password: 'CorrectHorse123' });
    expect(reg.status).toBe(201);
    mock.clear();
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    return email;
  }

  it('is sent to the account address, with a one-time link to the frontend reset page, and says it expires', async () => {
    const email = await registerAndRequest('content');
    const [msg] = mock.sentTo(email);
    expect(mock.sent).toHaveLength(1);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/reset/i);
    const link = new URL(msg!.text.match(/https?:\/\/\S+/)![0]);
    expect(link.origin + link.pathname).toBe(`${new URL(env.frontendUrl).origin}/reset-password`);
    expect(link.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
    expect(msg!.text).toMatch(/expires in 1 hour/i);
    expect(msg!.text).toMatch(/only be used once/i);
    expect(msg!.html).toContain(link.toString());
  });

  it('sends nothing at all for an unknown address or an inactive account', async () => {
    mock.clear();
    expect((await request(app).post('/api/auth/forgot-password').send({ email: `${PREFIX}nobody@${env.allowedStudentEmailDomain}` })).status).toBe(200);
    expect(mock.sent).toHaveLength(0);

    const email = await registerAndRequest('inactive');
    await prisma.user.update({ where: { email }, data: { status: 'INACTIVE' } });
    mock.clear();
    expect((await request(app).post('/api/auth/forgot-password').send({ email })).status).toBe(200);
    expect(mock.sent).toHaveLength(0);
  });

  it('does not produce a doubled slash when FRONTEND_URL ends with "/"', async () => {
    const mutable = env as { frontendUrl: string };
    const saved = mutable.frontendUrl;
    mutable.frontendUrl = 'https://print.example.edu/';
    try {
      const email = await registerAndRequest('slash');
      const link = mock.sentTo(email)[0]!.text.match(/https?:\/\/\S+/)![0];
      expect(link.startsWith('https://print.example.edu/reset-password?token=')).toBe(true);
      expect(link).not.toContain('//reset-password');
    } finally {
      mutable.frontendUrl = saved;
    }
  });
});
