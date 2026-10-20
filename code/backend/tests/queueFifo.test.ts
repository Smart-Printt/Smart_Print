import crypto from 'node:crypto';

import request from 'supertest';

import { prisma } from '../src/config/prisma';
import * as orderLocks from '../src/services/orderLocks';
import { countLockWaiters, deferred, eventually, withTimeout } from './helpers/concurrency';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// FIFO means "the order in which queue entries were serialized under the
// shop lock". queueNumber is allocated (max + 1) under that same lock, so it
// is the canonical order; enteredAt is an application-clock reading with
// millisecond resolution that can tie or even step backwards, so it must never
// override it. start-next, the queue listing and position must all agree.

jest.setTimeout(90_000);

const fx = createRaceFixtures('fifotest.');
const STEP_MS = 15_000;

let admin: TestUser;

beforeAll(async () => {
  admin = await fx.createAdmin('admin');
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

function randomHex(length: number): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

async function entry(orderId: string) {
  return prisma.queue.findUniqueOrThrow({ where: { orderId } });
}

async function listedOrderIds(shopId: string): Promise<string[]> {
  const res = await request(fx.app)
    .get(`/api/shops/${shopId}/queue`)
    .set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  return res.body.data.queue.map((q: { orderId: string }) => q.orderId);
}

async function positionOf(student: TestUser, orderId: string): Promise<number | null> {
  const res = await request(fx.app)
    .get(`/api/orders/${orderId}/queue-position`)
    .set('Authorization', `Bearer ${student.token}`);
  expect(res.status).toBe(200);
  return res.body.data.position;
}

describe('FIFO follows serialization under the shop lock', () => {
  it('a payment transaction that STARTED first but took the shop lock second is queued second', async () => {
    const studentA = await fx.registerStudent('contend-a');
    const studentB = await fx.registerStudent('contend-b');
    const shop = await fx.createShop('contend');

    const orderA = await fx.createOrder(studentA.token, shop);
    const orderB = await fx.createOrder(studentB.token, shop);
    expect((await fx.initiatePayment(studentA.token, orderA)).status).toBe(201);
    expect((await fx.initiatePayment(studentB.token, orderB)).status).toBe(201);

    // Hold A's payment transaction open - BEGIN has run, so its transaction
    // start time is early - but stop it just before it asks for the shop lock.
    const reachedLock = deferred<void>();
    const gate = deferred<void>();
    let gated = false;
    const originalLockShop = orderLocks.lockShop;
    jest.spyOn(orderLocks, 'lockShop').mockImplementation(async (tx, shopId) => {
      if (!gated) {
        gated = true;
        reachedLock.resolve();
        await gate.promise;
      }
      return originalLockShop(tx, shopId);
    });

    const confirmA = fx.fire(fx.confirmPaymentRequest(studentA.token, orderA));
    await withTimeout(reachedLock.promise, STEP_MS, 'A to open its transaction');
    // Prove A's transaction is really open (and therefore started earlier).
    await eventually(
      async () => {
        const rows = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction'`;
        return (rows[0]?.n ?? 0) >= 1;
      },
      "A's transaction to be open",
    );

    // B starts later, but takes the shop lock first and finishes.
    const confirmBRes = await withTimeout(
      fx.fire(fx.confirmPaymentRequest(studentB.token, orderB)),
      STEP_MS,
      'B to be queued',
    );
    expect(confirmBRes.status).toBe(200);

    gate.resolve();
    expect((await withTimeout(confirmA, STEP_MS, 'A to be queued')).status).toBe(200);

    const a = await entry(orderA);
    const b = await entry(orderB);
    expect(b.queueNumber).toBe(1);
    expect(a.queueNumber).toBe(2);
    // The stored timestamps must agree with the serialization order too.
    expect(b.enteredAt.getTime()).toBeLessThanOrEqual(a.enteredAt.getTime());

    expect(await listedOrderIds(shop.shopId)).toEqual([orderB, orderA]);
    expect(await positionOf(studentB, orderB)).toBe(1);
    expect(await positionOf(studentA, orderA)).toBe(2);

    const start = await fx.startNextRequest(admin.token, shop.shopId);
    expect(start.status).toBe(200);
    expect(start.body.data.queue.orderId).toBe(orderB);
  });

  it('two payments contending for the same held shop lock get distinct, consecutive queue numbers', async () => {
    const studentA = await fx.registerStudent('held-a');
    const studentB = await fx.registerStudent('held-b');
    const shop = await fx.createShop('held');
    const orderA = await fx.createOrder(studentA.token, shop);
    const orderB = await fx.createOrder(studentB.token, shop);
    expect((await fx.initiatePayment(studentA.token, orderA)).status).toBe(201);
    expect((await fx.initiatePayment(studentB.token, orderB)).status).toBe(201);

    const release = deferred<void>();
    const locked = deferred<void>();
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM print_shops WHERE shop_id = ${shop.shopId} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    await withTimeout(locked.promise, STEP_MS, 'test to hold the shop lock');

    try {
      const both = Promise.all([
        fx.fire(fx.confirmPaymentRequest(studentA.token, orderA)),
        fx.fire(fx.confirmPaymentRequest(studentB.token, orderB)),
      ]);
      await eventually(async () => (await countLockWaiters()) >= 2, 'both payments to wait on the shop lock', 10_000);
      release.resolve();
      await holder;
      const results = await withTimeout(both, STEP_MS, 'both payments');
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      release.resolve();
    }

    const numbers = [(await entry(orderA)).queueNumber, (await entry(orderB)).queueNumber].sort();
    expect(numbers).toEqual([1, 2]);
  });
});

describe('queueNumber, not the timestamp, decides the order', () => {
  it('an entry whose timestamp steps BACKWARDS still queues behind earlier-serialized entries', async () => {
    const students = [await fx.registerStudent('skew-1'), await fx.registerStudent('skew-2'), await fx.registerStudent('skew-3')];
    const shop = await fx.createShop('skew');
    const orders: string[] = [];
    for (const student of students) {
      orders.push(await fx.createQueuedOrder(student.token, shop));
    }
    const [first, second, third] = orders as [string, string, string];

    // Simulate a clock that stepped back when the second entry was written.
    await prisma.$executeRawUnsafe(
      `UPDATE queue SET entered_at = entered_at - interval '1 hour' WHERE order_id = '${second}'`,
    );

    expect(await listedOrderIds(shop.shopId)).toEqual([first, second, third]);
    expect(await positionOf(students[0]!, first)).toBe(1);
    expect(await positionOf(students[1]!, second)).toBe(2);
    expect(await positionOf(students[2]!, third)).toBe(3);

    const next = await request(fx.app)
      .get(`/api/shops/${shop.shopId}/queue/next`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(next.body.data.next.orderId).toBe(first);

    const start = await fx.startNextRequest(admin.token, shop.shopId);
    expect(start.status).toBe(200);
    expect(start.body.data.queue.orderId).toBe(first);
  });

  it('entries with IDENTICAL timestamps are ordered by queueNumber, not by their random ids', async () => {
    const students = [await fx.registerStudent('tie-1'), await fx.registerStudent('tie-2')];
    const shop = await fx.createShop('tie');
    const earlier = await fx.createQueuedOrder(students[0]!.token, shop);
    const later = await fx.createQueuedOrder(students[1]!.token, shop);

    // Same millisecond, and ids that sort the WRONG way round.
    await prisma.$executeRawUnsafe(
      `UPDATE queue SET entered_at = (SELECT entered_at FROM queue WHERE order_id = '${earlier}') WHERE order_id = '${later}'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE queue SET queue_id = 'ffffffff-ffff-4fff-8fff-${randomHex(12)}' WHERE order_id = '${earlier}'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE queue SET queue_id = '00000000-0000-4000-8000-${randomHex(12)}' WHERE order_id = '${later}'`,
    );

    expect(await listedOrderIds(shop.shopId)).toEqual([earlier, later]);
    expect(await positionOf(students[0]!, earlier)).toBe(1);
    expect(await positionOf(students[1]!, later)).toBe(2);

    const start = await fx.startNextRequest(admin.token, shop.shopId);
    expect(start.body.data.queue.orderId).toBe(earlier);
  });

  it('positions stay consistent with the listing as entries start, finish and cancel', async () => {
    const students = [
      await fx.registerStudent('pos-1'),
      await fx.registerStudent('pos-2'),
      await fx.registerStudent('pos-3'),
      await fx.registerStudent('pos-4'),
    ];
    const shop = await fx.createShop('pos');
    const orders: string[] = [];
    for (const student of students) {
      orders.push(await fx.createQueuedOrder(student.token, shop));
    }

    expect((await fx.cancelRequest(students[1]!.token, orders[1]!)).status).toBe(200);
    expect(await listedOrderIds(shop.shopId)).toEqual([orders[0], orders[2], orders[3]]);
    expect(await positionOf(students[2]!, orders[2]!)).toBe(2);

    const start = await fx.startNextRequest(admin.token, shop.shopId);
    expect(start.body.data.queue.orderId).toBe(orders[0]);
    expect(await listedOrderIds(shop.shopId)).toEqual([orders[2], orders[3]]);
    expect(await positionOf(students[2]!, orders[2]!)).toBe(1);
    expect(await positionOf(students[3]!, orders[3]!)).toBe(2);
  });
});
