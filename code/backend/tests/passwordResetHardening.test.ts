import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { emailService } from '../src/services/email';
import { hashPassword } from '../src/utils/password';
import { hashResetToken } from '../src/utils/passwordResetToken';

// Hardening tests for the forgot/reset flow, on top of passwordReset.test.ts:
// what an attacker can learn from timing, what a stale or tampered request can
// change, and what a failing mail provider must not break.

const app = createApp();

const PREFIX = 'pwhard.';
const VALID_PASSWORD = 'CorrectHorse123';
const NEW_PASSWORD = 'NewCorrectHorse456';

let counter = 0;
const uniqueEmail = (label: string) => `${PREFIX}${label}.${Date.now()}.${++counter}@${env.allowedStudentEmailDomain}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function registerStudent(label: string) {
  const email = uniqueEmail(label);
  const res = await request(app).post('/api/auth/register').send({ name: `Hard ${label}`, email, password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId as string, email };
}

// Requests a reset and returns the raw token the user would receive by email.
async function requestToken(email: string): Promise<string> {
  const spy = jest.spyOn(emailService, 'send').mockResolvedValue(undefined);
  const res = await request(app).post('/api/auth/forgot-password').send({ email });
  expect(res.status).toBe(200);
  const text = spy.mock.calls[0]![0].text;
  spy.mockRestore();
  return new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe('forgot-password does not reveal whether an account exists', () => {
  it('response time does not depend on mail delivery: an existing account is not measurably slower than an unknown one', async () => {
    const { email } = await registerStudent('timing');
    const DELIVERY_MS = 400; // a slow mail provider
    const send = jest.spyOn(emailService, 'send').mockImplementation(async () => {
      await sleep(DELIVERY_MS);
    });

    const t0 = Date.now();
    const existing = await request(app).post('/api/auth/forgot-password').send({ email });
    const existingMs = Date.now() - t0;

    const t1 = Date.now();
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail('nobody') });
    const unknownMs = Date.now() - t1;

    expect(existing.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(existing.body).toEqual(unknown.body);
    expect(send).toHaveBeenCalledTimes(1); // the mail really was sent for the existing account
    // The slow delivery must not be on the request path (otherwise 400ms+ vs a few ms is a trivial oracle).
    expect(existingMs).toBeLessThan(DELIVERY_MS / 2);
    expect(Math.abs(existingMs - unknownMs)).toBeLessThan(DELIVERY_MS / 2);
    await sleep(DELIVERY_MS + 100); // let the background delivery finish before the test ends
  });

  it('a failing mail provider still gives the identical generic 200, keeps a valid token, and does not crash', async () => {
    const { userId, email } = await registerStudent('mailfail');
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(emailService, 'send').mockRejectedValue(new Error('SMTP 550 mailbox unavailable'));

    const failing = await request(app).post('/api/auth/forgot-password').send({ email });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail('nobody2') });
    await sleep(100); // delivery failure is handled in the background

    expect(failing.status).toBe(200);
    expect(failing.body).toEqual(unknown.body);
    expect(await prisma.passwordResetToken.count({ where: { userId, usedAt: null } })).toBe(1);
    expect(errorLog).toHaveBeenCalled(); // an operator can see it...
    expect(JSON.stringify(failing.body)).not.toMatch(/SMTP|550|mailbox/); // ...the caller cannot
  });

  it('extra fields in the forgot-password body (role, userId, status) change nothing', async () => {
    const { userId, email } = await registerStudent('forgotextra');
    jest.spyOn(emailService, 'send').mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email, role: 'ADMIN', status: 'INACTIVE', userId: 'someone-else' });

    expect(res.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { userId } });
    expect(user.role).toBe('STUDENT');
    expect(user.status).toBe('ACTIVE');
  });
});

describe('reset-password cannot be used to change anything but the password', () => {
  it('ignores role / status / email / passwordHash / userId fields: only the password changes', async () => {
    const { userId, email } = await registerStudent('tamper');
    const other = await registerStudent('tamper-victim');
    const token = await requestToken(email);
    const before = await prisma.user.findUniqueOrThrow({ where: { userId } });

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
      role: 'ADMIN',
      status: 'INACTIVE',
      email: 'attacker@example.com',
      passwordHash: 'x',
      userId: other.userId,
      shopId: 'any-shop',
    });

    expect(res.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { userId } });
    expect(after.role).toBe('STUDENT');
    expect(after.status).toBe('ACTIVE');
    expect(after.email).toBe(email);
    expect(after.shopId).toBeNull();
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordHash).not.toBe('x');
    // the other account is untouched and the new password works only for the token's owner
    expect((await request(app).post('/api/auth/login').send({ email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: other.email, password: NEW_PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: other.email, password: VALID_PASSWORD })).status).toBe(200);
  });

  it('does not log anyone in: the response carries no session token or user data', async () => {
    const { email } = await registerStudent('nosession');
    const token = await requestToken(email);
    const res = await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  });

  it('a reset link issued BEFORE the account was deactivated stops working', async () => {
    const { userId, email } = await registerStudent('deactivated');
    const token = await requestToken(email);
    await prisma.user.update({ where: { userId }, data: { status: 'INACTIVE' } });
    const before = await prisma.user.findUniqueOrThrow({ where: { userId } });

    const res = await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('This password reset link is invalid or has expired');
    expect((await prisma.user.findUniqueOrThrow({ where: { userId } })).passwordHash).toBe(before.passwordHash);
    expect((await prisma.user.findUniqueOrThrow({ where: { userId } })).status).toBe('INACTIVE'); // not reactivated by recovery
  });

  it('a link for an account that was DELETED after the request is simply invalid', async () => {
    const { userId, email } = await registerStudent('deleted');
    const token = await requestToken(email);
    await prisma.user.delete({ where: { userId } });
    const res = await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('the stored token is a SHA-256 hash tied to the right user and expires in about an hour', async () => {
    const { userId, email } = await registerStudent('storage');
    const token = await requestToken(email);
    const row = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashResetToken(token) } });
    expect(row.userId).toBe(userId);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(token);
    const ttlMin = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
    expect(ttlMin).toBeGreaterThan(55);
    expect(ttlMin).toBeLessThanOrEqual(61);
    expect(row.usedAt).toBeNull();
  });

  it('a changed password invalidates nothing it should not: other users keep working, and the OLD password stops working', async () => {
    const { email } = await registerStudent('oldpw');
    const token = await requestToken(email);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('new password is stored with the same bcrypt scheme registration uses', async () => {
    const { userId, email } = await registerStudent('bcrypt');
    const token = await requestToken(email);
    await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { userId } });
    const sample = await hashPassword('x');
    expect(passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(passwordHash.slice(0, 7)).toBe(sample.slice(0, 7)); // same algorithm + cost as hashPassword()
  });
});
