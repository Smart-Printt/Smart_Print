import jwt from 'jsonwebtoken';
import request from 'supertest';

import { OrderStatus, PrintShop } from '@prisma/client';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'orderpagetest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${counter}`;
}

function signToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

async function createUser(label: string, role: 'STUDENT' | 'SHOP_STAFF' | 'ADMIN', shopId: string | null = null) {
  const user = await prisma.user.create({
    data: {
      name: `Page ${label}`,
      email: `${unique(label)}@${role === 'STUDENT' ? STUDENT_DOMAIN : 'gmail.com'}`,
      passwordHash: await hashPassword('CorrectHorse123'),
      role,
      status: 'ACTIVE',
      shopId,
    },
  });
  return { userId: user.userId, token: signToken(user.userId, role) };
}

const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = Date.parse('2026-06-15T12:00:00.000Z');

let seq = 0;
// Orders are inserted directly (no items needed: the list only reads the
// order row and its relations) so the test controls status and timestamps.
async function insertOrder(userId: string, shopId: string, status: OrderStatus, createdAt: Date, code?: string) {
  seq += 1;
  return prisma.order.create({
    data: {
      orderCode: code ?? `PG-${Date.now().toString(36).toUpperCase()}-${seq}`,
      userId,
      shopId,
      orderStatus: status,
      totalAmount: 10,
      createdAt,
      cancelledAt: status === 'CANCELLED' ? createdAt : null,
    },
  });
}

let shopA: PrintShop;
let shopB: PrintShop;
let student: { userId: string; token: string };
let otherStudent: { userId: string; token: string };
let admin: { userId: string; token: string };
let staffA: { userId: string; token: string };

// student has 25 orders in shop A, newest first = index 0 (one per day):
//   indexes 0-9 PLACED, 10-14 READY, 15-19 COLLECTED, 20-24 CANCELLED.
const studentOrders: { orderId: string; orderCode: string; status: OrderStatus; createdAt: Date }[] = [];

beforeAll(async () => {
  shopA = await prisma.printShop.create({
    data: { shopCode: unique('shop-a'), shopName: 'Page Shop A', location: 'A', contact: '9000000000' },
  });
  shopB = await prisma.printShop.create({
    data: { shopCode: unique('shop-b'), shopName: 'Page Shop B', location: 'B', contact: '9000000000' },
  });
  student = await createUser('student', 'STUDENT');
  otherStudent = await createUser('other', 'STUDENT');
  admin = await createUser('admin', 'ADMIN');
  staffA = await createUser('staff-a', 'SHOP_STAFF', shopA.shopId);

  const statuses: OrderStatus[] = [
    ...Array<OrderStatus>(10).fill('PLACED'),
    ...Array<OrderStatus>(5).fill('READY'),
    ...Array<OrderStatus>(5).fill('COLLECTED'),
    ...Array<OrderStatus>(5).fill('CANCELLED'),
  ];
  for (let index = 0; index < statuses.length; index += 1) {
    const createdAt = new Date(BASE_TIME - index * DAY);
    const order = await insertOrder(student.userId, shopA.shopId, statuses[index], createdAt, `PGT-${String(index).padStart(2, '0')}-X`);
    studentOrders.push({ orderId: order.orderId, orderCode: order.orderCode, status: statuses[index], createdAt });
  }
  // Someone else's orders, including one in shop B, must never leak in.
  await insertOrder(otherStudent.userId, shopA.shopId, 'PLACED', new Date(BASE_TIME + DAY), 'PGT-OTHER-A');
  await insertOrder(otherStudent.userId, shopB.shopId, 'PLACED', new Date(BASE_TIME + 2 * DAY), 'PGT-OTHER-B');
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { shopId: { in: [shopA.shopId, shopB.shopId] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: [shopA.shopId, shopB.shopId] } } });
  await prisma.$disconnect();
});

function list(token: string, query: Record<string, string> = {}) {
  return request(app).get('/api/orders').query(query).set('Authorization', `Bearer ${token}`);
}

function codes(res: request.Response): string[] {
  return res.body.data.orders.map((o: { orderCode: string }) => o.orderCode);
}

describe('GET /api/orders pagination', () => {
  it('returns the first 20 orders newest-first and the totals by default', async () => {
    const res = await list(student.token);
    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 });
    expect(codes(res)).toEqual(studentOrders.slice(0, 20).map((o) => o.orderCode));
  });

  it('returns the rest on page 2', async () => {
    const res = await list(student.token, { page: '2' });
    expect(codes(res)).toEqual(studentOrders.slice(20).map((o) => o.orderCode));
    expect(res.body.data.pagination.page).toBe(2);
  });

  it('honours limit, and pages do not overlap or skip', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await list(student.token, { page: String(page), limit: '10' });
      expect(res.body.data.pagination.totalPages).toBe(3);
      seen.push(...codes(res));
    }
    expect(seen).toEqual(studentOrders.map((o) => o.orderCode));
  });

  it('returns an empty page, not an error, beyond the last page', async () => {
    const res = await list(student.token, { page: '9' });
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
    expect(res.body.data.pagination.total).toBe(25);
  });

  it('keeps pages stable when several orders share a timestamp', async () => {
    const tie = new Date(BASE_TIME - 400 * DAY);
    const tieUser = await createUser('tie', 'STUDENT');
    for (let i = 0; i < 5; i += 1) {
      await insertOrder(tieUser.userId, shopA.shopId, 'PLACED', tie);
    }
    const first = await list(tieUser.token, { limit: '2', page: '1' });
    const second = await list(tieUser.token, { limit: '2', page: '2' });
    const third = await list(tieUser.token, { limit: '2', page: '3' });
    const all = [...codes(first), ...codes(second), ...codes(third)];
    expect(new Set(all).size).toBe(5);
  });

  it.each([
    ['page 0', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a non-numeric page', { page: 'abc' }],
    ['limit 0', { limit: '0' }],
    ['limit over the maximum', { limit: '101' }],
    ['a huge page', { page: '99999999' }],
    ['an unknown status', { status: 'SHIPPED' }],
    ['a bad date', { from: 'yesterday-ish' }],
    ['from after to', { from: '2026-02-01', to: '2026-01-01' }],
    ['a malformed shopId', { shopId: 'not-a-uuid' }],
    ['an over-long search', { q: 'x'.repeat(41) }],
  ])('rejects %s with 400', async (_label, query) => {
    const res = await list(student.token, query);
    expect(res.status).toBe(400);
  });

  it('rejects a repeated parameter', async () => {
    const res = await request(app).get('/api/orders?page=1&page=2').set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/orders')).status).toBe(401);
  });
});

describe('GET /api/orders filtering', () => {
  it('filters by one status', async () => {
    const res = await list(student.token, { status: 'READY' });
    expect(res.body.data.pagination.total).toBe(5);
    expect(codes(res)).toEqual(studentOrders.filter((o) => o.status === 'READY').map((o) => o.orderCode));
  });

  it('filters by several statuses at once', async () => {
    const res = await list(student.token, { status: 'COLLECTED,CANCELLED' });
    expect(res.body.data.pagination.total).toBe(10);
    expect(res.body.data.orders.every((o: { orderStatus: string }) => ['COLLECTED', 'CANCELLED'].includes(o.orderStatus))).toBe(true);
  });

  it('filters by a date range (inclusive)', async () => {
    const from = studentOrders[4].createdAt.toISOString();
    const to = studentOrders[2].createdAt.toISOString();
    const res = await list(student.token, { from, to });
    expect(codes(res)).toEqual(studentOrders.slice(2, 5).map((o) => o.orderCode));
  });

  it('searches the order code, ignoring case', async () => {
    const res = await list(student.token, { q: 'pgt-07' });
    expect(codes(res)).toEqual(['PGT-07-X']);
  });

  it('treats % and _ in the search as plain characters', async () => {
    const res = await list(student.token, { q: '%' });
    expect(res.body.data.orders).toEqual([]);
  });

  it('combines filters and still paginates the filtered set', async () => {
    const res = await list(student.token, { status: 'PLACED', limit: '4', page: '3' });
    expect(res.body.data.pagination).toEqual({ page: 3, limit: 4, total: 10, totalPages: 3 });
    expect(res.body.data.orders).toHaveLength(2);
  });
});

describe('GET /api/orders access scope', () => {
  it('a student never sees another user\'s orders, even when filtering by their shop', async () => {
    const res = await list(student.token, { shopId: shopA.shopId, limit: '100' });
    expect(res.body.data.pagination.total).toBe(25);
    expect(codes(res)).not.toContain('PGT-OTHER-A');
    expect((await list(student.token, { shopId: shopB.shopId })).body.data.orders).toEqual([]);
  });

  it('a student cannot widen the scope with the q filter', async () => {
    const res = await list(student.token, { q: 'PGT-OTHER' });
    expect(res.body.data.orders).toEqual([]);
  });

  it('shop staff only see their own shop, and a different shopId filter returns nothing', async () => {
    const own = await list(staffA.token, { limit: '100' });
    expect(codes(own)).toContain('PGT-OTHER-A');
    expect(codes(own)).not.toContain('PGT-OTHER-B');

    const other = await list(staffA.token, { shopId: shopB.shopId });
    expect(other.status).toBe(200);
    expect(other.body.data.orders).toEqual([]);
    expect(other.body.data.pagination.total).toBe(0);
  });

  it('an admin sees every shop and can narrow by shop', async () => {
    const all = await list(admin.token, { q: 'PGT-OTHER' });
    expect(codes(all).sort()).toEqual(['PGT-OTHER-A', 'PGT-OTHER-B']);

    const onlyB = await list(admin.token, { shopId: shopB.shopId });
    expect(codes(onlyB)).toEqual(['PGT-OTHER-B']);
  });

  it('shop staff with no shop assigned get an empty page', async () => {
    const noShop = await createUser('no-shop', 'SHOP_STAFF', null);
    const res = await list(noShop.token);
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
  });
});

describe('GET /api/orders/summary', () => {
  it('is admin only', async () => {
    expect((await request(app).get('/api/orders/summary').query({ from: '2026-01-01' })).status).toBe(401);
    const asStudent = await request(app)
      .get('/api/orders/summary')
      .query({ from: '2026-01-01' })
      .set('Authorization', `Bearer ${student.token}`);
    expect(asStudent.status).toBe(403);
  });

  it('requires a valid from date', async () => {
    const missing = await request(app).get('/api/orders/summary').set('Authorization', `Bearer ${admin.token}`);
    expect(missing.status).toBe(400);
    const bad = await request(app)
      .get('/api/orders/summary')
      .query({ from: 'nope' })
      .set('Authorization', `Bearer ${admin.token}`);
    expect(bad.status).toBe(400);
  });

  it('counts orders since the date and sums revenue, ignoring cancelled and unpaid orders', async () => {
    // Far in the future, so orders made by other test files (dated "now")
    // are not counted.
    const from = new Date('2100-01-01T00:00:00.000Z');
    const user = await createUser('summary', 'STUDENT');
    await insertOrder(user.userId, shopA.shopId, 'PLACED', new Date(from.getTime() + 1000));
    await insertOrder(user.userId, shopA.shopId, 'READY', new Date(from.getTime() + 2000));
    await insertOrder(user.userId, shopA.shopId, 'COLLECTED', new Date(from.getTime() + 3000));
    await insertOrder(user.userId, shopA.shopId, 'CANCELLED', new Date(from.getTime() + 4000));
    await insertOrder(user.userId, shopA.shopId, 'READY', new Date(from.getTime() - 1000));

    const res = await request(app)
      .get('/api/orders/summary')
      .query({ from: from.toISOString() })
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.orderCount).toBe(4);
    // Two paid orders (READY + COLLECTED) at 10 each.
    expect(Number(res.body.data.revenue)).toBe(20);
  });
});
