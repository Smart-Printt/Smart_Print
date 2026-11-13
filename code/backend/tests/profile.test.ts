import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'profiletest.';
const OLD_PASSWORD = 'CorrectHorse123';
const NEW_PASSWORD = 'BrandNewPass456';
const CLIENT_HEADER = 'X-SmartPrint-Client';

let counter = 0;
async function createStudent(label: string) {
  counter += 1;
  return prisma.user.create({
    data: {
      name: 'Profile Student',
      email: `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${counter}@${env.allowedStudentEmailDomain}`,
      phone: '9876500000',
      passwordHash: await hashPassword(OLD_PASSWORD),
      role: 'STUDENT',
      status: 'ACTIVE',
    },
  });
}

function cookieFrom(res: request.Response): string {
  const list = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const raw = list.find((c) => c.startsWith('smartprint_refresh='));
  expect(raw).toBeDefined();
  return (raw as string).split(';')[0];
}

async function loginAs(email: string, password = OLD_PASSWORD) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return { token: res.body.data.token as string, cookie: cookieFrom(res) };
}

function refresh(cookie: string) {
  return request(app).post('/api/auth/refresh').set('Cookie', cookie).set(CLIENT_HEADER, 'web');
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.$disconnect();
});

describe('PATCH /api/auth/me', () => {
  it('requires authentication', async () => {
    expect((await request(app).patch('/api/auth/me').send({ name: 'Nobody' })).status).toBe(401);
  });

  it('updates the name and phone', async () => {
    const user = await createStudent('update');
    const { token } = await loginAs(user.email);

    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  New Name  ', phone: '+919876543210' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('New Name');
    expect(res.body.data.user.phone).toBe('+919876543210');
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const stored = await prisma.user.findUniqueOrThrow({ where: { userId: user.userId } });
    expect(stored.name).toBe('New Name');
  });

  it('clears the phone number when given an empty string', async () => {
    const user = await createStudent('clear-phone');
    const { token } = await loginAs(user.email);

    const res = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ phone: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.phone).toBeNull();
  });

  it('changes only the fields sent', async () => {
    const user = await createStudent('partial');
    const { token } = await loginAs(user.email);

    const res = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ name: 'Only Name' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.phone).toBe('9876500000');
  });

  it.each([
    ['a one-letter name', { name: 'A' }],
    ['a very long name', { name: 'x'.repeat(101) }],
    ['a bad phone number', { phone: 'abc' }],
    ['an empty body', {}],
  ])('rejects %s', async (_label, body) => {
    const user = await createStudent('invalid');
    const { token } = await loginAs(user.email);

    const res = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(400);
  });

  it('ignores email, role, status and shop in the body', async () => {
    const user = await createStudent('escalate');
    const { token } = await loginAs(user.email);

    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Still Student', email: 'someone.else@thapar.edu', role: 'ADMIN', status: 'INACTIVE', shopId: 'x' });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { userId: user.userId } });
    expect(stored.email).toBe(user.email);
    expect(stored.role).toBe('STUDENT');
    expect(stored.status).toBe('ACTIVE');
    expect(stored.shopId).toBeNull();
  });
});

describe('POST /api/auth/change-password', () => {
  function change(token: string, body: Record<string, unknown>) {
    return request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);
  }

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('changes the password: the new one logs in, the old one does not', async () => {
    const user = await createStudent('change');
    const { token } = await loginAs(user.email);

    const res = await change(token, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['token', 'user']);

    const oldLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: OLD_PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
  });

  it('keeps the current device signed in with a fresh token and cookie', async () => {
    const user = await createStudent('keep-device');
    const { token } = await loginAs(user.email);

    const res = await change(token, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect((await refresh(cookieFrom(res))).status).toBe(200);
  });

  it('signs out every other session: old access tokens and refresh cookies stop working', async () => {
    const user = await createStudent('others');
    const laptop = await loginAs(user.email);
    const phone = await loginAs(user.email);

    // Make sure the old tokens were issued in an earlier second than the change.
    await prisma.user.update({ where: { userId: user.userId }, data: { passwordChangedAt: null } });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await change(laptop.token, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const phoneAccess = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${phone.token}`);
    expect(phoneAccess.status).toBe(401);
    expect((await refresh(phone.cookie)).status).toBe(401);
    expect((await refresh(laptop.cookie)).status).toBe(401);
  });

  it('rejects a wrong current password with 400, not 401, and changes nothing', async () => {
    const user = await createStudent('wrong-current');
    const { token } = await loginAs(user.email);

    const res = await change(token, { currentPassword: 'WrongPassword1', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Current password is incorrect');

    expect((await request(app).post('/api/auth/login').send({ email: user.email, password: OLD_PASSWORD })).status).toBe(200);
  });

  it.each([
    ['a too-short password', { newPassword: 'Ab1' }, 'at least 8'],
    ['a password with no number', { newPassword: 'OnlyLettersHere' }, 'letter and one number'],
    ['mismatched confirmation', { newPassword: NEW_PASSWORD, confirmPassword: 'Different123' }, 'do not match'],
    ['the same password as before', { newPassword: OLD_PASSWORD }, 'different'],
  ])('rejects %s', async (_label, body, messagePart) => {
    const user = await createStudent('policy');
    const { token } = await loginAs(user.email);

    const res = await change(token, { currentPassword: OLD_PASSWORD, ...body });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(messagePart);
  });

  it('rejects missing fields', async () => {
    const user = await createStudent('missing');
    const { token } = await loginAs(user.email);
    expect((await change(token, { newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await change(token, { currentPassword: OLD_PASSWORD })).status).toBe(400);
  });
});

describe('change-password rate limit', () => {
  it('limits attempts per user, so a stolen access token cannot guess the current password', async () => {
    const limitedApp = createApp({ rateLimit: { enabled: true, changePassword: { max: 3, windowMs: 60_000 } } });
    const user = await createStudent('limited');
    const login = await request(limitedApp).post('/api/auth/login').send({ email: user.email, password: OLD_PASSWORD });
    const token = login.body.data.token as string;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await request(limitedApp)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'WrongPassword1', newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
    }

    const blocked = await request(limitedApp)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe('Too many password change attempts. Please try again later.');
  });
});
