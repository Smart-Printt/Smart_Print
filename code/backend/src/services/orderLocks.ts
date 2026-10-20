import { Order, OrderStatus, Prisma } from '@prisma/client';

import { canTransition } from '../config/orderTransitions';
import { ConflictError, NotFoundError } from '../utils/errors';

type Tx = Prisma.TransactionClient;

// LOCK ORDER - every transaction that changes an order or its queue entry
// takes its row locks in this fixed order, and never goes back up:
//
//   1. the shop        (lockShop)
//   2. the order       (lockOrder)
//   3. the queue entry (written only after the order is locked)
//
// Two transactions that follow one global order cannot deadlock, and taking
// the shop first is what serialises per-shop queue work (queue numbers, "one
// PRINTING order per shop", FIFO head selection). An order's shopId never
// changes, so callers read it before opening the transaction. Anything they
// read before the locks is only a hint: state that decides an outcome is
// re-read from the row returned by lockOrder.
//
// Transactions that hold a single lock (e.g. document rows) cannot take part
// in a cycle, so they are free to use any single lock.

export async function lockShop(tx: Tx, shopId: string): Promise<void> {
  await tx.$queryRaw`SELECT shop_id FROM print_shops WHERE shop_id = ${shopId} FOR UPDATE`;
}

// Locks the order row and returns its CURRENT committed state.
export async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const rows = await tx.$queryRaw<{ order_id: string }[]>`
    SELECT order_id FROM orders WHERE order_id = ${orderId} FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundError('Order not found');
  }
  return tx.order.findUniqueOrThrow({ where: { orderId } });
}

// Status-guarded transition: checks the table of legal transitions, then
// updates only if the order is STILL in `from`. Losing a race surfaces as a
// 409 instead of silently overwriting the winner.
export async function transitionOrder(
  tx: Tx,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  extraData: Prisma.OrderUpdateManyMutationInput = {},
): Promise<void> {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order status transition ${from} -> ${to}`);
  }
  const result = await tx.order.updateMany({
    where: { orderId, orderStatus: from },
    data: { ...extraData, orderStatus: to },
  });
  if (result.count === 0) {
    throw new ConflictError(`Order is no longer ${from}`);
  }
}
