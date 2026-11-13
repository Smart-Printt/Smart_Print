import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { revokeUserSessions } from '../src/services/session.service';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'refreshtest.';
const VALID_PASSWORD = 'CorrectHorse123';
const CLIENT_HEADER = 'X-SmartPrint-Client';

let counter = 0;
async function createStudent(label: string) {
  counter += 1;
  return prisma.user.create({
    data: {
      name: 'Refresh Student',
      email: `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${counter}@${env.allowedStudentEmailDomain}`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role: 'STUDENT',
      status: 'ACTIVE',
    },
  });
}

function setCookies(res: request.Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

// The "name=value" part of the refresh cookie, as a browser would send it back.
function cookieFrom(res: request.Response): string {
  const raw = setCookies(res).find((c) => c.startsWith('smartprint_refresh='));
  expect(raw).toBeDefined();
  return (raw as string).split(';')[0];
}

async function loginAs(email: string) {
  const res = await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD });
  expect(res.status).toBe(200);
  return { res, cookie: cookieFrom(res) };
}

function refresh(cookie?: string, withHeader = true) {
  let req = request(app).post('/api/auth/refresh');
  if (cookie) req = req.set('Cookie', cookie);
  if (withHeader) req = req.set(CLIENT_HEADER, 'web');
  return req;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.$disconnect();
});

describe('login sets the refresh cookie', () => {
  it('uses an httpOnly cookie limited to /api/auth and never puts the refresh token in the body', async () => {
    const user = await createStudent('cookie');
    const { res } = await loginAs(user.email);
    const header = setCookies(res).find((c) => c.startsWith('smartprint_refresh=')) as string;

    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Path=\/api\/auth/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(Object.keys(res.body.data).sort()).toEqual(['token', 'user']);
  });

  it('stores only a hash of the token', async () => {
    const user = await createStudent('hashed');
    const { cookie } = await loginAs(user.email);
    const raw = cookie.split('=')[1];

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /api/auth/refresh', () => {
  it('requires the client header', async () => {
    const user = await createStudent('no-header');
    const { cookie } = await loginAs(user.email);
    expect((await refresh(cookie, false)).status).toBe(403);
  });

  it('rejects a request without a cookie', async () => {
    expect((await refresh()).status).toBe(401);
  });

  it('rejects an unknown token and clears the cookie', async () => {
    const res = await refresh('smartprint_refresh=not-a-real-token');
    expect(res.status).toBe(401);
    expect(setCookies(res).join(';')).toMatch(/smartprint_refresh=;/);
  });

  it('returns a working access token and rotates the refresh cookie', async () => {
    const user = await createStudent('rotate');
    const first = await loginAs(user.email);

    const res = await refresh(first.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.user.userId).toBe(user.userId);

    const newCookie = cookieFrom(res);
    expect(newCookie).not.toBe(first.cookie);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);

    // The new cookie works too, so the chain continues.
    expect((await refresh(newCookie)).status).toBe(200);
  });

  it('refuses an old token after rotation, and revokes the whole chain if it is replayed late', async () => {
    const user = await createStudent('reuse');
    const first = await loginAs(user.email);
    const second = await refresh(first.cookie);
    const newCookie = cookieFrom(second);

    // Pretend the rotation happened a minute ago, outside the grace window.
    await prisma.refreshToken.updateMany({
      where: { userId: user.userId, revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    expect((await refresh(first.cookie)).status).toBe(401);
    // A late replay means the token leaked, so even the newest token is now dead.
    expect((await refresh(newCookie)).status).toBe(401);
  });

  it('tolerates a replay inside the grace window without killing the session', async () => {
    const user = await createStudent('grace');
    const first = await loginAs(user.email);
    const second = await refresh(first.cookie);
    const newCookie = cookieFrom(second);

    // Two tabs refreshing at once: the loser gets 401, the winner's token lives.
    expect((await refresh(first.cookie)).status).toBe(401);
    expect((await refresh(newCookie)).status).toBe(200);
  });

  it('lets only one of two simultaneous refreshes with the same token succeed', async () => {
    const user = await createStudent('concurrent');
    const { cookie } = await loginAs(user.email);

    const results = await Promise.all([refresh(cookie), refresh(cookie)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('refuses an expired refresh token', async () => {
    const user = await createStudent('expired');
    const { cookie } = await loginAs(user.email);
    await prisma.refreshToken.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refresh(cookie)).status).toBe(401);
  });

  it('refuses to refresh for a deactivated account', async () => {
    const user = await createStudent('inactive');
    const { cookie } = await loginAs(user.email);
    await prisma.user.update({ where: { userId: user.userId }, data: { status: 'INACTIVE' } });

    const res = await refresh(cookie);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Account is inactive');
  });

  it('refuses a refresh token issued before a password change', async () => {
    const user = await createStudent('pw-change');
    const { cookie } = await loginAs(user.email);
    await prisma.user.update({ where: { userId: user.userId }, data: { passwordChangedAt: new Date() } });
    expect((await refresh(cookie)).status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token and clears the cookie', async () => {
    const user = await createStudent('logout');
    const { cookie } = await loginAs(user.email);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).set(CLIENT_HEADER, 'web');
    expect(out.status).toBe(200);
    expect(setCookies(out).join(';')).toMatch(/smartprint_refresh=;/);

    expect((await refresh(cookie)).status).toBe(401);
  });

  it('is harmless without a cookie and still needs the client header', async () => {
    const ok = await request(app).post('/api/auth/logout').set(CLIENT_HEADER, 'web');
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/auth/logout')).status).toBe(403);
  });
});

describe('revokeUserSessions', () => {
  it('signs a user out everywhere without touching other users', async () => {
    const alice = await createStudent('alice');
    const bob = await createStudent('bob');
    const aliceLaptop = await loginAs(alice.email);
    const alicePhone = await loginAs(alice.email);
    const bobLogin = await loginAs(bob.email);

    expect(await revokeUserSessions(alice.userId)).toBe(2);

    expect((await refresh(aliceLaptop.cookie)).status).toBe(401);
    expect((await refresh(alicePhone.cookie)).status).toBe(401);
    expect((await refresh(bobLogin.cookie)).status).toBe(200);
  });
});
