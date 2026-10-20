import { randomUUID } from 'node:crypto';

import { Refund, UserRole } from '@prisma/client';

import { MAX_REFUND_REASON_LENGTH, REFUNDABLE_ORDER_STATUSES } from '../config/orderPolicy';
import { prisma } from '../config/prisma';
import * as orderService from './order.service';
import { assertValidSimulateOutcome } from './payment.service';
import * as shopService from './shop.service';
import { paymentProvider } from './payments';
import { ProviderOutcome } from './payments/paymentProvider';
import { ProcessRefundInput, RequestRefundInput, SafeRefund } from '../types/refund.types';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';

function assertValidReason(reason: unknown): asserts reason is string {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ValidationError('reason is required');
  }
  if (reason.length > MAX_REFUND_REASON_LENGTH) {
    throw new ValidationError(`reason may not exceed ${MAX_REFUND_REASON_LENGTH} characters`);
  }
}

function toSafeRefund(refund: Refund, orderId: string): SafeRefund {
  return {
    refundId: refund.refundId,
    paymentId: refund.paymentId,
    orderId,
    refundAmount: refund.refundAmount.toString(),
    refundReason: refund.refundReason,
    refundStatus: refund.refundStatus,
    refundTransactionId: refund.refundTransactionId,
    requestedAt: refund.requestedAt,
    processedAt: refund.processedAt,
  };
}

// Policy: full refund only - refundAmount is always the successful
// payment's full amount, never a client-supplied or partial value. Keeping
// this explicit (rather than accidentally supporting partial refunds)
// matches the simplest policy consistent with the current models.
export async function requestRefund(
  userId: string,
  orderId: string,
  input: RequestRefundInput,
): Promise<SafeRefund> {
  assertValidReason(input.reason);
  const reason = input.reason.trim();

  const order = await orderService.getOwnedOrderRowOrThrow(userId, orderId);

  if (!REFUNDABLE_ORDER_STATUSES.includes(order.orderStatus as never)) {
    throw new ConflictError(
      `Order cannot be refunded while it is ${order.orderStatus} - it must be cancelled first`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { orderId, paymentStatus: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new ConflictError('This order has no successful payment to refund');
    }

    // Row-locks the payment for the duration of the transaction so two
    // concurrent refund requests for the same payment cannot both pass the
    // "no active refund yet" check below.
    await tx.$queryRaw`SELECT payment_id FROM payments WHERE payment_id = ${payment.paymentId} FOR UPDATE`;

    const existingActiveRefund = await tx.refund.findFirst({
      where: { paymentId: payment.paymentId, refundStatus: { in: ['REQUESTED', 'PROCESSED'] } },
    });
    if (existingActiveRefund) {
      throw new ConflictError(
        'This payment has already been refunded or has a refund request in progress',
      );
    }

    const { providerReference } = await paymentProvider.initiateRefund({
      originalProviderReference: payment.transactionId,
      amount: payment.amount,
    });

    const refund = await tx.refund.create({
      data: {
        refundId: randomUUID(),
        paymentId: payment.paymentId,
        refundAmount: payment.amount,
        refundReason: reason,
        refundStatus: 'REQUESTED',
        refundTransactionId: providerReference,
      },
    });

    return refund;
  });

  return toSafeRefund(created, orderId);
}

async function getLatestActiveOrAnyRefund(orderId: string): Promise<Refund> {
  const payment = await prisma.payment.findFirst({
    where: { orderId, paymentStatus: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) {
    throw new NotFoundError('No refundable payment found for this order');
  }

  const refund = await prisma.refund.findFirst({
    where: { paymentId: payment.paymentId },
    orderBy: { requestedAt: 'desc' },
  });
  if (!refund) {
    throw new NotFoundError('No refund found for this order');
  }
  return refund;
}

// ADMIN-only (enforced at the route level) - no ownership check here, since
// the caller is not the order's owner. SHOP_STAFF is intentionally not
// granted this, per spec: shop staff may VIEW refund info for their own
// shop (see getRefundForOrder below) but refund processing stays a
// centralized ADMIN responsibility.
export async function processRefund(orderId: string, input: ProcessRefundInput): Promise<SafeRefund> {
  assertValidSimulateOutcome(input.simulateOutcome);

  await orderService.getOrderRowOrThrow(orderId);
  const refund = await getLatestActiveOrAnyRefund(orderId);

  if (refund.refundStatus !== 'REQUESTED') {
    throw new ConflictError('This refund has already been processed');
  }

  const { outcome } = await paymentProvider.confirmRefund({
    providerReference: refund.refundTransactionId,
    simulateOutcome: input.simulateOutcome as ProviderOutcome | undefined,
  });
  // RefundStatus (PROCESSED/FAILED) is a different vocabulary than the
  // provider's generic ProviderOutcome (SUCCESS/FAILED) - map explicitly
  // rather than assuming the strings line up.
  const refundStatus = outcome === 'SUCCESS' ? 'PROCESSED' : 'FAILED';

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.refund.updateMany({
      where: { refundId: refund.refundId, refundStatus: 'REQUESTED' },
      data: {
        refundStatus,
        processedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new ConflictError('This refund has already been processed');
    }

    return tx.refund.findUniqueOrThrow({ where: { refundId: refund.refundId } });
  });

  return toSafeRefund(updated, orderId);
}

// Role-scoped refund visibility, same pattern as
// payment.service.ts::getLatestPaymentForOrder and
// queue.service.ts::getQueueEntryForOrder: ADMIN may view any order's
// refund, SHOP_STAFF only an order belonging to their own (ACTIVE) assigned
// shop - re-derived from the database via shopService.assertShopAccess,
// never trusted from the order itself. Staff may only VIEW - processing
// stays ADMIN-only (see processRefund above, gated at the route level).
export async function getRefundForOrder(
  requestingUserId: string,
  requestingUserRole: UserRole,
  orderId: string,
): Promise<SafeRefund> {
  if (requestingUserRole === 'ADMIN') {
    await orderService.getOrderRowOrThrow(orderId);
  } else if (requestingUserRole === 'SHOP_STAFF') {
    const order = await orderService.getOrderRowOrThrow(orderId);
    await shopService.assertShopAccess(requestingUserId, requestingUserRole, order.shopId);
  } else {
    await orderService.getOwnedOrderRowOrThrow(requestingUserId, orderId);
  }

  const refund = await getLatestActiveOrAnyRefund(orderId);
  return toSafeRefund(refund, orderId);
}
