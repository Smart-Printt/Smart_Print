import fsSync from 'node:fs';
import path from 'node:path';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { parseRangeDays, shiftDate } from '../src/services/analytics.service';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const EMAIL_PREFIX = 'analyticstest.';
const SHOP_PREFIX = 'ANALYTICSTEST-';
const PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

let counter = 0;
const unique = (label: string): string => `${label}.${Date.now()}.${(counter += 1)}`;
const shopIds: string[] = [];

function tokenFor(userId: string, role: 'ADMIN' | 'SHOP_STAFF'): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

async function createUser(label: string, role: 'ADMIN' | 'SHOP_STAFF', shopId?: string) {
  const user = await prisma.user.create({
    data: {
      name: `Analytics Test ${label}`,
      email: `${EMAIL_PREFIX}${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      status: 'ACTIVE',
      shopId: shopId ?? null,
    },
  });
  return { userId: user.userId, token: tokenFor(user.userId, role) };
}

async function registerStudent(label: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      name: `Analytics Test ${label}`,
      email: `${EMAIL_PREFIX}${unique(label)}@${env.allowedStudentEmailDomain}`,
      password: PASSWORD,
    });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId as string, token: res.body.data.token as string };
}

async function createShop(label: string): Promise<PrintShop> {
  const shop = await prisma.printShop.create({
    data: {
      shopCode: `${SHOP_PREFIX}${unique(label)}`,
      shopName: `Analytics Test Shop ${label}`,
      location: 'Test Location',
      contact: '9000000000',
      isActive: true,
      acceptingOrders: true,
    },
  });
  shopIds.push(shop.shopId);
  await prisma.shopPricingRule.create({
    data: {
      shopId: shop.shopId,
      printType: 'BW',
      paperSize: 'A4',
      sides: 'SINGLE',
      pricePerPage: 2.0,
      effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });
  return shop;
}

async function placeOrder(token: string, shop: PrintShop): Promise<{ orderId: string; total: number }> {
  const upload = await request(app)
    .post('/api/documents')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', fsSync.readFileSync(path.join(FIXTURES_DIR, 'valid.pdf')), {
      filename: 'valid.pdf',
      contentType: 'application/pdf',
    });
  expect(upload.status).toBe(201);
  const created = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      shopId: shop.shopId,
      items: [
        { documentId: upload.body.data.document.documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
      ],
    });
  expect(created.status).toBe(201);
  return { orderId: created.body.data.order.orderId, total: Number(created.body.data.order.totalAmount) };
}

async function pay(token: string, orderId: string): Promise<void> {
  await request(app).post(`/api/orders/${orderId}/payment`).set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'UPI' });
  const confirmed = await request(app)
    .post(`/api/orders/${orderId}/payment/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ simulateOutcome: 'SUCCESS' });
  expect(confirmed.status).toBe(200);
}

const get = (token: string, query = '') =>
  request(app).get(`/api/admin/analytics${query}`).set('Authorization', `Bearer ${token}`);

let admin: { userId: string; token: string };

beforeAll(async () => {
  admin = await createUser('admin', 'ADMIN');
});

afterAll(async () => {
  // Delete by BOTH the shops this run created and any leftover rows owned by
  // this suite's users/shops (an earlier run that crashed mid-cleanup must not
  // block this one with a foreign-key error).
  const mine = { OR: [{ shopId: { in: shopIds } }, { user: { email: { startsWith: EMAIL_PREFIX } } }] };
  await prisma.queue.deleteMany({ where: { order: mine } });
  await prisma.refund.deleteMany({ where: { payment: { order: mine } } });
  await prisma.payment.deleteMany({ where: { order: mine } });
  await prisma.order.deleteMany({ where: mine });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  const leftoverShops = { OR: [{ shopId: { in: shopIds } }, { shopCode: { startsWith: SHOP_PREFIX } }] };
  await prisma.shopPricingRule.deleteMany({ where: { shop: leftoverShops } });
  await prisma.printShop.deleteMany({ where: leftoverShops });
  await prisma.$disconnect();
});

// A shop with a known history: order A (paid, backdated to 2 days ago at
// 10:30 IST, 4-minute wait, 3-minute print), order B (paid, cancelled,
// refund requested and processed) and order C (placed, never paid). Plus a
// second shop with no activity at all.
async function seedScenario(label: string) {
  const shop = await createShop(label);
  const idleShop = await createShop(`${label}-idle`);
  const staff = await createUser(`${label}-staff`, 'SHOP_STAFF', shop.shopId);
  const student = await registerStudent(label);

  const a = await placeOrder(student.token, shop);
  await pay(student.token, a.orderId);
  const b = await placeOrder(student.token, shop);
  await pay(student.token, b.orderId);
  await placeOrder(student.token, shop);

  expect(
    (await request(app).patch(`/api/orders/${b.orderId}/cancel`).set('Authorization', `Bearer ${student.token}`).send({})).status,
  ).toBe(200);
  expect(
    (await request(app).post(`/api/orders/${b.orderId}/refund`).set('Authorization', `Bearer ${student.token}`).send({ reason: 'test' })).status,
  ).toBe(201);
  expect((await request(app).patch(`/api/orders/${b.orderId}/refund/process`).set('Authorization', `Bearer ${admin.token}`)).status).toBe(200);

  // 05:00 UTC == 10:30 IST, so the local day and hour are known.
  const base = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  base.setUTCHours(5, 0, 0, 0);
  const expectedDay = base.toISOString().slice(0, 10);
  await prisma.order.update({ where: { orderId: a.orderId }, data: { createdAt: base } });
  await prisma.payment.updateMany({ where: { orderId: a.orderId }, data: { paidAt: base } });
  await prisma.queue.update({
    where: { orderId: a.orderId },
    data: {
      enteredAt: base,
      startedAt: new Date(base.getTime() + 4 * 60_000),
      completedAt: new Date(base.getTime() + 7 * 60_000),
      queueStatus: 'COMPLETED',
    },
  });
  return { shop, idleShop, staff, student, a, b, expectedDay };
}

describe('range parsing and date helpers', () => {
  it('defaults to 30 days and accepts only the presets', () => {
    expect(parseRangeDays(undefined)).toBe(30);
    expect(parseRangeDays('7')).toBe(7);
    expect(parseRangeDays('90')).toBe(90);
    expect(() => parseRangeDays('14')).toThrow('days must be one of');
    expect(() => parseRangeDays('abc')).toThrow('days must be one of');
    expect(() => parseRangeDays('-1')).toThrow('days must be one of');
  });

  it('shifts calendar dates across month and leap-year boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('GET /api/admin/analytics - access', () => {
  it('requires a token', async () => {
    expect((await request(app).get('/api/admin/analytics')).status).toBe(401);
  });

  it('is closed to students and shop staff', async () => {
    const student = await registerStudent('student-denied');
    const shop = await createShop('denied');
    const staff = await createUser('staff-denied', 'SHOP_STAFF', shop.shopId);
    expect((await get(student.token)).status).toBe(403);
    expect((await get(staff.token)).status).toBe(403);
  });

  it('rejects an unsupported range', async () => {
    const res = await get(admin.token, '?days=14');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/analytics - numbers', () => {
  it('has a fixed shape: one entry per day, all 24 hours, zero-filled', async () => {
    const res = await get(admin.token, '?days=7');
    expect(res.status).toBe(200);
    const { analytics } = res.body.data;
    expect(analytics.range).toMatchObject({ days: 7, timezone: 'Asia/Kolkata' });
    expect(analytics.daily).toHaveLength(7);
    expect(analytics.daily[0].date).toBe(analytics.range.from);
    expect(analytics.daily[6].date).toBe(analytics.range.to);
    expect(analytics.hourly.map((h: { hour: number }) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('counts orders, revenue, refunds, waits and busy hours correctly for a known scenario', async () => {
    const { shop, idleShop, a, b, expectedDay } = await seedScenario('scenario');

    const res = await get(admin.token, '?days=7');
    expect(res.status).toBe(200);
    const { analytics } = res.body.data;
    expect(analytics.scope).toEqual({ type: 'all' });

    // Per shop: exact, because these shops contain only this scenario.
    const row = analytics.shops.find((s: { shopId: string }) => s.shopId === shop.shopId);
    expect(row).toMatchObject({ orders: 3, medianWaitMinutes: 4 });
    expect(Number(row.revenue)).toBeCloseTo(a.total + b.total, 2);
    const idle = analytics.shops.find((s: { shopId: string }) => s.shopId === idleShop.shopId);
    expect(idle).toMatchObject({ orders: 0, revenue: '0.00', medianWaitMinutes: null });

    // Global totals include other tests' data, so assert lower bounds and identities.
    const t = analytics.totals;
    expect(t.orders).toBeGreaterThanOrEqual(3);
    expect(t.cancelledOrders).toBeGreaterThanOrEqual(1);
    expect(t.paidOrders).toBeGreaterThanOrEqual(2);
    expect(Number(t.grossRevenue)).toBeGreaterThanOrEqual(a.total + b.total);
    expect(Number(t.refundedAmount)).toBeGreaterThanOrEqual(b.total);
    expect(Number(t.netRevenue)).toBeCloseTo(Number(t.grossRevenue) - Number(t.refundedAmount), 2);
    expect(t.refundRequests).toBeGreaterThanOrEqual(1);
    expect(t.refundRate).toBeGreaterThan(0);
    expect(typeof t.medianWaitMinutes).toBe('number');
    expect(typeof t.medianPrintMinutes).toBe('number');

    // Order A landed on that local day, in the 10:00 hour.
    const day = analytics.daily.find((d: { date: string }) => d.date === expectedDay);
    expect(day.orders).toBeGreaterThanOrEqual(1);
    expect(Number(day.revenue)).toBeGreaterThanOrEqual(a.total);
    expect(analytics.hourly[10].orders).toBeGreaterThanOrEqual(1);

    // A longer window can only contain >= the shorter one.
    const longer = await get(admin.token, '?days=90');
    expect(longer.body.data.analytics.totals.orders).toBeGreaterThanOrEqual(t.orders);
  });
});

describe('GET /api/shops/:shopId/analytics - a shop owner sees only their own shop', () => {
  const getShop = (token: string, shopId: string, query = '') =>
    request(app).get(`/api/shops/${shopId}/analytics${query}`).set('Authorization', `Bearer ${token}`);

  it('returns exact figures for that shop alone, ignoring every other shop in the database', async () => {
    const { shop, a, b, expectedDay, staff } = await seedScenario('owner');

    const res = await getShop(staff.token, shop.shopId, '?days=7');
    expect(res.status).toBe(200);
    const { analytics } = res.body.data;

    expect(analytics.scope).toMatchObject({ type: 'shop', shopId: shop.shopId, shopName: shop.shopName });
    expect(analytics.shops).toHaveLength(1);
    expect(analytics.shops[0]).toMatchObject({ shopId: shop.shopId, orders: 3, medianWaitMinutes: 4 });

    const t = analytics.totals;
    expect(t).toMatchObject({
      orders: 3,
      cancelledOrders: 1,
      paidOrders: 2,
      refundRequests: 1,
      medianWaitMinutes: 4,
      medianPrintMinutes: 3,
    });
    expect(Number(t.grossRevenue)).toBeCloseTo(a.total + b.total, 2);
    expect(Number(t.refundedAmount)).toBeCloseTo(b.total, 2);
    expect(Number(t.netRevenue)).toBeCloseTo(a.total, 2);
    expect(Number(t.averageOrderValue)).toBeCloseTo((a.total + b.total) / 2, 2);
    expect(t.refundRate).toBe(0.5);

    const day = analytics.daily.find((d: { date: string }) => d.date === expectedDay);
    expect(day.orders).toBe(1);
    expect(Number(day.revenue)).toBeCloseTo(a.total, 2);
    expect(analytics.hourly[10].orders).toBe(1);
    expect(analytics.hourly.reduce((sum: number, h: { orders: number }) => sum + h.orders, 0)).toBe(3);
  });

  it("does not mix in another shop's orders, revenue or refunds", async () => {
    const mine = await seedScenario('mine');
    const other = await seedScenario('other');

    const mineRes = await getShop(mine.staff.token, mine.shop.shopId, '?days=7');
    const otherRes = await getShop(other.staff.token, other.shop.shopId, '?days=7');
    expect(mineRes.body.data.analytics.totals.orders).toBe(3);
    expect(otherRes.body.data.analytics.totals.orders).toBe(3);
    expect(mineRes.body.data.analytics.shops.map((s: { shopId: string }) => s.shopId)).toEqual([mine.shop.shopId]);
  });

  it('is empty (not an error) for a shop with no activity', async () => {
    const shop = await createShop('quiet');
    const staff = await createUser('staff-quiet', 'SHOP_STAFF', shop.shopId);
    const res = await getShop(staff.token, shop.shopId, '?days=30');
    expect(res.status).toBe(200);
    expect(res.body.data.analytics.totals).toMatchObject({
      orders: 0,
      grossRevenue: '0.00',
      netRevenue: '0.00',
      averageOrderValue: null,
      refundRate: null,
      medianWaitMinutes: null,
      medianPrintMinutes: null,
    });
  });

  it('refuses staff from another shop, students, and anonymous callers', async () => {
    const { shop } = await seedScenario('guarded');
    const otherShop = await createShop('guarded-other');
    const outsider = await createUser('outsider', 'SHOP_STAFF', otherShop.shopId);
    const student = await registerStudent('guarded-student');

    expect((await getShop(outsider.token, shop.shopId)).status).toBe(403);
    expect((await getShop(student.token, shop.shopId)).status).toBe(403);
    expect((await request(app).get(`/api/shops/${shop.shopId}/analytics`)).status).toBe(401);
  });

  it('refuses a deactivated staff account, because access is re-read from the database', async () => {
    const shop = await createShop('inactive');
    const staff = await createUser('staff-inactive', 'SHOP_STAFF', shop.shopId);
    expect((await getShop(staff.token, shop.shopId)).status).toBe(200);
    await prisma.user.update({ where: { userId: staff.userId }, data: { status: 'INACTIVE' } });
    // The auth middleware re-reads the user on every request and rejects an
    // INACTIVE account with 401 before any shop-access check runs.
    expect((await getShop(staff.token, shop.shopId)).status).toBe(401);
  });

  it('lets an admin view any single shop, and rejects a bad range or unknown shop', async () => {
    const { shop } = await seedScenario('admin-view');
    const ok = await getShop(admin.token, shop.shopId, '?days=7');
    expect(ok.status).toBe(200);
    expect(ok.body.data.analytics.scope.type).toBe('shop');
    expect((await getShop(admin.token, shop.shopId, '?days=14')).status).toBe(400);
    expect((await getShop(admin.token, 'not-a-real-shop')).status).toBe(404);
  });

  it('keeps the all-shops endpoint closed to shop staff', async () => {
    const shop = await createShop('allshops-denied');
    const staff = await createUser('staff-allshops', 'SHOP_STAFF', shop.shopId);
    expect((await get(staff.token)).status).toBe(403);
  });
});
