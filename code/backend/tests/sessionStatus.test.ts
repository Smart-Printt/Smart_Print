import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'sessionstatus.';
const VALID_PASSWORD = 'CorrectHorse123';

let counter = 0;
function uniqueEmail(label: string): string {
  counter += 1;
  return `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${counter}@${env.allowedStudentEmailDomain}`;
}

async function createStudent(label: string) {
  return prisma.user.create({
    data: {
      name: 'Session Student',
      email: uniqueEmail(label),
      passwordHash: await hashPassword(VALID_PASSWORD),
      role: 'STUDENT',
      status: 'ACTIVE',
    },
  });
}

function tokenFor(userId: string, role: 'STUDENT' | 'ADMIN', issuedAt?: number): string {
  return jwt.sign(issuedAt === undefined ? { userId, role } : { userId, role, iat: issuedAt }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

function me(token: string) {
  return request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.$disconnect();
});

describe('authenticate re-checks the account on every request', () => {
  it('accepts a token for an active user', async () => {
    const user = await createStudent('active');
    expect((await me(tokenFor(user.userId, 'STUDENT'))).status).toBe(200);
  });

  it('rejects an already-issued token once the account is deactivated', async () => {
    const user = await createStudent('deactivated');
    const token = tokenFor(user.userId, 'STUDENT');
    expect((await me(token)).status).toBe(200);

    await prisma.user.update({ where: { userId: user.userId }, data: { status: 'INACTIVE' } });

    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Account is inactive');
  });

  it('works again if the account is reactivated', async () => {
    const user = await createStudent('reactivated');
    const token = tokenFor(user.userId, 'STUDENT');
    await prisma.user.update({ where: { userId: user.userId }, data: { status: 'INACTIVE' } });
    expect((await me(token)).status).toBe(401);

    await prisma.user.update({ where: { userId: user.userId }, data: { status: 'ACTIVE' } });
    expect((await me(token)).status).toBe(200);
  });

  it('rejects a token whose user no longer exists', async () => {
    const user = await createStudent('deleted');
    const token = tokenFor(user.userId, 'STUDENT');
    await prisma.user.delete({ where: { userId: user.userId } });

    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid token');
  });

  it('uses the role stored in the database, not the one in the token', async () => {
    const user = await createStudent('forged-role');
    // A token claiming ADMIN for a STUDENT account must not pass an admin check.
    const res = await request(app)
      .get('/api/test/admin')
      .set('Authorization', `Bearer ${tokenFor(user.userId, 'ADMIN')}`);
    expect(res.status).toBe(403);
  });
});

describe('tokens issued before a password change stop working', () => {
  it('rejects a token issued before passwordChangedAt', async () => {
    const user = await createStudent('pw-old-token');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldToken = tokenFor(user.userId, 'STUDENT', nowSeconds - 60);
    expect((await me(oldToken)).status).toBe(200);

    await prisma.user.update({ where: { userId: user.userId }, data: { passwordChangedAt: new Date() } });

    const res = await me(oldToken);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Session expired, please sign in again');
  });

  it('accepts a token issued after passwordChangedAt', async () => {
    const user = await createStudent('pw-new-token');
    await prisma.user.update({
      where: { userId: user.userId },
      data: { passwordChangedAt: new Date(Date.now() - 60_000) },
    });
    expect((await me(tokenFor(user.userId, 'STUDENT'))).status).toBe(200);
  });

  it('a completed password reset invalidates tokens issued before it', async () => {
    const user = await createStudent('pw-reset');
    const oldToken = tokenFor(user.userId, 'STUDENT', Math.floor(Date.now() / 1000) - 60);
    expect((await me(oldToken)).status).toBe(200);

    await prisma.user.update({ where: { userId: user.userId }, data: { passwordChangedAt: new Date() } });

    expect((await me(oldToken)).status).toBe(401);

    // Logging in again after the change works and the new token is accepted.
    await prisma.user.update({ where: { userId: user.userId }, data: { passwordChangedAt: new Date(Date.now() - 5000) } });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: VALID_PASSWORD });
    expect(login.status).toBe(200);
    expect((await me(login.body.data.token)).status).toBe(200);
  });
});
