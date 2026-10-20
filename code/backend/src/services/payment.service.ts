import { randomUUID } from 'node:crypto';

import { Payment, UserRole } from '@prisma/client';

import { PAYABLE_ORDER_STATUSES } from '../config/orderPolicy';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import * as orderService from './order.service';
import * as queueService from './queue.service';
import * as shopService from './shop.service';
import { paymentProvider } from './payments';
import { ProviderOutcome } from './payments/paymentProvider';
import { ConfirmPaymentInput, InitiatePaymentInput, SafePayment } from '../types/payment.types';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';

const PAYMENT_METHODS = ['UPI', 'CARD', 'WALLET', 'CASH'] as const;

function assertValidPaymentMethod(
  value: unknown,
): asserts value is (typeof PAYMENT_METHODS)[number] {
  if (typeof value !== 'string' || !PAYMENT_METHODS.includes(value as never)) {
    throw new ValidationError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
}

// Mock-provider-only test hook, disabled outside development/test - see
// paymentProvider.ts. A real provider would never accept this; the outcome
// would instead come from a verified gateway callback. Exported for reuse
// by refund.service.ts (the same rule applies to refund settlement).
export function assertValidSimulateOutcome(
  value: unknown,
): asserts value is ProviderOutcome | undefined {
  if (value === undefined) {
    return;
  }
  if (env.nodeEnv === 'production') {
    throw new ValidationError('simulateOutcome is not available in production');
  }
  if (value !== 'SUCCESS' && value !== 'FAILED') {
    throw new ValidationError('simulateOutcome must be one of: SUCCESS, FAILED');
  }
}

function toSafePayment(payment: Payment): SafePayment {
  return {
    paymentId: payment.paymentId,
    orderId: payment.orderId,
    amount: payment.amount.toString(),
    paymentMethod: payment.paymentMethod,
    transactionId: payment.transactionId,
    paymentStatus: payment.paymentStatus,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
  };
}

// Client-supplied amounts are never read anywhere in this file - the
// charged amount always comes from order.totalAmount, computed and
// snapshotted by the pricing service at order-creation time (Phase 5).
export async function initiatePayment(
  userId: string,
  orderId: string,
  input: InitiatePaymentInput,
): Promise<SafePayment> {
  assertValidPaymentMethod(input.paymentMethod);
  const paymentMethod = input.paymentMethod;

  const order = await orderService.getOwnedOrderRowOrThrow(userId, orderId);

  if (!PAYABLE_ORDER_STATUSES.includes(order.orderStatus as never)) {
    throw new ConflictError(
      `Order cannot be paid while it is ${order.orderStatus}`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    // Row-locks the order for the duration of the transaction so two
    // concurrent "Pay" clicks cannot both pass the "no PENDING payment
    // yet" check below and both create a payment.
    await tx.$queryRaw`SELECT order_id FROM orders WHERE order_id = ${orderId} FOR UPDATE`;

    const existingPending = await tx.payment.findFirst({
      where: { orderId, paymentStatus: 'PENDING' },
    });
    if (existingPending) {
      throw new ConflictError('A payment is already in progress for this order');
    }

    const { providerReference } = await paymentProvider.initiatePayment({
      orderReference: order.orderCode,
      amount: order.totalAmount,
      paymentMethod,
    });

    return tx.payment.create({
      data: {
        paymentId: randomUUID(),
        orderId,
        amount: order.totalAmount,
        paymentMethod,
        transactionId: providerReference,
        paymentStatus: 'PENDING',
      },
    });
  });

  return toSafePayment(created);
}

// No paymentId in the request - at most one PENDING payment can exist for
// an order at a time (enforced in initiatePayment above), so the order id
// alone is enough to find the payment being confirmed. This mirrors how a
// real gateway redirects the buyer back to an order-scoped return URL
// without the frontend needing to track a separate payment identifier.
export async function confirmPayment(
  userId: string,
  orderId: string,
  input: ConfirmPaymentInput,
): Promise<SafePayment> {
  assertValidSimulateOutcome(input.simulateOutcome);

  const order = await orderService.getOwnedOrderRowOrThrow(userId, orderId);

  const payment = await prisma.payment.findFirst({
    where: { orderId, paymentStatus: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) {
    throw new NotFoundError('No pending payment found for this order');
  }

  // The order may have been cancelled (or otherwise moved on) while this
  // payment was still PENDING - never let a stale payment confirm SUCCESS
  // against an order that is no longer payable.
  if (!PAYABLE_ORDER_STATUSES.includes(order.orderStatus as never)) {
    throw new ConflictError(`Order cannot be confirmed as paid while it is ${order.orderStatus}`);
  }

  const { outcome } = await paymentProvider.confirmPayment({
    providerReference: payment.transactionId,
    simulateOutcome: input.simulateOutcome as ProviderOutcome | undefined,
  });

  const updated = await prisma.$transaction(async (tx) => {
    // Atomic, WHERE-guarded update: if two confirm requests race, only the
    // one that observes paymentStatus still PENDING can flip it - the
    // loser sees count === 0 and is rejected below, so a payment can never
    // be driven to SUCCESS twice.
    const result = await tx.payment.updateMany({
      where: { paymentId: payment.paymentId, paymentStatus: 'PENDING' },
      data: {
        paymentStatus: outcome,
        paidAt: outcome === 'SUCCESS' ? new Date() : null,
      },
    });
    if (result.count === 0) {
      throw new ConflictError('This payment has already been finalized');
    }

    if (outcome === 'SUCCESS') {
      await tx.order.update({
        where: { orderId },
        data: { orderStatus: 'PAYMENT_CONFIRMED' },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: 'PAYMENT_CONFIRMED',
          changedByUserId: userId,
          notes: `Payment confirmed (transaction ${payment.transactionId})`,
        },
      });

      // Phase 7: a successfully paid order immediately enters the print
      // queue, in this same transaction - never via a background scan, so
      // "payment SUCCESS" and "queue entry exists" can never disagree.
      await queueService.enqueueOrderWithinTransaction(tx, order.shopId, orderId, userId);
    }

    return tx.payment.findUniqueOrThrow({ where: { paymentId: payment.paymentId } });
  });

  return toSafePayment(updated);
}

// Role-scoped payment visibility, mirroring refund.service.ts's
// getRefundForOrder: ADMIN may view any order's payment, SHOP_STAFF only an
// order belonging to their own (ACTIVE) assigned shop - re-derived from the
// database via shopService.assertShopAccess, never trusted from the order
// itself - and every other role only ever sees their own order's payment.
export async function getLatestPaymentForOrder(
  userId: string,
  role: UserRole,
  orderId: string,
): Promise<SafePayment> {
  if (role === 'ADMIN') {
    await orderService.getOrderRowOrThrow(orderId);
  } else if (role === 'SHOP_STAFF') {
    const order = await orderService.getOrderRowOrThrow(orderId);
    await shopService.assertShopAccess(userId, role, order.shopId);
  } else {
    await orderService.getOwnedOrderRowOrThrow(userId, orderId);
  }

  const payment = await prisma.payment.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) {
    throw new NotFoundError('No payment found for this order');
  }
  return toSafePayment(payment);
}
