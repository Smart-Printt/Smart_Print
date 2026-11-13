import { prisma } from '../src/config/prisma';
import {
  LockHolder,
  assertOrderQueueInvariants,
  holdLocks,
  pauseNextWrite,
  rowIsLockable,
  waitForLockWaiters,
  withTimeout,
} from './helpers/concurrency';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// Deterministic race tests. Each test pauses ONE operation after it has read
// its inputs but before it writes (see helpers/concurrency.ts), lets the
// competing operation finish, then releases the first one - so the harmful
// interleaving always happens, instead of depending on scheduler luck.

jest.setTimeout(90_000);

const fx = createRaceFixtures('racetest.');
const STEP_MS = 15_000;

let admin: TestUser;
const holders: LockHolder[] = [];

beforeAll(async () => {
  admin = await fx.createAdmin('admin');
});

afterEach(async () => {
  jest.restoreAllMocks();
  // Guaranteed cleanup: never leave a lock-holding transaction open.
  while (holders.length > 0) {
    await holders.pop()!.release().catch(() => undefined);
  }
});

afterAll(async () => {
  await fx.cleanup();
});

async function queueIdFor(orderId: string): Promise<string> {
  const queue = await prisma.queue.findUniqueOrThrow({ where: { orderId } });
  return queue.queueId;
}

async function historyCount(orderId: string, status: string): Promise<number> {
  return prisma.orderStatusHistory.count({
    where: { orderId, status: status as never },
  });
}

describe('order cancellation races', () => {
  it('cancel that read QUEUED must not cancel an order start-next has since moved to PRINTING', async () => {
    const student = await fx.registerStudent('cancel-vs-start');
    const shop = await fx.createShop('cancel-vs-start');
    const orderId = await fx.createQueuedOrder(student.token, shop);

    const pause = pauseNextWrite();
    const cancel = fx.fire(fx.cancelRequest(student.token, orderId));
    await withTimeout(pause.entered, STEP_MS, 'cancel to reach its write');
    pause.restore();

    const start = await fx.startNextRequest(admin.token, shop.shopId);
    expect(start.status).toBe(200);

    pause.release();
    const cancelRes = await withTimeout(cancel, STEP_MS, 'cancel response');
    expect(cancelRes.status).toBe(409);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { orderId } });
    expect(order.orderStatus).toBe('PRINTING');
    expect(queue.queueStatus).toBe('PRINTING');
    expect(await historyCount(orderId, 'CANCELLED')).toBe(0);
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('two cancels of the same order: exactly one wins and only one history row exists', async () => {
    const student = await fx.registerStudent('double-cancel');
    const shop = await fx.createShop('double-cancel');
    const orderId = await fx.createQueuedOrder(student.token, shop);

    const pause = pauseNextWrite();
    const first = fx.fire(fx.cancelRequest(student.token, orderId));
    await withTimeout(pause.entered, STEP_MS, 'first cancel to reach its write');
    pause.restore();

    const second = await fx.cancelRequest(student.token, orderId);
    expect(second.status).toBe(200);

    pause.release();
    const firstRes = await withTimeout(first, STEP_MS, 'first cancel response');
    expect(firstRes.status).toBe(409);

    expect(await historyCount(orderId, 'CANCELLED')).toBe(1);
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('cancelling a QUEUED order after a concurrent start-next loses cleanly; cancelling before it removes the order from the queue', async () => {
    const student = await fx.registerStudent('cancel-first');
    const shop = await fx.createShop('cancel-first');
    const orderId = await fx.createQueuedOrder(student.token, shop);

    const pause = pauseNextWrite();
    const start = fx.fire(fx.startNextRequest(admin.token, shop.shopId));
    await withTimeout(pause.entered, STEP_MS, 'start-next to reach its write');
    pause.restore();

    const cancelRes = await fx.cancelRequest(student.token, orderId);
    expect(cancelRes.status).toBe(200);

    pause.release();
    const startRes = await withTimeout(start, STEP_MS, 'start-next response');
    // Nothing valid is left waiting, so start-next must report that rather
    // than printing a cancelled order.
    expect(startRes.status).toBe(404);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
    expect(order.orderStatus).toBe('CANCELLED');
    expect(await prisma.queue.count({ where: { queueStatus: 'PRINTING', order: { shopId: shop.shopId } } })).toBe(0);
    await assertOrderQueueInvariants([shop.shopId]);
  });
});

describe('payment races', () => {
  it('payment confirmation that read PLACED must not queue an order cancelled in the meantime', async () => {
    const student = await fx.registerStudent('confirm-vs-cancel');
    const shop = await fx.createShop('confirm-vs-cancel');
    const orderId = await fx.createOrder(student.token, shop);
    expect((await fx.initiatePayment(student.token, orderId)).status).toBe(201);

    const pause = pauseNextWrite();
    const confirm = fx.fire(fx.confirmPaymentRequest(student.token, orderId));
    await withTimeout(pause.entered, STEP_MS, 'confirm to reach its write');
    pause.restore();

    const cancelRes = await fx.cancelRequest(student.token, orderId);
    expect(cancelRes.status).toBe(200);

    pause.release();
    const confirmRes = await withTimeout(confirm, STEP_MS, 'confirm response');
    expect(confirmRes.status).toBe(409);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
    expect(order.orderStatus).toBe('CANCELLED');
    expect(await prisma.queue.count({ where: { orderId } })).toBe(0);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } });
    expect(payment.paymentStatus).not.toBe('SUCCESS');
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('starting a payment on an order cancelled in the meantime creates no payment', async () => {
    const student = await fx.registerStudent('initiate-vs-cancel');
    const shop = await fx.createShop('initiate-vs-cancel');
    const orderId = await fx.createOrder(student.token, shop);

    const pause = pauseNextWrite();
    const initiate = fx.fire(fx.initiatePayment(student.token, orderId));
    await withTimeout(pause.entered, STEP_MS, 'initiate to reach its write');
    pause.restore();

    expect((await fx.cancelRequest(student.token, orderId)).status).toBe(200);

    pause.release();
    const res = await withTimeout(initiate, STEP_MS, 'initiate response');
    expect(res.status).toBe(409);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
  });
});

describe('printing flow races', () => {
  it('two completions of the same printing order: one wins, one READY history row', async () => {
    const student = await fx.registerStudent('double-complete');
    const shop = await fx.createShop('double-complete');
    const orderId = await fx.createQueuedOrder(student.token, shop);
    expect((await fx.startNextRequest(admin.token, shop.shopId)).status).toBe(200);
    const queueId = await queueIdFor(orderId);

    const pause = pauseNextWrite();
    const first = fx.fire(fx.completeRequest(admin.token, shop.shopId, queueId));
    await withTimeout(pause.entered, STEP_MS, 'first completion to reach its write');
    pause.restore();

    expect((await fx.completeRequest(admin.token, shop.shopId, queueId)).status).toBe(200);

    pause.release();
    expect((await withTimeout(first, STEP_MS, 'first completion response')).status).toBe(409);
    expect(await historyCount(orderId, 'READY')).toBe(1);
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('two collections of the same READY order: one wins, one COLLECTED history row', async () => {
    const student = await fx.registerStudent('double-collect');
    const shop = await fx.createShop('double-collect');
    const orderId = await fx.createQueuedOrder(student.token, shop);
    expect((await fx.startNextRequest(admin.token, shop.shopId)).status).toBe(200);
    expect((await fx.completeRequest(admin.token, shop.shopId, await queueIdFor(orderId))).status).toBe(200);

    const pause = pauseNextWrite();
    const first = fx.fire(fx.collectRequest(admin.token, orderId));
    await withTimeout(pause.entered, STEP_MS, 'first collection to reach its write');
    pause.restore();

    expect((await fx.collectRequest(admin.token, orderId)).status).toBe(200);

    pause.release();
    expect((await withTimeout(first, STEP_MS, 'first collection response')).status).toBe(409);
    expect(await historyCount(orderId, 'COLLECTED')).toBe(1);
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('start-next skips an order that became ineligible at the head and prints the next valid one, in FIFO order', async () => {
    const student = await fx.registerStudent('skip-head');
    const shop = await fx.createShop('skip-head');
    const orderA = await fx.createQueuedOrder(student.token, shop);
    const orderB = await fx.createQueuedOrder(student.token, shop);
    const orderC = await fx.createQueuedOrder(student.token, shop);

    // Hold A's row, let start-next reach it (it is the FIFO head), then
    // commit a cancellation of A that - like a legacy/inconsistent row -
    // leaves A's queue entry WAITING. start-next must re-check A under its
    // own lock, skip it and print B.
    const holder = holdLocks(
      [`SELECT 1 FROM orders WHERE order_id = '${orderA}' FOR UPDATE`],
      [`UPDATE orders SET order_status = 'CANCELLED'::"OrderStatus", cancelled_at = now() WHERE order_id = '${orderA}'`],
    );
    holders.push(holder);
    await withTimeout(holder.acquired, STEP_MS, 'test to lock order A');

    const start = fx.fire(fx.startNextRequest(admin.token, shop.shopId));
    await waitForLockWaiters(1);
    await holder.release();

    const startRes = await withTimeout(start, STEP_MS, 'start-next response');
    expect(startRes.status).toBe(200);
    expect(startRes.body.data.queue.orderId).toBe(orderB);

    const a = await prisma.order.findUniqueOrThrow({ where: { orderId: orderA }, include: { queue: true } });
    expect(a.orderStatus).toBe('CANCELLED');
    expect(a.queue?.queueStatus).toBe('CANCELLED');

    // FIFO continues past the skipped order: B, then C - never A.
    expect((await fx.completeRequest(admin.token, shop.shopId, await queueIdFor(orderB))).status).toBe(200);
    const next = await fx.startNextRequest(admin.token, shop.shopId);
    expect(next.status).toBe(200);
    expect(next.body.data.queue.orderId).toBe(orderC);
    await assertOrderQueueInvariants([shop.shopId]);
  });
});

describe('lock ordering (shop -> order -> queue)', () => {
  it('every order-mutating operation waits on the shop lock BEFORE taking any order lock', async () => {
    const s1 = await fx.registerStudent('lockorder-1');
    const s2 = await fx.registerStudent('lockorder-2');
    const s3 = await fx.registerStudent('lockorder-3');
    const shop = await fx.createShop('lockorder');

    const orderZ = await fx.createQueuedOrder(s3.token, shop); // FIFO head
    const orderY = await fx.createQueuedOrder(s2.token, shop);
    const orderX = await fx.createOrder(s1.token, shop);
    expect((await fx.initiatePayment(s1.token, orderX)).status).toBe(201);

    const shopLock = holdLocks([`SELECT 1 FROM print_shops WHERE shop_id = '${shop.shopId}' FOR UPDATE`]);
    holders.push(shopLock);
    await withTimeout(shopLock.acquired, STEP_MS, 'test to lock the shop');

    const confirm = fx.fire(fx.confirmPaymentRequest(s1.token, orderX));
    const cancel = fx.fire(fx.cancelRequest(s2.token, orderY));
    const start = fx.fire(fx.startNextRequest(admin.token, shop.shopId));

    // All three must be parked on the shop lock...
    await waitForLockWaiters(3, 8_000);

    // ...and, because the shop is always locked first, none may already be
    // holding an order row (a holder here would be the lock-order inversion
    // that deadlocks against start-next).
    for (const id of [orderX, orderY, orderZ]) {
      expect(await rowIsLockable('orders', 'order_id', id)).toBe(true);
    }

    await shopLock.release();
    const results = await withTimeout(Promise.all([confirm, cancel, start]), STEP_MS, 'all three operations');
    for (const res of results) {
      expect(res.status).toBeLessThan(500);
    }
    await assertOrderQueueInvariants([shop.shopId]);
  });

  it('mixed concurrent cancel / start-next / complete rounds never deadlock or break invariants', async () => {
    const students = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => fx.registerStudent(`stress-${n}`)));
    const shop = await fx.createShop('stress');
    const orders: string[] = [];
    for (const student of students) {
      orders.push(await fx.createQueuedOrder(student.token, shop));
    }

    for (let round = 0; round < 3; round += 1) {
      const target = orders[round * 2 + 1]!;
      const owner = students[round * 2 + 1]!;
      const results = await withTimeout(
        Promise.all([
          fx.fire(fx.cancelRequest(owner.token, target)),
          fx.fire(fx.startNextRequest(admin.token, shop.shopId)),
          fx.fire(fx.startNextRequest(admin.token, shop.shopId)),
        ]),
        STEP_MS,
        `stress round ${round}`,
      );
      for (const res of results) {
        expect(res.status).toBeLessThan(500);
      }
      const printing = await prisma.queue.findFirst({
        where: { queueStatus: 'PRINTING', order: { shopId: shop.shopId } },
      });
      if (printing) {
        expect((await fx.completeRequest(admin.token, shop.shopId, printing.queueId)).status).toBe(200);
      }
      await assertOrderQueueInvariants([shop.shopId]);
    }
  });
});
