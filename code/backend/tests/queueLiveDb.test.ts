import fsSync from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

// End-to-end (real database, real HTTP): payment -> queue -> live stream ->
// printing -> READY -> QR pickup. Complements tests/queueLive.test.ts, which
// stubs the database.

const app = createApp();

const EMAIL_PREFIX = 'livedbtest.';
const SHOP_PREFIX = 'LIVEDBTEST-';
const PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

let counter = 0;
const unique = (label: string): string => `${label}.${Date.now()}.${(counter += 1)}`;

const createdShopIds: string[] = [];

async function registerStudent(label: string): Promise<{ userId: string; token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      name: `Live Test ${label}`,
      email: `${EMAIL_PREFIX}${unique(label)}@${env.allowedStudentEmailDomain}`,
      password: PASSWORD,
    });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

async function createUser(
  label: string,
  role: 'ADMIN' | 'SHOP_STAFF',
  shopId?: string,
): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Live Test ${label}`,
      email: `${EMAIL_PREFIX}${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      status: 'ACTIVE',
      shopId: shopId ?? null,
    },
  });
  const token = jwt.sign({ userId: user.userId, role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
  return { userId: user.userId, token };
}

async function createShop(label: string): Promise<PrintShop> {
  const shop = await prisma.printShop.create({
    data: {
      shopCode: `${SHOP_PREFIX}${unique(label)}`,
      shopName: `Live Test Shop ${label}`,
      location: 'Test Location',
      contact: '9000000000',
      isActive: true,
      acceptingOrders: true,
    },
  });
  createdShopIds.push(shop.shopId);
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

async function queuedOrder(token: string, shop: PrintShop): Promise<{ orderId: string; orderCode: string }> {
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
  const orderId = created.body.data.order.orderId as string;

  await request(app).post(`/api/orders/${orderId}/payment`).set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'UPI' });
  const confirmed = await request(app)
    .post(`/api/orders/${orderId}/payment/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ simulateOutcome: 'SUCCESS' });
  expect(confirmed.status).toBe(200);
  return { orderId, orderCode: created.body.data.order.orderCode as string };
}

let server: http.Server;
let port: number;
let admin: { userId: string; token: string };

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  admin = await createUser('admin', 'ADMIN');
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Delete by BOTH the shops this run created and any leftover rows owned by
  // this suite's users/shops (an earlier run that crashed mid-cleanup must not
  // block this one with a foreign-key error).
  const mine = { OR: [{ shopId: { in: createdShopIds } }, { user: { email: { startsWith: EMAIL_PREFIX } } }] };
  await prisma.queue.deleteMany({ where: { order: mine } });
  await prisma.refund.deleteMany({ where: { payment: { order: mine } } });
  await prisma.payment.deleteMany({ where: { order: mine } });
  await prisma.order.deleteMany({ where: mine });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  const leftoverShops = { OR: [{ shopId: { in: createdShopIds } }, { shopCode: { startsWith: SHOP_PREFIX } }] };
  await prisma.shopPricingRule.deleteMany({ where: { shop: leftoverShops } });
  await prisma.printShop.deleteMany({ where: leftoverShops });
  await prisma.$disconnect();
});

interface LiveStream {
  res: http.IncomingMessage;
  text: () => string;
  entries: () => {
    queueStatus: string;
    position: number | null;
    estimatedWaitMinutes: number | null;
    estimatedWaitRange: { low: number; high: number } | null;
    estimateBasis: { method: string; trainingOrders: number } | null;
    estimateStatus: string | null;
  }[];
  close: () => void;
}

function openStream(token: string, orderId: string): Promise<LiveStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: `/api/orders/${orderId}/queue/stream`, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
        });
        resolve({
          res,
          text: () => received,
          entries: () =>
            [...received.matchAll(/event: queue\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!)),
          close: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
  });
}

async function until(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const startNext = (shop: PrintShop) =>
  request(app).post(`/api/shops/${shop.shopId}/queue/start-next`).set('Authorization', `Bearer ${admin.token}`);

const complete = (shop: PrintShop, queueId: string) =>
  request(app).patch(`/api/shops/${shop.shopId}/queue/${queueId}/complete`).set('Authorization', `Bearer ${admin.token}`);

describe('live queue stream + wait estimate (real DB)', () => {
  it('pushes position and wait estimate as the shop works through the line, then ends', async () => {
    const shop = await createShop('stream');
    const s1 = await registerStudent('s1');
    const s2 = await registerStudent('s2');
    const s3 = await registerStudent('s3');
    const o1 = await queuedOrder(s1.token, shop);
    await queuedOrder(s2.token, shop);
    const o3 = await queuedOrder(s3.token, shop);

    const stream = await openStream(s3.token, o3.orderId);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toMatch(/text\/event-stream/);

    // Third in line, nothing printing yet, and this shop has no history: the
    // model starts from typical printer speeds ("0 orders learned") and
    // predicts a wait for the two orders in front, with a range around it.
    await until(() => stream.entries().length >= 1, 'initial frame');
    const first = stream.entries().at(-1)!;
    expect(first).toMatchObject({ queueStatus: 'WAITING', position: 3 });
    expect(first.estimatedWaitMinutes).toBeGreaterThan(0);
    expect(first.estimatedWaitRange!.low).toBeLessThanOrEqual(first.estimatedWaitMinutes!);
    expect(first.estimatedWaitRange!.high).toBeGreaterThanOrEqual(first.estimatedWaitMinutes!);
    expect(first.estimateBasis).toMatchObject({ method: 'bayesian-linear-regression', trainingOrders: 0 });
    expect(first.estimateStatus).toBe('normal');

    // Staff start the first order: it is now PRINTING, so its remaining time
    // is part of s3's wait. s3 moves up to position 2.
    const started = await startNext(shop);
    expect(started.status).toBe(200);
    await until(() => stream.entries().some((e) => e.position === 2), 'push after start-next');
    const afterStart = stream.entries().at(-1)!;
    expect(afterStart.position).toBe(2);
    expect(afterStart.estimatedWaitMinutes).toBeGreaterThan(0);

    // First order finishes -> the shop has its FIRST completed order, so the
    // model re-learns from real data (trainingOrders goes 0 -> 1) and s3
    // moves to position 2 with only one order ahead of it.
    const complete1 = await complete(shop, started.body.data.queue.queueId);
    expect(complete1.status).toBe(200);
    await until(() => stream.entries().at(-1)?.estimateBasis?.trainingOrders === 1, 'model re-trained on the completed order');
    const afterComplete = stream.entries().at(-1)!;
    expect(afterComplete).toMatchObject({ queueStatus: 'WAITING', position: 2 });
    expect(afterComplete.estimatedWaitMinutes!).toBeLessThanOrEqual(afterStart.estimatedWaitMinutes!);

    // Pickup of the finished order works from here (covered below too).
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId: o1.orderId } })).orderStatus).toBe('READY');

    // Cancelling the stream owner's own order closes the stream cleanly.
    const ended = new Promise<void>((resolve) => stream.res.on('end', resolve));
    const cancelled = await request(app)
      .patch(`/api/orders/${o3.orderId}/cancel`)
      .set('Authorization', `Bearer ${s3.token}`)
      .send({});
    expect(cancelled.status).toBe(200);
    await ended;
    expect(stream.entries().at(-1)).toMatchObject({ queueStatus: 'CANCELLED', position: null });
    expect(stream.text()).toContain('event: end');
  });

  it("does not let a student open another student's stream", async () => {
    const shop = await createShop('stream-acl');
    const owner = await registerStudent('owner');
    const intruder = await registerStudent('intruder');
    const { orderId } = await queuedOrder(owner.token, shop);

    const res = await request(app)
      .get(`/api/orders/${orderId}/queue/stream`)
      .set('Authorization', `Bearer ${intruder.token}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('a payment confirmed at the shop reaches an already-open stream of someone waiting there', async () => {
    const shop = await createShop('stream-new-order');
    const waiting = await registerStudent('waiting');
    const later = await registerStudent('later');
    const first = await queuedOrder(waiting.token, shop);

    const stream = await openStream(waiting.token, first.orderId);
    await until(() => stream.entries().length === 1, 'initial frame');

    await queuedOrder(later.token, shop); // someone else joins behind
    await until(() => stream.entries().length >= 2, 'push after another order joined');
    // The waiting student's own place does not change when someone joins behind.
    expect(stream.entries().at(-1)).toMatchObject({ position: 1 });
    stream.close();
  });
});

describe('QR pickup (real DB)', () => {
  it('staff can look up a READY order by scanned code, hand it over once, and not twice', async () => {
    const shop = await createShop('pickup');
    const staff = await createUser('staff', 'SHOP_STAFF', shop.shopId);
    const student = await registerStudent('picker');
    const { orderId, orderCode } = await queuedOrder(student.token, shop);

    // Not READY yet: lookup works, but handing over is refused.
    const early = await request(app).get(`/api/orders/by-code/${orderCode}`).set('Authorization', `Bearer ${staff.token}`);
    expect(early.status).toBe(200);
    expect(early.body.data.order).toMatchObject({ orderId, orderStatus: 'QUEUED' });
    const tooEarly = await request(app).patch(`/api/orders/${orderId}/collect`).set('Authorization', `Bearer ${staff.token}`);
    expect(tooEarly.status).toBe(409);

    const started = await startNext(shop);
    await complete(shop, started.body.data.queue.queueId);

    // Scanners/typing are sloppy: lowercase and padding must still resolve.
    const scanned = await request(app)
      .get(`/api/orders/by-code/${encodeURIComponent(`  ${orderCode.toLowerCase()} `)}`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(scanned.status).toBe(200);
    expect(scanned.body.data.order).toMatchObject({ orderId, orderStatus: 'READY' });

    const collected = await request(app).patch(`/api/orders/${orderId}/collect`).set('Authorization', `Bearer ${staff.token}`);
    expect(collected.status).toBe(200);
    const again = await request(app).patch(`/api/orders/${orderId}/collect`).set('Authorization', `Bearer ${staff.token}`);
    expect(again.status).toBe(409);

    const after = await request(app).get(`/api/orders/by-code/${orderCode}`).set('Authorization', `Bearer ${staff.token}`);
    expect(after.body.data.order.orderStatus).toBe('COLLECTED');
  });

  it("hides another shop's orders from staff, and is closed to students", async () => {
    const shopA = await createShop('pickup-a');
    const shopB = await createShop('pickup-b');
    const staffB = await createUser('staff-b', 'SHOP_STAFF', shopB.shopId);
    const student = await registerStudent('pickup-acl');
    const { orderCode } = await queuedOrder(student.token, shopA);

    const crossShop = await request(app).get(`/api/orders/by-code/${orderCode}`).set('Authorization', `Bearer ${staffB.token}`);
    expect(crossShop.status).toBe(404);
    const unknown = await request(app).get('/api/orders/by-code/SP-DOES-NOT-EXIST').set('Authorization', `Bearer ${staffB.token}`);
    expect(unknown.status).toBe(404);
    expect(crossShop.body.message).toBe(unknown.body.message);

    const asStudent = await request(app).get(`/api/orders/by-code/${orderCode}`).set('Authorization', `Bearer ${student.token}`);
    expect(asStudent.status).toBe(403);

    const asAdmin = await request(app).get(`/api/orders/by-code/${orderCode}`).set('Authorization', `Bearer ${admin.token}`);
    expect(asAdmin.status).toBe(200);
  });
});

describe('wait estimate safeguards (real DB)', () => {
  const queueOf = (token: string, orderId: string) =>
    request(app).get(`/api/orders/${orderId}/queue`).set('Authorization', `Bearer ${token}`);

  it('says "delayed" and shows no number when the order printing now is stuck far past its predicted time', async () => {
    const shop = await createShop('delayed');
    const s1 = await registerStudent('d1');
    const s2 = await registerStudent('d2');
    await queuedOrder(s1.token, shop);
    const o2 = await queuedOrder(s2.token, shop);

    const started = await startNext(shop);
    expect(started.status).toBe(200);

    // Healthy at first: a fresh print, a normal estimate for the student behind.
    const healthy = (await queueOf(s2.token, o2.orderId)).body.data.queue;
    expect(healthy.estimateStatus).toBe('normal');
    expect(healthy.estimatedWaitMinutes).toBeGreaterThan(0);

    // Now the printer jams: the print has been "running" for 3 hours.
    await prisma.queue.update({
      where: { queueId: started.body.data.queue.queueId },
      data: { startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });

    const stuck = (await queueOf(s2.token, o2.orderId)).body.data.queue;
    expect(stuck).toMatchObject({ estimateStatus: 'delayed', estimatedWaitMinutes: null, estimatedWaitRange: null });
    expect(stuck.position).toBe(1); // position is still real; only the guess is withheld
  });

  it('also tells the student whose own order is the stuck one', async () => {
    const shop = await createShop('delayed-own');
    const s1 = await registerStudent('own1');
    const o1 = await queuedOrder(s1.token, shop);
    const started = await startNext(shop);
    await prisma.queue.update({
      where: { queueId: started.body.data.queue.queueId },
      data: { startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const mine = (await queueOf(s1.token, o1.orderId)).body.data.queue;
    expect(mine).toMatchObject({ queueStatus: 'PRINTING', estimateStatus: 'delayed', estimatedWaitMinutes: null });
  });

  it('says "stalled" when orders are waiting but nothing has started for a long time', async () => {
    const shop = await createShop('stalled');
    const s1 = await registerStudent('st1');
    const o1 = await queuedOrder(s1.token, shop);

    expect((await queueOf(s1.token, o1.orderId)).body.data.queue.estimateStatus).toBe('normal');

    // Staff have not started anything for 40 minutes.
    await prisma.queue.updateMany({
      where: { orderId: o1.orderId },
      data: { enteredAt: new Date(Date.now() - 40 * 60 * 1000) },
    });
    const stalled = (await queueOf(s1.token, o1.orderId)).body.data.queue;
    expect(stalled).toMatchObject({ estimateStatus: 'stalled', estimatedWaitMinutes: null, estimatedWaitRange: null });
  });

  it('recovers by itself once the shop starts printing again', async () => {
    const shop = await createShop('recovers');
    const s1 = await registerStudent('rc1');
    const s2 = await registerStudent('rc2');
    const o1 = await queuedOrder(s1.token, shop);
    const o2 = await queuedOrder(s2.token, shop);
    await prisma.queue.updateMany({ where: { orderId: o1.orderId }, data: { enteredAt: new Date(Date.now() - 40 * 60 * 1000) } });
    expect((await queueOf(s2.token, o2.orderId)).body.data.queue.estimateStatus).toBe('stalled');

    expect((await startNext(shop)).status).toBe(200);
    const after = (await queueOf(s2.token, o2.orderId)).body.data.queue;
    expect(after.estimateStatus).toBe('normal');
    expect(after.estimatedWaitMinutes).toBeGreaterThan(0);
  });

  it('can be switched off completely with WAIT_ESTIMATES_ENABLED=false, for students and staff views', async () => {
    const shop = await createShop('disabled');
    const s1 = await registerStudent('off1');
    const o1 = await queuedOrder(s1.token, shop);

    process.env.WAIT_ESTIMATES_ENABLED = 'false';
    try {
      const student = (await queueOf(s1.token, o1.orderId)).body.data.queue;
      expect(student).toMatchObject({
        estimateStatus: 'disabled',
        estimatedWaitMinutes: null,
        estimatedWaitRange: null,
        estimateBasis: null,
        position: 1, // everything else keeps working
      });

      const list = await request(app).get(`/api/shops/${shop.shopId}/queue`).set('Authorization', `Bearer ${admin.token}`);
      expect(list.status).toBe(200);
      expect(list.body.data.queue[0]).toMatchObject({ estimateStatus: 'disabled', estimatedWaitMinutes: null });
    } finally {
      delete process.env.WAIT_ESTIMATES_ENABLED;
    }

    expect((await queueOf(s1.token, o1.orderId)).body.data.queue.estimateStatus).toBe('normal');
  });
});
