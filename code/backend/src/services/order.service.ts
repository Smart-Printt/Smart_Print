import { randomUUID } from 'node:crypto';

import { Order, OrderDocument, OrderStatusHistory, Prisma, PrintShop, UserRole } from '@prisma/client';

import { CANCELLABLE_ORDER_STATUSES, MAX_SPECIAL_INSTRUCTIONS_LENGTH } from '../config/orderPolicy';
import { prisma } from '../config/prisma';
import { lockOrder, lockShop, transitionOrder } from './orderLocks';
import * as pricingService from './pricing.service';
import * as queueService from './queue.service';
import * as shopService from './shop.service';
import {
  CreateOrderInput,
  CreateOrderItemInput,
  SafeOrder,
  SafeOrderItem,
  SafeOrderStatusEvent,
} from '../types/order.types';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { hashCreateOrderRequest } from '../utils/idempotency';
import { generateOrderCode } from '../utils/orderCode';

type OrderWithRelations = Order & {
  shop: PrintShop;
  user: { name: string; email: string };
  orderDocuments: (OrderDocument & {
    document: { fileName: string };
    pricingRule: { printType: string; paperSize: string; sides: string };
    finishingRule: { finishingType: string } | null;
  })[];
  statusHistory: OrderStatusHistory[];
};

const ORDER_INCLUDE = {
  shop: true,
  user: { select: { name: true, email: true } },
  orderDocuments: {
    include: {
      document: { select: { fileName: true } },
      pricingRule: { select: { printType: true, paperSize: true, sides: true } },
      finishingRule: { select: { finishingType: true } },
    },
  },
  statusHistory: { orderBy: { changedAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

function toSafeOrder(order: OrderWithRelations): SafeOrder {
  const items: SafeOrderItem[] = order.orderDocuments.map((item) => ({
    orderDocumentId: item.orderDocumentId,
    documentId: item.documentId,
    fileName: item.document.fileName,
    printType: item.pricingRule.printType as SafeOrderItem['printType'],
    paperSize: item.pricingRule.paperSize as SafeOrderItem['paperSize'],
    sides: item.pricingRule.sides as SafeOrderItem['sides'],
    copies: item.copies,
    pageRange: item.pageRange,
    printPageCount: item.printPageCount,
    finishingType: (item.finishingRule?.finishingType as SafeOrderItem['finishingType']) ?? null,
    specialInstructions: item.specialInstructions,
    pricePerPage: item.pricePerPage.toString(),
    finishingPrice: item.finishingPrice.toString(),
    lineTotal: item.lineTotal.toString(),
  }));

  const statusHistory: SafeOrderStatusEvent[] = order.statusHistory.map((event) => ({
    status: event.status,
    changedByUserId: event.changedByUserId,
    changedAt: event.changedAt,
    notes: event.notes,
  }));

  return {
    orderId: order.orderId,
    orderCode: order.orderCode,
    shopId: order.shopId,
    shopName: order.shop.shopName,
    customerName: order.user.name,
    customerEmail: order.user.email,
    orderStatus: order.orderStatus,
    totalAmount: order.totalAmount.toString(),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
    cancelledReason: order.cancelledReason,
    items,
    statusHistory,
  };
}

function assertValidSpecialInstructions(
  specialInstructions: unknown,
): asserts specialInstructions is string | undefined {
  if (specialInstructions === undefined || specialInstructions === null) {
    return;
  }
  if (typeof specialInstructions !== 'string') {
    throw new ValidationError('specialInstructions must be a string');
  }
  if (specialInstructions.length > MAX_SPECIAL_INSTRUCTIONS_LENGTH) {
    throw new ValidationError(
      `specialInstructions may not exceed ${MAX_SPECIAL_INSTRUCTIONS_LENGTH} characters`,
    );
  }
}

interface ResolvedItem {
  documentId: string;
  pricingRuleId: string;
  finishingRuleId: string | null;
  copies: number;
  printPageCount: number;
  pageRange: string | null;
  specialInstructions: string | null;
  pricePerPage: Prisma.Decimal;
  finishingPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

// Document ownership, page-range selection, applicable pricing rule,
// optional finishing rule, and Decimal cost calculation are all resolved by
// the shared pricing service (see pricing.service.ts) - the pricing preview
// endpoint calls the exact same function, so order creation and preview can
// never disagree on price.
async function resolveOrderItem(
  userId: string,
  shopId: string,
  raw: CreateOrderItemInput,
): Promise<ResolvedItem> {
  assertValidSpecialInstructions(raw.specialInstructions);

  const resolved = await pricingService.resolveAndPriceItem(userId, shopId, raw);

  return {
    documentId: resolved.documentId,
    pricingRuleId: resolved.pricingRule.pricingRuleId,
    finishingRuleId: resolved.finishingRule?.finishingRuleId ?? null,
    copies: resolved.copies,
    printPageCount: resolved.printPageCount,
    pageRange: resolved.pageRangeString,
    specialInstructions:
      typeof raw.specialInstructions === 'string' ? raw.specialInstructions.trim() || null : null,
    pricePerPage: resolved.pricingRule.pricePerPage,
    finishingPrice: resolved.finishingCost,
    lineTotal: resolved.lineTotal,
  };
}

export interface CreateOrderResult {
  order: SafeOrder;
  // true when an earlier request with the same Idempotency-Key already
  // created this order and nothing new was written.
  replayed: boolean;
}

function findOrderByIdempotencyKey(userId: string, idempotencyKey: string) {
  return prisma.order.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: ORDER_INCLUDE,
  });
}

// An existing order for this (user, key) is only a legitimate replay when the
// request is the same one; the same key with a different body is a client bug
// (or a reused key) and must never silently hand back an unrelated order.
function replayExistingOrder(existing: OrderWithRelations, requestHash: string): CreateOrderResult {
  if (existing.idempotencyRequestHash !== requestHash) {
    throw new ConflictError('Idempotency-Key has already been used with a different request');
  }
  return { order: toSafeOrder(existing), replayed: true };
}

// True when `err` is the unique violation on (user_id, idempotency_key): i.e.
// a concurrent request with the same key committed first.
function isIdempotencyKeyConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta?.target ?? '').includes('idempotency_key')
  );
}

// Transactional: Order + all OrderDocument rows + the initial
// OrderStatusHistory row are created atomically. Any failure (bad
// reference, DB error, unique-constraint clash on orderCode) rolls back
// everything - no partial order is ever left behind.
//
// Idempotency: with an idempotencyKey, the key and a hash of the request are
// stored on the order row in the same transaction. A retry with the same key
// and request returns that order instead of creating a second one - including
// when the retry arrives while the first request is still in flight: the
// unique index on (user_id, idempotency_key) lets exactly one insert win, and
// the loser re-reads the winner's order. Without a key every call creates a
// new order, as before.
export async function createOrder(
  userId: string,
  input: CreateOrderInput,
  role: UserRole,
  idempotencyKey: string | null = null,
): Promise<CreateOrderResult> {
  pricingService.assertValidShopId(input.shopId);
  pricingService.assertValidItemsArray(input.items);

  // Looked up before any shop/pricing work: a replay returns the order as it
  // was created even if the shop has since stopped accepting orders or prices
  // have changed. The order is returned in its CURRENT state (it may have been
  // paid or cancelled since), not as a frozen copy of the first response.
  const requestHash = idempotencyKey
    ? hashCreateOrderRequest(input.shopId, input.items as unknown[])
    : null;
  if (idempotencyKey && requestHash) {
    const existing = await findOrderByIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      return replayExistingOrder(existing, requestHash);
    }
  }

  const shop = await shopService.assertShopAcceptsOrders(input.shopId);
  shopService.assertShopEligibleForRole(shop, role);

  // Client-supplied prices (pricePerPage/finishingPrice/lineTotal/totalAmount)
  // are never read from the request at all - every price below is resolved
  // from resolveOrderItem, which only ever reads from the database.
  const resolvedItems: ResolvedItem[] = [];
  for (const rawItem of input.items as CreateOrderItemInput[]) {
    resolvedItems.push(await resolveOrderItem(userId, shop.shopId, rawItem));
  }

  // FACULTY printing at the CSE Department Faculty Printer is a free
  // institutional entitlement (see shopService.isFreeFacultyShop): the
  // snapshot price on every item, and the order total, are zeroed here -
  // never merely "skipped at payment time" - so the order itself is
  // authoritatively ₹0 regardless of what the shop's pricing rules say.
  const isFreeFacultyOrder = shopService.isFreeFacultyShop(shop, role);
  const zero = new Prisma.Decimal(0);
  const finalItems = isFreeFacultyOrder
    ? resolvedItems.map((item) => ({
        ...item,
        pricePerPage: zero,
        finishingPrice: zero,
        lineTotal: zero,
      }))
    : resolvedItems;

  const totalAmount = isFreeFacultyOrder
    ? zero
    : finalItems.reduce((sum, item) => sum.add(item.lineTotal), new Prisma.Decimal(0));

  const orderId = randomUUID();
  const orderCode = generateOrderCode();

  let created: OrderWithRelations;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Lock order: shop -> order -> queue (see orderLocks.ts). Only a free
      // order enqueues here, so only it needs the shop lock.
      if (isFreeFacultyOrder) {
        await lockShop(tx, shop.shopId);
      }

      // The documents were validated before this transaction opened; a
      // concurrent deleteDocument could have removed one since. Share-locking
      // them (in a fixed order) makes the existence/ownership check binding:
      // deleteDocument takes the same rows FOR UPDATE, so from here until
      // commit no referenced document can be deleted, and one that is already
      // gone is reported as 404 instead of surfacing as a foreign-key failure.
      const documentIds = [...new Set(finalItems.map((item) => item.documentId))].sort();
      const lockedDocuments = await tx.$queryRaw<{ document_id: string; user_id: string }[]>`
        SELECT document_id, user_id FROM documents
        WHERE document_id IN (${Prisma.join(documentIds)})
        ORDER BY document_id
        FOR SHARE`;
      if (
        lockedDocuments.length !== documentIds.length ||
        lockedDocuments.some((row) => row.user_id !== userId)
      ) {
        throw new NotFoundError('Document not found');
      }

      await tx.order.create({
        data: {
          orderId,
          orderCode,
          userId,
          shopId: shop.shopId,
          orderStatus: 'PLACED',
          totalAmount,
          idempotencyKey,
          idempotencyRequestHash: requestHash,
        },
      });

      await tx.orderDocument.createMany({
        data: finalItems.map((item) => ({
          orderId,
          documentId: item.documentId,
          pricingRuleId: item.pricingRuleId,
          finishingRuleId: item.finishingRuleId,
          copies: item.copies,
          printPageCount: item.printPageCount,
          pageRange: item.pageRange,
          specialInstructions: item.specialInstructions,
          pricePerPage: item.pricePerPage,
          finishingPrice: item.finishingPrice,
          lineTotal: item.lineTotal,
        })),
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: 'PLACED',
          changedByUserId: userId,
          notes: 'Order placed by student',
        },
      });

      // No payment is ever created for a free faculty order - it enters the
      // shop's FIFO queue immediately, atomically with order creation, the
      // same way a paid order enters it atomically with payment confirmation
      // (see payment.service.ts::confirmPayment). This is still the single
      // CSE_FACULTY queue - no separate faculty queue is created.
      if (isFreeFacultyOrder) {
        await queueService.enqueueOrderWithinTransaction(tx, shop.shopId, orderId, userId, 'PLACED');
      }

      return tx.order.findUniqueOrThrow({ where: { orderId }, include: ORDER_INCLUDE });
    });
  } catch (err) {
    // A concurrent request with the same key committed first: its order is
    // THE order for this key. (The transaction above has rolled back.)
    if (idempotencyKey && requestHash && isIdempotencyKeyConflict(err)) {
      const existing = await findOrderByIdempotencyKey(userId, idempotencyKey);
      if (existing) {
        return replayExistingOrder(existing, requestHash);
      }
      throw new ConflictError('A request with this Idempotency-Key is already being processed');
    }
    throw err;
  }

  return { order: toSafeOrder(created), replayed: false };
}

export async function listOrdersForUser(userId: string): Promise<SafeOrder[]> {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: ORDER_INCLUDE,
  });
  return orders.map(toSafeOrder);
}

// Role-scoped order visibility for GET /api/orders, mirroring the same
// (ADMIN: everything / SHOP_STAFF: own shop only / everyone else: own
// orders only) pattern already used by queue.service.ts::getQueueEntryForOrder.
// A SHOP_STAFF caller who is inactive or has no shop assignment sees an
// empty list rather than an error, matching how they'd see no queue at all.
export async function listOrdersForRequester(userId: string, role: UserRole): Promise<SafeOrder[]> {
  if (role === 'ADMIN') {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(toSafeOrder);
  }

  if (role === 'SHOP_STAFF') {
    const staffUser = await prisma.user.findUnique({ where: { userId } });
    if (!staffUser || staffUser.status !== 'ACTIVE' || !staffUser.shopId) {
      return [];
    }
    const orders = await prisma.order.findMany({
      where: { shopId: staffUser.shopId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(toSafeOrder);
  }

  return listOrdersForUser(userId);
}

// Role-scoped single-order lookup for GET /api/orders/:id, same pattern as
// listOrdersForRequester above: ADMIN may view any order, SHOP_STAFF only an
// order belonging to their own (ACTIVE) assigned shop - re-derived from the
// database via shopService.assertShopAccess, never trusted from the order
// itself - and every other role only ever sees their own order.
export async function getOrderForRequester(
  requestingUserId: string,
  requestingUserRole: UserRole,
  orderId: string,
): Promise<SafeOrder> {
  if (requestingUserRole === 'ADMIN') {
    const order = await prisma.order.findUnique({ where: { orderId }, include: ORDER_INCLUDE });
    if (!order) {
      throw new NotFoundError('Order not found');
    }
    return toSafeOrder(order);
  }

  if (requestingUserRole === 'SHOP_STAFF') {
    const order = await prisma.order.findUnique({ where: { orderId }, include: ORDER_INCLUDE });
    if (!order) {
      throw new NotFoundError('Order not found');
    }
    await shopService.assertShopAccess(requestingUserId, requestingUserRole, order.shopId);
    return toSafeOrder(order);
  }

  return getOrderForUser(requestingUserId, orderId);
}

// Same not-found-vs-not-owned indistinguishability pattern as documents: a
// student probing another student's order ID gets a plain 404.
async function findOwnedOrderOrThrow(userId: string, orderId: string): Promise<OrderWithRelations> {
  const order = await prisma.order.findUnique({ where: { orderId }, include: ORDER_INCLUDE });
  if (!order || order.userId !== userId) {
    throw new NotFoundError('Order not found');
  }
  return order;
}

export async function getOrderForUser(userId: string, orderId: string): Promise<SafeOrder> {
  const order = await findOwnedOrderOrThrow(userId, orderId);
  return toSafeOrder(order);
}

// Raw-row lookups for other services (Phase 6 payments/refunds) that need
// the unmapped Order (Decimal totalAmount, current orderStatus) rather than
// the toSafeOrder-mapped shape. Same not-found-vs-not-owned 404 pattern as
// findOwnedOrderOrThrow above.
export async function getOwnedOrderRowOrThrow(userId: string, orderId: string): Promise<Order> {
  const order = await prisma.order.findUnique({ where: { orderId } });
  if (!order || order.userId !== userId) {
    throw new NotFoundError('Order not found');
  }
  return order;
}

// No ownership check - for administrative flows (e.g. refund processing)
// that act on an order they do not themselves own.
export async function getOrderRowOrThrow(orderId: string): Promise<Order> {
  const order = await prisma.order.findUnique({ where: { orderId } });
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  return order;
}

function assertCancellable(status: string): void {
  if (!CANCELLABLE_ORDER_STATUSES.includes(status as never)) {
    throw new ConflictError(
      `Order cannot be cancelled once it is ${status} - printing may have already started`,
    );
  }
}

export async function cancelOrder(
  userId: string,
  orderId: string,
  reason: unknown,
): Promise<SafeOrder> {
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new ValidationError('reason must be a string');
  }

  // Ownership / existence / shop are read here, before any lock. The status
  // is only used for an early, cheap rejection - the decision is re-made
  // below, under the locks, from the row as it is at that moment.
  const order = await findOwnedOrderOrThrow(userId, orderId);
  assertCancellable(order.orderStatus);

  const trimmedReason = typeof reason === 'string' ? reason.trim() || null : null;

  const updated = await prisma.$transaction(async (tx) => {
    // Lock order: shop -> order -> queue (see orderLocks.ts).
    await lockShop(tx, order.shopId);
    const locked = await lockOrder(tx, orderId);
    assertCancellable(locked.orderStatus);

    await transitionOrder(tx, orderId, locked.orderStatus, 'CANCELLED', {
      cancelledAt: new Date(),
      cancelledReason: trimmedReason,
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        status: 'CANCELLED',
        changedByUserId: userId,
        notes: trimmedReason ?? 'Cancelled by student',
      },
    });

    // A QUEUED order has a WAITING queue entry; cancelling the order must
    // also cancel its place in line. Because the order is locked and was
    // QUEUED (never PRINTING), the entry cannot have started in between.
    await tx.queue.updateMany({
      where: { orderId, queueStatus: 'WAITING' },
      data: { queueStatus: 'CANCELLED', cancelledAt: new Date() },
    });

    return tx.order.findUniqueOrThrow({ where: { orderId }, include: ORDER_INCLUDE });
  });

  return toSafeOrder(updated);
}
