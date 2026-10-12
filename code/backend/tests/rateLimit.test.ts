import path from 'node:path';

import request from 'supertest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

const TEST_EMAIL_PREFIX = 'ratelimittest.';
const VALID_PASSWORD = 'CorrectHorse123';
const FIXTURE_PDF = path.join(__dirname, 'fixtures', 'valid.pdf');

function uniqueEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@thapar.edu`;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.$disconnect();
});

describe('login rate limit', () => {
  it('returns 429 on the sixth failed login attempt within one minute', async () => {
    const app = createApp({ rateLimit: { enabled: true, login: { max: 5, windowMs: 60_000 } } });
    const email = uniqueEmail('nobody');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app).post('/api/auth/login').send({ email, password: 'WrongPassword1' });
      expect(res.status).toBe(401);
    }

    const sixth = await request(app).post('/api/auth/login').send({ email, password: 'WrongPassword1' });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({
      success: false,
      message: 'Too many failed login attempts. Please try again later.',
    });
    expect(sixth.headers['retry-after']).toBeDefined();
    expect(sixth.headers['ratelimit-policy']).toBeDefined();
  });

  it('counts per account, so another email from the same client is not blocked', async () => {
    const app = createApp({ rateLimit: { enabled: true, login: { max: 5, windowMs: 60_000 } } });
    const blocked = uniqueEmail('blocked');
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await request(app).post('/api/auth/login').send({ email: blocked, password: 'WrongPassword1' });
    }

    const other = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('other'), password: 'WrongPassword1' });
    expect(other.status).toBe(401);
  });

  it('does not count successful logins', async () => {
    const app = createApp({ rateLimit: { enabled: true, login: { max: 2, windowMs: 60_000 } } });
    const email = uniqueEmail('real');
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Rate Limit Student', email, phone: '9876500099', password: VALID_PASSWORD });
    expect(registered.status).toBe(201);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD });
      expect(res.status).toBe(200);
    }
  });
});

describe('other auth rate limits', () => {
  it('limits registration per client', async () => {
    const app = createApp({ rateLimit: { enabled: true, register: { max: 1, windowMs: 60_000 } } });
    await request(app).post('/api/auth/register').send({});
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many registration attempts. Please try again later.');
  });

  it('limits forgot-password requests per account', async () => {
    const app = createApp({ rateLimit: { enabled: true, forgotPassword: { max: 1, windowMs: 60_000 } } });
    const email = uniqueEmail('forgot');
    await request(app).post('/api/auth/forgot-password').send({ email });
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(429);
  });

  it('limits reset-password attempts per client', async () => {
    const app = createApp({ rateLimit: { enabled: true, resetPassword: { max: 1, windowMs: 60_000 } } });
    await request(app).post('/api/auth/reset-password').send({});
    const res = await request(app).post('/api/auth/reset-password').send({});
    expect(res.status).toBe(429);
  });

  it('applies the shared per-client fallback across the auth endpoints', async () => {
    const app = createApp({ rateLimit: { enabled: true, authIp: { max: 2, windowMs: 60_000 } } });
    await request(app).post('/api/auth/register').send({});
    await request(app).post('/api/auth/reset-password').send({});
    const res = await request(app).post('/api/auth/login').send({ email: uniqueEmail('x'), password: 'x' });
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many requests from this network. Please try again later.');
  });
});

describe('upload rate limit', () => {
  // authenticate() only verifies the JWT, so no database user is needed for
  // the limiter itself; the first requests carry no file and stop at 400.
  const tokenA = signAccessToken({ userId: '00000000-0000-4000-8000-00000000000a', role: 'STUDENT' });
  const tokenB = signAccessToken({ userId: '00000000-0000-4000-8000-00000000000b', role: 'STUDENT' });

  it('returns 429 per user once the limit is reached, before the file is processed', async () => {
    const app = createApp({ rateLimit: { enabled: true, upload: { max: 2, windowMs: 60_000 } } });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await request(app).post('/api/documents').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    }

    const limited = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', FIXTURE_PDF);
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe('Too many uploads. Please try again later.');

    const otherUser = await request(app).post('/api/documents').set('Authorization', `Bearer ${tokenB}`);
    expect(otherUser.status).toBe(400);
  });

  it('still requires authentication before counting', async () => {
    const app = createApp({ rateLimit: { enabled: true, upload: { max: 1, windowMs: 60_000 } } });
    const res = await request(app).post('/api/documents');
    expect(res.status).toBe(401);
  });
});

describe('rate limiting disabled for the general suite', () => {
  it('lets many failed logins through when limits are off', async () => {
    const app = createApp();
    const email = uniqueEmail('unlimited');
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const res = await request(app).post('/api/auth/login').send({ email, password: 'WrongPassword1' });
      expect(res.status).toBe(401);
    }
  });
});
