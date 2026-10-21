import crypto from 'node:crypto';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashCreateOrderRequest, parseIdempotencyKey } from '../src/utils/idempotency';
import { hashPassword } from '../src/utils/password';
import { pauseNextWrite, withTimeout } from './helpers/concurrency';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

jest.setTimeout(90_000);

const fx = createRaceFixtures('idemtest.');
const STEP_MS = 15_000;

// The one free-printing shop is identified by this exact shopCode (see
// shop.service.ts::isFreeFacultyShop), so it is looked up/created, never
// duplicated.
const CSE_FACULTY_SHOP_CODE = 'CSE_FACULTY';

let student: TestUser;
let shop: PrintShop;
let documentId: string;

beforeAll(async () => {
  student = await fx.registerStudent('student');
  shop = await fx.createShop('shop');
  documentId = await fx.uploadDocument(student.token);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

function newKey(): string {
  return crypto.randomUUID();
}

function body(overrides: Record<string, unknown> = {}, shopId = shop.shopId, docId = documentId) {
  return {
    shopId,
    items: [
      { documentId: docId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', ...overrides },
    ],
  };
}

function post(token: string, payload: unknown, key?: string | string[]) {
  const req = request(fx.app).post('/api/orders').set('Authorization', `Bearer ${token}`);
  if (key !== undefined) {
    req.set('Idempotency-Key', key as string);
  }
  return req.send(payload as object);
}

async function ordersWithKey(userId: string, key: string) {
  return prisma.order.findMany({ where: { userId, idempotencyKey: key } });
}

describe('POST /api/orders with an Idempotency-Key', () => {
  it('without a key every call still creates a new order', async () => {
    const first = await post(student.token, body());
    const second = await post(student.token, body());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.order.orderId).not.toBe(first.body.data.order.orderId);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const row = await prisma.order.findUniqueOrThrow({ where: { orderId: first.body.data.order.orderId } });
    expect(row.idempotencyKey).toBeNull();
    expect(row.idempotencyRequestHash).toBeNull();
  });

  it('creates the order once and replays it for a repeated request', async () => {
    const key = newKey();
    const first = await post(student.token, body(), key);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const second = await post(student.token, body(), key);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.orderId).toBe(first.body.data.order.orderId);
    expect(second.body.data.order.orderCode).toBe(first.body.data.order.orderCode);

    expect(await ordersWithKey(student.userId, key)).toHaveLength(1);
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: first.body.data.order.orderId } }),
    ).toBe(1);
  });

  it('treats the same request with differently ordered JSON properties as the same request', async () => {
    const key = newKey();
    const first = await post(student.token, body(), key);
    expect(first.status).toBe(201);

    const reordered = {
      items: [{ sides: 'SINGLE', paperSize: 'A4', printType: 'BW', copies: 1, documentId }],
      shopId: shop.shopId,
    };
    const second = await post(student.token, reordered, key);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.orderId).toBe(first.body.data.order.orderId);
  });

  it('treats cosmetic differences the server ignores (padding, empty vs absent optionals) as the same request', async () => {
    const key = newKey();
    const first = await post(student.token, body({ specialInstructions: 'staple it' }), key);
    expect(first.status).toBe(201);

    const second = await post(
      student.token,
      body({ specialInstructions: '  staple it  ', pageRange: '', finishingRuleId: '' }),
      key,
    );
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.orderId).toBe(first.body.data.order.orderId);
  });

  it('rejects the same key with a different request (409) and creates nothing new', async () => {
    const key = newKey();
    const first = await post(student.token, body({ copies: 1 }), key);
    expect(first.status).toBe(201);

    const different = await post(student.token, body({ copies: 2 }), key);
    expect(different.status).toBe(409);
    expect(different.body.success).toBe(false);
    expect(await ordersWithKey(student.userId, key)).toHaveLength(1);
  });

  it('scopes keys to the user: another user reusing the key gets their own order', async () => {
    const other = await fx.registerStudent('other');
    const otherDoc = await fx.uploadDocument(other.token);
    const key = newKey();

    const mine = await post(student.token, body(), key);
    const theirs = await post(other.token, body({}, shop.shopId, otherDoc), key);
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(theirs.body.data.order.orderId).not.toBe(mine.body.data.order.orderId);
    // ...and never leaks the other user's order.
    expect(theirs.body.data.order.customerEmail).not.toBe(mine.body.data.order.customerEmail);
  });

  it('does not burn the key on a rejected attempt', async () => {
    const key = newKey();
    const bad = await post(student.token, body({ copies: 0 }), key);
    expect(bad.status).toBe(400);
    expect(await ordersWithKey(student.userId, key)).toHaveLength(0);

    const good = await post(student.token, body({ copies: 1 }), key);
    expect(good.status).toBe(201);
    expect(good.headers['idempotent-replayed']).toBeUndefined();
  });

  it('replays the order in its current state, and even after the shop stops accepting orders', async () => {
    const ownShop = await fx.createShop('state');
    const key = newKey();
    const first = await post(student.token, body({}, ownShop.shopId), key);
    expect(first.status).toBe(201);
    const orderId = first.body.data.order.orderId;

    expect((await fx.cancelRequest(student.token, orderId)).status).toBe(200);
    await prisma.printShop.update({ where: { shopId: ownShop.shopId }, data: { acceptingOrders: false } });

    const replay = await post(student.token, body({}, ownShop.shopId), key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.order.orderId).toBe(orderId);
    expect(replay.body.data.order.orderStatus).toBe('CANCELLED');

    // A brand-new request (new key) is still refused.
    const fresh = await post(student.token, body({}, ownShop.shopId), newKey());
    expect(fresh.status).toBeGreaterThanOrEqual(400);
  });

  it('a replay of a paid order does not start another payment or queue entry', async () => {
    const ownShop = await fx.createShop('paid');
    const key = newKey();
    const first = await post(student.token, body({}, ownShop.shopId), key);
    const orderId = first.body.data.order.orderId;
    expect((await fx.initiatePayment(student.token, orderId)).status).toBe(201);
    expect((await fx.confirmPaymentRequest(student.token, orderId)).status).toBe(200);

    const replay = await post(student.token, body({}, ownShop.shopId), key);
    expect(replay.status).toBe(201);
    expect(replay.body.data.order.orderStatus).toBe('QUEUED');
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(await prisma.queue.count({ where: { orderId } })).toBe(1);
  });
});

describe('Idempotency-Key header validation', () => {
  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['contains spaces', 'has some spaces here'],
    ['contains a comma (repeated header)', 'abcdefgh, abcdefgh'],
    ['contains a slash', 'abcd/efgh1234'],
    ['empty', ''],
  ])('rejects a key that is %s with 400 and creates no order', async (_label, key) => {
    const before = await prisma.order.count({ where: { userId: student.userId } });
    const res = await post(student.token, body(), key);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key/);
    expect(await prisma.order.count({ where: { userId: student.userId } })).toBe(before);
  });

  it('accepts a UUID and the longest allowed key', async () => {
    expect((await post(student.token, body(), newKey())).status).toBe(201);
    expect((await post(student.token, body(), 'k'.repeat(128))).status).toBe(201);
  });

  it('parseIdempotencyKey treats a missing header as "no key"', () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });

  it('is still authenticated first', async () => {
    const res = await request(fx.app).post('/api/orders').set('Idempotency-Key', newKey()).send(body());
    expect(res.status).toBe(401);
  });
});

describe('request hashing', () => {
  const item = { documentId: 'd', copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' };

  it('is stable across property order and ignores undefined vs null', () => {
    const a = hashCreateOrderRequest('s', [{ ...item, pageRange: undefined }]);
    const b = hashCreateOrderRequest('s', [
      { sides: 'SINGLE', paperSize: 'A4', printType: 'BW', copies: 1, documentId: 'd', pageRange: null },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything that affects the order changes', () => {
    const base = hashCreateOrderRequest('s', [item]);
    expect(hashCreateOrderRequest('s2', [item])).not.toBe(base);
    expect(hashCreateOrderRequest('s', [{ ...item, copies: 2 }])).not.toBe(base);
    expect(hashCreateOrderRequest('s', [{ ...item, pageRange: '1-2' }])).not.toBe(base);
    expect(hashCreateOrderRequest('s', [{ ...item, specialInstructions: 'x' }])).not.toBe(base);
    expect(hashCreateOrderRequest('s', [item, item])).not.toBe(base);
    expect(
      hashCreateOrderRequest('s', [item, { ...item, copies: 2 }]),
    ).not.toBe(hashCreateOrderRequest('s', [{ ...item, copies: 2 }, item]));
  });

  it('normalizes optional text exactly as the server does (absent, null, empty, whitespace, padding)', () => {
    const base = hashCreateOrderRequest('s', [item]);
    expect(hashCreateOrderRequest('s', [{ ...item, pageRange: '', specialInstructions: '  ', finishingRuleId: '' }])).toBe(base);
    expect(hashCreateOrderRequest('s', [{ ...item, pageRange: null, specialInstructions: null, finishingRuleId: null }])).toBe(base);
    expect(hashCreateOrderRequest('s', [{ ...item, pageRange: ' 1-2 ' }])).toBe(
      hashCreateOrderRequest('s', [{ ...item, pageRange: '1-2' }]),
    );
    expect(hashCreateOrderRequest('s', [{ ...item, specialInstructions: ' hi ' }])).toBe(
      hashCreateOrderRequest('s', [{ ...item, specialInstructions: 'hi' }]),
    );
    expect(hashCreateOrderRequest('s', [{ ...item, finishingRuleId: 'f1' }])).not.toBe(base);
  });

  it('ignores properties the server never reads', () => {
    expect(hashCreateOrderRequest('s', [{ ...item, totalAmount: 1 }])).toBe(
      hashCreateOrderRequest('s', [{ ...item, totalAmount: 999 }]),
    );
  });
});

describe('concurrent duplicates', () => {
  it('five simultaneous identical requests create exactly one order', async () => {
    const ownShop = await fx.createShop('burst');
    const key = newKey();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fx.fire(post(student.token, body({}, ownShop.shopId), key))),
    );

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const orderIds = new Set(responses.map((r) => r.body.data.order.orderId));
    expect(orderIds.size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === undefined)).toHaveLength(1);
    expect(await ordersWithKey(student.userId, key)).toHaveLength(1);
  });

  it('a request that already passed its lookup, then loses the insert race, returns the winner’s order', async () => {
    const ownShop = await fx.createShop('race');
    const key = newKey();

    // A reads "no order for this key" and is held just before opening its
    // transaction; B runs to completion with the same key; then A resumes and
    // hits the unique index.
    const pause = pauseNextWrite();
    const a = fx.fire(post(student.token, body({}, ownShop.shopId), key));
    await withTimeout(pause.entered, STEP_MS, 'A to reach its transaction');
    pause.restore();

    const b = await post(student.token, body({}, ownShop.shopId), key);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();

    pause.release();
    const aRes = await withTimeout(a, STEP_MS, 'A to finish');
    expect(aRes.status).toBe(201);
    expect(aRes.headers['idempotent-replayed']).toBe('true');
    expect(aRes.body.data.order.orderId).toBe(b.body.data.order.orderId);
    expect(await ordersWithKey(student.userId, key)).toHaveLength(1);
  });

  it('the losing request gets 409, not a replay, when its body differs', async () => {
    const ownShop = await fx.createShop('race-diff');
    const key = newKey();

    const pause = pauseNextWrite();
    const a = fx.fire(post(student.token, body({ copies: 2 }, ownShop.shopId), key));
    await withTimeout(pause.entered, STEP_MS, 'A to reach its transaction');
    pause.restore();

    const b = await post(student.token, body({ copies: 1 }, ownShop.shopId), key);
    expect(b.status).toBe(201);

    pause.release();
    const aRes = await withTimeout(a, STEP_MS, 'A to finish');
    expect(aRes.status).toBe(409);
    expect(await ordersWithKey(student.userId, key)).toHaveLength(1);
  });
});

describe('free faculty orders', () => {
  let faculty: TestUser;
  let facultyShop: PrintShop;
  let facultyRuleId: string;
  let facultyDocId: string;
  const createdFacultyShop = { value: false };

  beforeAll(async () => {
    const email = `idemtest.faculty.${Date.now()}@gmail.com`;
    const user = await prisma.user.create({
      data: {
        name: 'Idempotency Faculty',
        email,
        passwordHash: await hashPassword('CorrectHorse123'),
        role: 'FACULTY',
        status: 'ACTIVE',
      },
    });
    faculty = {
      userId: user.userId,
      token: jwt.sign({ userId: user.userId, role: 'FACULTY' }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
      } as jwt.SignOptions),
    };

    const existing = await prisma.printShop.findUnique({ where: { shopCode: CSE_FACULTY_SHOP_CODE } });
    createdFacultyShop.value = !existing;
    facultyShop =
      existing ??
      (await prisma.printShop.create({
        data: {
          shopCode: CSE_FACULTY_SHOP_CODE,
          shopName: 'CSE Department Faculty Printer',
          location: 'CSE Department, Faculty Block',
          contact: '9222222222',
          isActive: true,
          acceptingOrders: true,
        },
      }));
    const rule = await prisma.shopPricingRule.create({
      data: {
        shopId: facultyShop.shopId,
        printType: 'COLOR',
        paperSize: 'LETTER',
        sides: 'DOUBLE',
        pricePerPage: 50,
        // Offset by the run's start time so a rule left by a crashed run cannot
        // collide on the (shop, type, size, sides, effectiveFrom) unique index.
        effectiveFrom: new Date(Date.UTC(2020, 0, 1) + (Date.now() % 86_400_000)),
      },
    });
    facultyRuleId = rule.pricingRuleId;
    facultyDocId = await fx.uploadDocument(faculty.token);
  });

  // The faculty user and their document share the file's email prefix, so the
  // shared fixture cleanup removes them (and the stored file) afterwards; this
  // only removes what that cleanup does not know about.
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: faculty.userId } });
    await prisma.shopPricingRule.delete({ where: { pricingRuleId: facultyRuleId } });
    if (createdFacultyShop.value) {
      await prisma.printShop.delete({ where: { shopId: facultyShop.shopId } });
    }
  });

  const facultyBody = () =>
    body({ printType: 'COLOR', paperSize: 'LETTER', sides: 'DOUBLE' }, facultyShop.shopId, facultyDocId);

  it('creates one QUEUED order and one queue entry, and replays it', async () => {
    const key = newKey();
    const first = await post(faculty.token, facultyBody(), key);
    expect(first.status).toBe(201);
    expect(first.body.data.order.orderStatus).toBe('QUEUED');
    expect(first.body.data.order.totalAmount).toBe('0');

    const second = await post(faculty.token, facultyBody(), key);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.orderId).toBe(first.body.data.order.orderId);

    expect(await prisma.queue.count({ where: { orderId: first.body.data.order.orderId } })).toBe(1);
    expect(await ordersWithKey(faculty.userId, key)).toHaveLength(1);
  });

  it('simultaneous duplicates yield one order and one queue number', async () => {
    const key = newKey();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => fx.fire(post(faculty.token, facultyBody(), key))),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const orderIds = new Set(responses.map((r) => r.body.data.order.orderId));
    expect(orderIds.size).toBe(1);

    const [orderId] = [...orderIds];
    expect(await ordersWithKey(faculty.userId, key)).toHaveLength(1);
    expect(await prisma.queue.count({ where: { orderId } })).toBe(1);
  });
});

describe('CORS', () => {
  const origin = 'https://app.example.edu';
  const app = createApp({ corsAllowedOrigins: [origin] });

  it('lets a browser send Idempotency-Key and read Idempotent-Replayed', async () => {
    const res = await request(app)
      .options('/api/orders')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization,idempotency-key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);

    const simple = await request(app).get('/health').set('Origin', origin);
    expect(simple.headers['access-control-expose-headers']).toMatch(/Idempotent-Replayed/i);
  });
});
