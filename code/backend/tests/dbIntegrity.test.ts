import { PrintShop } from '@prisma/client';

import { prisma } from '../src/config/prisma';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// These tests attack the database directly (raw SQL, bypassing every
// application check) to prove that PostgreSQL itself refuses each state the
// application is meant to prevent. Each expectation names the constraint, so a
// rejection by some other rule cannot make a test pass by accident.

jest.setTimeout(90_000);

const fx = createRaceFixtures('dbint.');

let admin: TestUser;
let student: TestUser;

beforeAll(async () => {
  admin = await fx.createAdmin('admin');
  student = await fx.registerStudent('student');
});

afterAll(async () => {
  await fx.cleanup();
});

// Resolves to the database's error text; fails the test if the write succeeds.
async function rejection(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    const meta = (err as { meta?: unknown }).meta;
    return `${(err as Error).message} ${JSON.stringify(meta ?? {})}`;
  }
  throw new Error('expected the database to reject this write, but it succeeded');
}

// PostgreSQL reports a unique violation by its key columns, not the index name
// (Prisma passes that text through, in either its raw or typed-client form), so
// uniqueness tests assert the columns plus SQLSTATE 23505/P2002. The index
// names themselves are pinned by the catalog test below.
function expectUniqueViolationOn(message: string, ...columns: string[]): void {
  const raw = `Key (${columns.join(', ')})=`;
  const typed = `fields: (${columns.map((c) => `\`${c}\``).join(',')})`;
  expect(message.includes(raw) || message.includes(typed)).toBe(true);
}

async function queuedOrder(shop: PrintShop, owner: TestUser = student): Promise<string> {
  return fx.createQueuedOrder(owner.token, shop);
}

async function entryFor(orderId: string) {
  return prisma.queue.findUniqueOrThrow({ where: { orderId } });
}

describe('catalog: the constraints Prisma cannot express exist under their documented names', () => {
  async function indexDefinition(name: string): Promise<string | undefined> {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`;
    return rows[0]?.indexdef;
  }

  it.each([
    ['queue_one_printing_per_shop', /UNIQUE INDEX .* ON public\.queue .*\(shop_id\) WHERE .*queue_status.*PRINTING/],
    ['payments_one_pending_per_order', /UNIQUE INDEX .* ON public\.payments .*\(order_id\) WHERE .*PENDING/],
    ['payments_one_success_per_order', /UNIQUE INDEX .* ON public\.payments .*\(order_id\) WHERE .*SUCCESS/],
    ['refunds_one_active_per_payment', /UNIQUE INDEX .* ON public\.refunds .*\(payment_id\) WHERE .*REQUESTED.*PROCESSED/],
  ])('partial unique index %s', async (name, pattern) => {
    expect(await indexDefinition(name)).toMatch(pattern);
  });

  it.each([
    'queue_number_positive',
    'queue_status_timestamps_consistent',
    'orders_total_amount_non_negative',
    'orders_cancelled_at_matches_status',
    'order_documents_copies_positive',
    'payments_paid_at_matches_status',
    'refunds_processed_at_matches_status',
    'shop_pricing_rules_effective_range',
  ])('check constraint %s', async (name) => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname = ${name}`;
    expect(rows).toHaveLength(1);
  });
});

describe('queue.shop_id', () => {
  it('is set from the order by the application', async () => {
    const shop = await fx.createShop('shopid');
    const orderId = await queuedOrder(shop);
    expect((await entryFor(orderId)).shopId).toBe(shop.shopId);
  });

  it('cannot name a shop other than the order’s shop', async () => {
    const shop = await fx.createShop('fk-a');
    const otherShop = await fx.createShop('fk-b');
    const orderId = await fx.createOrder(student.token, shop);

    const message = await rejection(
      prisma.$executeRaw`
        INSERT INTO queue (queue_id, order_id, shop_id, queue_number)
        VALUES (gen_random_uuid()::text, ${orderId}, ${otherShop.shopId}, 1)`,
    );
    expect(message).toContain('queue_order_id_shop_id_fkey');
  });

  it('cannot be NULL', async () => {
    const shop = await fx.createShop('notnull');
    const orderId = await fx.createOrder(student.token, shop);
    const message = await rejection(
      prisma.$executeRaw`
        INSERT INTO queue (queue_id, order_id, shop_id, queue_number)
        VALUES (gen_random_uuid()::text, ${orderId}, NULL, 1)`,
    );
    expect(message).toContain('23502'); // not_null_violation
  });

  it('prevents moving an order to another shop while it has a queue entry', async () => {
    const shop = await fx.createShop('move-a');
    const otherShop = await fx.createShop('move-b');
    const orderId = await queuedOrder(shop);

    const message = await rejection(
      prisma.$executeRaw`UPDATE orders SET shop_id = ${otherShop.shopId} WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_order_id_shop_id_fkey');
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).shopId).toBe(shop.shopId);
  });

  it('prevents pointing an existing entry at another shop', async () => {
    const shop = await fx.createShop('retarget-a');
    const otherShop = await fx.createShop('retarget-b');
    const orderId = await queuedOrder(shop);

    const message = await rejection(
      prisma.$executeRaw`UPDATE queue SET shop_id = ${otherShop.shopId} WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_order_id_shop_id_fkey');
  });

  it('is removed together with its order (ON DELETE CASCADE)', async () => {
    const shop = await fx.createShop('cascade');
    // No payment, so the order itself can be deleted (payments restrict it).
    const orderId = await fx.createOrder(student.token, shop);
    await prisma.queue.create({ data: { orderId, shopId: shop.shopId, queueNumber: 1 } });
    await prisma.order.delete({ where: { orderId } });
    expect(await prisma.queue.count({ where: { orderId } })).toBe(0);
  });
});

describe('queue numbers and one entry per order', () => {
  it('allocates 1, 2, 3 per shop independently of other shops', async () => {
    const shop = await fx.createShop('numbers-a');
    const otherShop = await fx.createShop('numbers-b');
    const a1 = await queuedOrder(shop);
    const a2 = await queuedOrder(shop);
    const b1 = await queuedOrder(otherShop);

    expect((await entryFor(a1)).queueNumber).toBe(1);
    expect((await entryFor(a2)).queueNumber).toBe(2);
    // The same number is fine in a different shop.
    expect((await entryFor(b1)).queueNumber).toBe(1);
  });

  it('rejects a duplicate queue number within a shop', async () => {
    const shop = await fx.createShop('dupnum');
    await queuedOrder(shop);
    const second = await queuedOrder(shop);

    const message = await rejection(
      prisma.$executeRaw`UPDATE queue SET queue_number = 1 WHERE order_id = ${second}`,
    );
    expectUniqueViolationOn(message, 'shop_id', 'queue_number');
  });

  it('keeps counting past a cancelled entry instead of reusing its number', async () => {
    const shop = await fx.createShop('cancelled-number');
    const first = await queuedOrder(shop);
    expect((await fx.cancelRequest(student.token, first)).status).toBe(200);
    const second = await queuedOrder(shop);
    expect((await entryFor(second)).queueNumber).toBe(2);
  });

  it('rejects a second queue entry for the same order', async () => {
    const shop = await fx.createShop('dup-entry');
    const orderId = await queuedOrder(shop);

    const message = await rejection(
      prisma.$executeRaw`
        INSERT INTO queue (queue_id, order_id, shop_id, queue_number)
        VALUES (gen_random_uuid()::text, ${orderId}, ${shop.shopId}, 99)`,
    );
    expectUniqueViolationOn(message, 'order_id');
  });

  it('rejects queue_number < 1', async () => {
    const shop = await fx.createShop('zero-number');
    const orderId = await queuedOrder(shop);
    const message = await rejection(
      prisma.$executeRaw`UPDATE queue SET queue_number = 0 WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_number_positive');
  });
});

describe('at most one PRINTING entry per shop', () => {
  it('rejects a second PRINTING entry in the same shop even when written directly', async () => {
    const shop = await fx.createShop('one-printing');
    const first = await queuedOrder(shop);
    const second = await queuedOrder(shop);

    const started = await fx.startNextRequest(admin.token, shop.shopId);
    expect(started.status).toBe(200);
    expect(started.body.data.queue.orderId).toBe(first);

    const message = await rejection(
      prisma.$executeRaw`
        UPDATE queue SET queue_status = 'PRINTING'::"QueueStatus", started_at = now()
        WHERE order_id = ${second}`,
    );
    expectUniqueViolationOn(message, 'shop_id');
    expect((await entryFor(second)).queueStatus).toBe('WAITING');
  });

  it('allows one PRINTING entry in each of two different shops', async () => {
    const shopA = await fx.createShop('printing-a');
    const shopB = await fx.createShop('printing-b');
    await queuedOrder(shopA);
    await queuedOrder(shopB);

    expect((await fx.startNextRequest(admin.token, shopA.shopId)).status).toBe(200);
    expect((await fx.startNextRequest(admin.token, shopB.shopId)).status).toBe(200);
  });

  it('allows the next entry to print once the previous one has completed', async () => {
    const shop = await fx.createShop('printing-after-complete');
    await queuedOrder(shop);
    const second = await queuedOrder(shop);

    const first = await fx.startNextRequest(admin.token, shop.shopId);
    expect(first.status).toBe(200);
    expect(
      (await fx.completeRequest(admin.token, shop.shopId, first.body.data.queue.queueId)).status,
    ).toBe(200);

    const next = await fx.startNextRequest(admin.token, shop.shopId);
    expect(next.status).toBe(200);
    expect(next.body.data.queue.orderId).toBe(second);
  });

  it('lets only one of two concurrent start-next calls through (409 for the other)', async () => {
    const shop = await fx.createShop('concurrent-start');
    await queuedOrder(shop);
    await queuedOrder(shop);

    const results = await Promise.all([
      fx.fire(fx.startNextRequest(admin.token, shop.shopId)),
      fx.fire(fx.startNextRequest(admin.token, shop.shopId)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await prisma.queue.count({ where: { shopId: shop.shopId, queueStatus: 'PRINTING' } }),
    ).toBe(1);
  });
});

describe('queue status and timestamps agree', () => {
  it('rejects PRINTING without started_at', async () => {
    const shop = await fx.createShop('ts-printing');
    const orderId = await queuedOrder(shop);
    const message = await rejection(
      prisma.$executeRaw`UPDATE queue SET queue_status = 'PRINTING'::"QueueStatus" WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_status_timestamps_consistent');
  });

  it('rejects COMPLETED without completed_at', async () => {
    const shop = await fx.createShop('ts-completed');
    const orderId = await queuedOrder(shop);
    const message = await rejection(
      prisma.$executeRaw`
        UPDATE queue SET queue_status = 'COMPLETED'::"QueueStatus", started_at = now()
        WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_status_timestamps_consistent');
  });

  it('rejects a WAITING entry that carries a completion time', async () => {
    const shop = await fx.createShop('ts-waiting');
    const orderId = await queuedOrder(shop);
    const message = await rejection(
      prisma.$executeRaw`UPDATE queue SET completed_at = now() WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('queue_status_timestamps_consistent');
  });

  it('is satisfied by every transition the application makes', async () => {
    const shop = await fx.createShop('ts-flow');
    await queuedOrder(shop);
    const cancelled = await queuedOrder(shop);
    expect((await fx.cancelRequest(student.token, cancelled)).status).toBe(200);

    const started = await fx.startNextRequest(admin.token, shop.shopId);
    expect(started.status).toBe(200);
    expect(
      (await fx.completeRequest(admin.token, shop.shopId, started.body.data.queue.queueId)).status,
    ).toBe(200);
  });
});

describe('payments and refunds', () => {
  async function paidOrder(shop: PrintShop) {
    const orderId = await queuedOrder(shop);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { orderId, paymentStatus: 'SUCCESS' },
    });
    return { orderId, payment };
  }

  it('rejects a second PENDING payment for an order', async () => {
    const shop = await fx.createShop('pay-pending');
    const orderId = await fx.createOrder(student.token, shop);
    expect((await fx.initiatePayment(student.token, orderId)).status).toBe(201);

    const message = await rejection(
      prisma.payment.create({
        data: { orderId, amount: 2, paymentMethod: 'UPI', transactionId: `dbint-${Date.now()}-p` },
      }),
    );
    expectUniqueViolationOn(message, 'order_id');
  });

  it('allows a new PENDING payment after the previous one FAILED', async () => {
    const shop = await fx.createShop('pay-retry');
    const orderId = await fx.createOrder(student.token, shop);
    expect((await fx.initiatePayment(student.token, orderId)).status).toBe(201);
    const failed = await fx.fire(
      fx.confirmPaymentRequest(student.token, orderId).send({ simulateOutcome: 'FAILED' }),
    );
    expect(failed.status).toBe(200);
    expect((await fx.initiatePayment(student.token, orderId)).status).toBe(201);
  });

  it('rejects a second SUCCESS payment for an order', async () => {
    const shop = await fx.createShop('pay-success');
    const { orderId } = await paidOrder(shop);

    const message = await rejection(
      prisma.payment.create({
        data: {
          orderId,
          amount: 2,
          paymentMethod: 'UPI',
          transactionId: `dbint-${Date.now()}-s`,
          paymentStatus: 'SUCCESS',
          paidAt: new Date(),
        },
      }),
    );
    expectUniqueViolationOn(message, 'order_id');
  });

  it('rejects paid_at that disagrees with the payment status', async () => {
    const shop = await fx.createShop('pay-paidat');
    const orderId = await fx.createOrder(student.token, shop);
    const message = await rejection(
      prisma.payment.create({
        data: {
          orderId,
          amount: 2,
          paymentMethod: 'UPI',
          transactionId: `dbint-${Date.now()}-t`,
          paymentStatus: 'SUCCESS',
        },
      }),
    );
    expect(message).toContain('payments_paid_at_matches_status');
  });

  it('rejects a negative payment amount', async () => {
    const shop = await fx.createShop('pay-negative');
    const orderId = await fx.createOrder(student.token, shop);
    const message = await rejection(
      prisma.payment.create({
        data: { orderId, amount: -1, paymentMethod: 'UPI', transactionId: `dbint-${Date.now()}-n` },
      }),
    );
    expect(message).toContain('payments_amount_non_negative');
  });

  it('rejects a second active refund, but allows another after a FAILED one', async () => {
    const shop = await fx.createShop('refund');
    const { orderId, payment } = await paidOrder(shop);
    expect((await fx.cancelRequest(student.token, orderId)).status).toBe(200);

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.paymentId,
        refundAmount: payment.amount,
        refundReason: 'first',
        refundTransactionId: `dbint-${Date.now()}-r1`,
      },
    });

    const message = await rejection(
      prisma.refund.create({
        data: {
          paymentId: payment.paymentId,
          refundAmount: payment.amount,
          refundReason: 'second',
          refundTransactionId: `dbint-${Date.now()}-r2`,
        },
      }),
    );
    expectUniqueViolationOn(message, 'payment_id');

    await prisma.refund.update({
      where: { refundId: refund.refundId },
      data: { refundStatus: 'FAILED', processedAt: new Date() },
    });
    await prisma.refund.create({
      data: {
        paymentId: payment.paymentId,
        refundAmount: payment.amount,
        refundReason: 'retry',
        refundTransactionId: `dbint-${Date.now()}-r3`,
      },
    });
  });

  it('rejects processed_at that disagrees with the refund status', async () => {
    const shop = await fx.createShop('refund-processed');
    const { payment } = await paidOrder(shop);
    const message = await rejection(
      prisma.refund.create({
        data: {
          paymentId: payment.paymentId,
          refundAmount: payment.amount,
          refundReason: 'bad',
          refundTransactionId: `dbint-${Date.now()}-r4`,
          refundStatus: 'PROCESSED',
        },
      }),
    );
    expect(message).toContain('refunds_processed_at_matches_status');
  });
});

describe('orders, order items and pricing rules', () => {
  it('rejects a negative order total', async () => {
    const shop = await fx.createShop('order-negative');
    const orderId = await fx.createOrder(student.token, shop);
    const message = await rejection(
      prisma.$executeRaw`UPDATE orders SET total_amount = -1 WHERE order_id = ${orderId}`,
    );
    expect(message).toContain('orders_total_amount_non_negative');
  });

  it('keeps cancelled_at and CANCELLED in step', async () => {
    const shop = await fx.createShop('order-cancelled');
    const orderId = await fx.createOrder(student.token, shop);

    const withoutTimestamp = await rejection(
      prisma.$executeRaw`UPDATE orders SET order_status = 'CANCELLED'::"OrderStatus" WHERE order_id = ${orderId}`,
    );
    expect(withoutTimestamp).toContain('orders_cancelled_at_matches_status');

    const timestampOnly = await rejection(
      prisma.$executeRaw`UPDATE orders SET cancelled_at = now() WHERE order_id = ${orderId}`,
    );
    expect(timestampOnly).toContain('orders_cancelled_at_matches_status');

    // The real cancellation path sets both.
    expect((await fx.cancelRequest(student.token, orderId)).status).toBe(200);
  });

  it('rejects an order item with zero copies, zero pages or a negative price', async () => {
    const shop = await fx.createShop('item-checks');
    const orderId = await fx.createOrder(student.token, shop);

    expect(
      await rejection(prisma.$executeRaw`UPDATE order_documents SET copies = 0 WHERE order_id = ${orderId}`),
    ).toContain('order_documents_copies_positive');
    expect(
      await rejection(
        prisma.$executeRaw`UPDATE order_documents SET print_page_count = 0 WHERE order_id = ${orderId}`,
      ),
    ).toContain('order_documents_print_page_count_positive');
    expect(
      await rejection(
        prisma.$executeRaw`UPDATE order_documents SET line_total = -1 WHERE order_id = ${orderId}`,
      ),
    ).toContain('order_documents_prices_non_negative');
  });

  it('rejects a pricing rule that ends before it starts, but allows ending exactly at its start', async () => {
    const shop = await fx.createShop('rule-range');
    const from = new Date('2031-01-01T00:00:00.000Z');

    const message = await rejection(
      prisma.shopPricingRule.create({
        data: {
          shopId: shop.shopId,
          printType: 'COLOR',
          paperSize: 'A3',
          sides: 'DOUBLE',
          pricePerPage: 5,
          effectiveFrom: from,
          effectiveTo: new Date(from.getTime() - 1000),
        },
      }),
    );
    expect(message).toContain('shop_pricing_rules_effective_range');

    await prisma.shopPricingRule.create({
      data: {
        shopId: shop.shopId,
        printType: 'COLOR',
        paperSize: 'A3',
        sides: 'DOUBLE',
        pricePerPage: 5,
        effectiveFrom: from,
        effectiveTo: from,
      },
    });
  });

  it('rejects a negative pricing or finishing price', async () => {
    const shop = await fx.createShop('rule-negative');
    expect(
      await rejection(
        prisma.shopPricingRule.create({
          data: {
            shopId: shop.shopId,
            printType: 'COLOR',
            paperSize: 'A5',
            sides: 'SINGLE',
            pricePerPage: -1,
            effectiveFrom: new Date('2031-01-01T00:00:00.000Z'),
          },
        }),
      ),
    ).toContain('shop_pricing_rules_price_non_negative');

    expect(
      await rejection(
        prisma.shopFinishingRule.create({
          data: {
            shopId: shop.shopId,
            finishingType: 'STAPLING',
            price: -1,
            effectiveFrom: new Date('2031-01-01T00:00:00.000Z'),
          },
        }),
      ),
    ).toContain('shop_finishing_rules_price_non_negative');
  });
});
