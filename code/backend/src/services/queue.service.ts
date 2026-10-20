import { OrderStatus, Prisma, Queue, UserRole } from '@prisma/client';

import { prisma } from '../config/prisma';
import * as orderService from './order.service';
import { lockOrder, lockShop, transitionOrder } from './orderLocks';
import * as shopService from './shop.service';
import { SafeQueueEntry } from '../types/queue.types';
import { ConflictError, NotFoundError } from '../utils/errors';

type QueueWithOrder = Queue & { order: { orderCode: string; shopId: string } };

const QUEUE_WITH_ORDER_INCLUDE = {
  order: { select: { orderCode: true, shopId: true } },
} satisfies Prisma.QueueInclude;

// FIFO order within a shop = the order in which entries were serialized under
// the shop lock. queueNumber is allocated as (max + 1) while holding that lock
// (see enqueueOrderWithinTransaction), so it is strictly increasing in exactly
// that order and is the canonical key. enteredAt is NOT used to decide order:
// it is a millisecond-resolution reading of the application server's clock, so
// two entries can share a value and a clock adjustment can move it backwards.
// queueId (a random UUID) is only a last-resort tie-break for a pathological
// duplicate queueNumber; it is never what orders ordinary entries. Never page
// count, price, copies, or user. Used by start-next, the listing, "next" and
// computePosition so they cannot disagree.
const FIFO_ORDER: Prisma.QueueOrderByWithRelationInput[] = [
  { queueNumber: 'asc' },
  { queueId: 'asc' },
];

function toSafeQueueEntry(queue: QueueWithOrder, position: number | null): SafeQueueEntry {
  return {
    queueId: queue.queueId,
    orderId: queue.orderId,
    orderCode: queue.order.orderCode,
    shopId: queue.order.shopId,
    queueNumber: queue.queueNumber,
    queueStatus: queue.queueStatus,
    enteredAt: queue.enteredAt,
    startedAt: queue.startedAt,
    completedAt: queue.completedAt,
    cancelledAt: queue.cancelledAt,
    position,
  };
}

// position is always derived from the same ordering as FIFO_ORDER
// (queueNumber, then queueId) among WAITING entries at the same shop - never
// stored, so it can never drift out of sync when an earlier order completes or
// is cancelled.
async function computePosition(
  client: Prisma.TransactionClient | typeof prisma,
  shopId: string,
  queue: Queue,
): Promise<number | null> {
  if (queue.queueStatus === 'PRINTING') {
    return 0;
  }
  if (queue.queueStatus !== 'WAITING') {
    return null;
  }

  const aheadCount = await client.queue.count({
    where: {
      queueStatus: 'WAITING',
      order: { shopId },
      OR: [
        { queueNumber: { lt: queue.queueNumber } },
        { queueNumber: queue.queueNumber, queueId: { lt: queue.queueId } },
      ],
    },
  });
  return aheadCount + 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Payment -> Queue integration (called from payment.service.ts::confirmPayment
// inside its existing transaction - queue creation and the
// PAYMENT_CONFIRMED -> QUEUED order transition are one atomic unit with the
// payment settling to SUCCESS).
// ─────────────────────────────────────────────────────────────────────────

export async function enqueueOrderWithinTransaction(
  tx: Prisma.TransactionClient,
  shopId: string,
  orderId: string,
  changedByUserId: string,
  fromStatus: OrderStatus,
): Promise<void> {
  // Row-locks the shop for the duration of the transaction so two orders
  // for the SAME shop being enqueued at the same moment cannot both compute
  // the same "next" queueNumber. Callers already hold this lock (shop is the
  // first lock in the order, see orderLocks.ts); taking it again is a no-op
  // and keeps this function safe to call on its own.
  await lockShop(tx, shopId);

  const { _max } = await tx.queue.aggregate({
    _max: { queueNumber: true },
    where: { order: { shopId } },
  });
  const queueNumber = (_max.queueNumber ?? 0) + 1;

  // Queue.orderId is DB-unique - if this order somehow already has a queue
  // entry (should be unreachable, since the guarded transition below only
  // succeeds once per order), this create throws rather than silently
  // creating a duplicate.
  await tx.queue.create({
    data: { orderId, queueNumber, queueStatus: 'WAITING' },
  });

  await transitionOrder(tx, orderId, fromStatus, 'QUEUED');
  await tx.orderStatusHistory.create({
    data: {
      orderId,
      status: 'QUEUED',
      changedByUserId,
      notes: `Entered print queue (queue #${queueNumber})`,
    },
  });
}

// Cancellation integration lives in order.service.ts::cancelOrder itself
// (a small inline update, not here) - see the comment there for why.

// ─────────────────────────────────────────────────────────────────────────
// Student-facing (order-scoped) reads
// ─────────────────────────────────────────────────────────────────────────

async function findQueueEntryForOrder(orderId: string): Promise<QueueWithOrder> {
  const queue = await prisma.queue.findUnique({
    where: { orderId },
    include: QUEUE_WITH_ORDER_INCLUDE,
  });
  if (!queue) {
    throw new NotFoundError('No queue entry found for this order');
  }
  return queue;
}

export async function getQueueEntryForOrder(
  requestingUserId: string,
  requestingUserRole: string,
  orderId: string,
): Promise<SafeQueueEntry> {
  // ADMIN and SHOP_STAFF (scoped to their own shop) can view any order's
  // queue entry within their remit; everyone else must own the order.
  if (requestingUserRole === 'ADMIN') {
    await orderService.getOrderRowOrThrow(orderId);
  } else if (requestingUserRole === 'SHOP_STAFF') {
    const order = await orderService.getOrderRowOrThrow(orderId);
    await shopService.assertShopAccess(requestingUserId, requestingUserRole as UserRole, order.shopId);
  } else {
    await orderService.getOwnedOrderRowOrThrow(requestingUserId, orderId);
  }

  const queue = await findQueueEntryForOrder(orderId);
  const position = await computePosition(prisma, queue.order.shopId, queue);
  return toSafeQueueEntry(queue, position);
}

export async function getQueuePositionForOrder(
  requestingUserId: string,
  requestingUserRole: string,
  orderId: string,
): Promise<{ position: number | null }> {
  const entry = await getQueueEntryForOrder(requestingUserId, requestingUserRole, orderId);
  return { position: entry.position };
}

// ─────────────────────────────────────────────────────────────────────────
// Shop-facing (staff/admin) reads - read-only, never mutate the queue.
// Phase 8: scoped via shopService.assertShopAccess - ADMIN sees any shop,
// SHOP_STAFF only their own assigned (and ACTIVE) shop, STUDENT never.
// This operational view (order codes, timestamps) is not the same as the
// public shop directory (GET /api/shops), which stays open to students.
// ─────────────────────────────────────────────────────────────────────────

export async function listWaitingQueueForShop(
  userId: string,
  role: UserRole,
  shopId: string,
): Promise<SafeQueueEntry[]> {
  await shopService.assertShopAccess(userId, role, shopId);

  const entries = await prisma.queue.findMany({
    where: { queueStatus: 'WAITING', order: { shopId } },
    orderBy: FIFO_ORDER,
    include: QUEUE_WITH_ORDER_INCLUDE,
  });

  // Already FIFO-ordered by the query above, so position is just the
  // 1-based index - no need for a per-entry count query here.
  return entries.map((entry, index) => toSafeQueueEntry(entry, index + 1));
}

export async function getNextForShop(
  userId: string,
  role: UserRole,
  shopId: string,
): Promise<SafeQueueEntry | null> {
  await shopService.assertShopAccess(userId, role, shopId);

  const entry = await prisma.queue.findFirst({
    where: { queueStatus: 'WAITING', order: { shopId } },
    orderBy: FIFO_ORDER,
    include: QUEUE_WITH_ORDER_INCLUDE,
  });
  return entry ? toSafeQueueEntry(entry, 1) : null;
}

export async function getCurrentForShop(
  userId: string,
  role: UserRole,
  shopId: string,
): Promise<SafeQueueEntry | null> {
  await shopService.assertShopAccess(userId, role, shopId);

  const entry = await prisma.queue.findFirst({
    where: { queueStatus: 'PRINTING', order: { shopId } },
    include: QUEUE_WITH_ORDER_INCLUDE,
  });
  return entry ? toSafeQueueEntry(entry, 0) : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Shop-facing mutations. Phase 8: ADMIN (any shop) or SHOP_STAFF (their own
// assigned, ACTIVE shop only) - see shopService.assertShopAccess, which
// re-derives the staff member's shop from the database on every call and
// never trusts the :shopId route param as proof of assignment.
// ─────────────────────────────────────────────────────────────────────────

// Single-printer-per-shop model (see queue.types.ts / project spec): at
// most one PRINTING entry may exist per shop at a time. Two concurrent
// start-next calls for the SAME shop are serialized by the shop-row lock
// below - the second either finds a different WAITING entry (if the first
// already committed and a new one is available) or, more commonly under
// this single-printer model, is rejected with 409 because an order is now
// printing - it must retry once that order completes. Calls for DIFFERENT
// shops never block each other (different row locked).
export async function startNextForShop(
  userId: string,
  role: UserRole,
  shopId: string,
): Promise<SafeQueueEntry> {
  await shopService.assertShopAccess(userId, role, shopId);
  const changedByUserId = userId;

  const started = await prisma.$transaction(async (tx) => {
    // Lock order: shop -> order -> queue (see orderLocks.ts).
    await lockShop(tx, shopId);

    const alreadyPrinting = await tx.queue.findFirst({
      where: { queueStatus: 'PRINTING', order: { shopId } },
    });
    if (alreadyPrinting) {
      throw new ConflictError('An order is already printing at this shop');
    }

    // Walk the WAITING entries in FIFO order until one is genuinely
    // eligible. An entry whose order is no longer QUEUED (cancelled by a
    // path that did not clean up its queue entry, or otherwise inconsistent)
    // is skipped - it never blocks the entries behind it, and is never
    // printed. Eligibility is judged from the order row AS LOCKED, not from
    // anything read earlier.
    const skipped: string[] = [];
    for (;;) {
      const next = await tx.queue.findFirst({
        where: { queueStatus: 'WAITING', order: { shopId }, queueId: { notIn: skipped } },
        orderBy: FIFO_ORDER,
      });
      if (!next) {
        throw new NotFoundError('No orders are waiting in the queue for this shop');
      }

      const order = await lockOrder(tx, next.orderId);
      if (order.orderStatus !== 'QUEUED' || order.shopId !== shopId) {
        if (order.orderStatus === 'CANCELLED') {
          // Repair the stale entry so it stops appearing in the queue.
          await tx.queue.updateMany({
            where: { queueId: next.queueId, queueStatus: 'WAITING' },
            data: { queueStatus: 'CANCELLED', cancelledAt: new Date() },
          });
        }
        skipped.push(next.queueId);
        continue;
      }

      const result = await tx.queue.updateMany({
        where: { queueId: next.queueId, queueStatus: 'WAITING' },
        data: { queueStatus: 'PRINTING', startedAt: new Date() },
      });
      if (result.count === 0) {
        skipped.push(next.queueId);
        continue;
      }

      await transitionOrder(tx, order.orderId, 'QUEUED', 'PRINTING');
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.orderId,
          status: 'PRINTING',
          changedByUserId,
          notes: 'Printing started',
        },
      });

      return tx.queue.findUniqueOrThrow({
        where: { queueId: next.queueId },
        include: QUEUE_WITH_ORDER_INCLUDE,
      });
    }
  });

  return toSafeQueueEntry(started, 0);
}

export async function completeQueueEntry(
  userId: string,
  role: UserRole,
  shopId: string,
  queueId: string,
): Promise<SafeQueueEntry> {
  await shopService.assertShopAccess(userId, role, shopId);
  const changedByUserId = userId;

  const queue = await prisma.queue.findUnique({ where: { queueId }, include: QUEUE_WITH_ORDER_INCLUDE });
  if (!queue || queue.order.shopId !== shopId) {
    throw new NotFoundError('Queue entry not found');
  }
  if (queue.queueStatus !== 'PRINTING') {
    throw new ConflictError(`Queue entry cannot be completed while it is ${queue.queueStatus}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Lock order: shop -> order -> queue (see orderLocks.ts).
    await lockShop(tx, shopId);
    await lockOrder(tx, queue.orderId);

    const result = await tx.queue.updateMany({
      where: { queueId, queueStatus: 'PRINTING' },
      data: { queueStatus: 'COMPLETED', completedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictError('Queue entry has already moved on from PRINTING');
    }

    await transitionOrder(tx, queue.orderId, 'PRINTING', 'READY');
    await tx.orderStatusHistory.create({
      data: {
        orderId: queue.orderId,
        status: 'READY',
        changedByUserId,
        notes: 'Printing completed - ready for collection',
      },
    });

    return tx.queue.findUniqueOrThrow({ where: { queueId }, include: QUEUE_WITH_ORDER_INCLUDE });
  });

  return toSafeQueueEntry(updated, null);
}

// Not queue-specific (the queue's own job ends at COMPLETED), but the
// natural next step in the printing lifecycle - kept here for cohesion
// with the rest of the printing-flow endpoints rather than bolted onto
// order.service.ts. ADMIN or SHOP_STAFF assigned to the order's shop, same
// rationale as the queue mutations above - derived from order.shopId, not
// from any client input.
export async function collectOrder(userId: string, role: UserRole, orderId: string): Promise<void> {
  const order = await orderService.getOrderRowOrThrow(orderId);
  await shopService.assertShopAccess(userId, role, order.shopId);
  const changedByUserId = userId;

  if (order.orderStatus !== 'READY') {
    throw new ConflictError(`Order cannot be collected while it is ${order.orderStatus}`);
  }

  await prisma.$transaction(async (tx) => {
    // Lock order: shop -> order (see orderLocks.ts).
    await lockShop(tx, order.shopId);
    await lockOrder(tx, orderId);

    await transitionOrder(tx, orderId, 'READY', 'COLLECTED');

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        status: 'COLLECTED',
        changedByUserId,
        notes: 'Order collected',
      },
    });
  });
}
