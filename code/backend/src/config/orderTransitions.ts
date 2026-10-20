import { OrderStatus } from '@prisma/client';

// The only legal order status transitions. Every status write goes through
// services/orderLocks.ts::transitionOrder, which checks this table and then
// performs the update conditionally on the expected current status.
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // PLACED -> QUEUED directly: free faculty orders skip payment.
  PLACED: ['PAYMENT_CONFIRMED', 'QUEUED', 'CANCELLED'],
  PAYMENT_CONFIRMED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PRINTING', 'CANCELLED'],
  PRINTING: ['READY'],
  READY: ['COLLECTED'],
  COLLECTED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
