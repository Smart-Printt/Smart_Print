import { EventEmitter } from 'node:events';

// In-process pub/sub that tells live queue streams "something changed at
// this shop". It carries no data on purpose - each subscriber re-reads its
// own order's queue entry from the database (through the normal access
// checks), so an event can never leak another student's information.
//
// Limitation: this only reaches streams held by the SAME Node process. If
// the API is ever run as several instances, replace this module with
// PostgreSQL LISTEN/NOTIFY or Redis pub/sub - callers only use the two
// functions below, so nothing else would need to change.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const channel = (shopId: string): string => `shop-queue:${shopId}`;

// Call AFTER the database transaction that changed the queue has committed,
// otherwise a subscriber could re-read the old state.
export function publishShopQueueChanged(shopId: string): void {
  try {
    bus.emit(channel(shopId));
  } catch {
    // A misbehaving subscriber must never fail the payment/queue/cancel
    // request that triggered the notification.
  }
}

export function subscribeToShopQueue(shopId: string, listener: () => void): () => void {
  const name = channel(shopId);
  bus.on(name, listener);
  return () => {
    bus.off(name, listener);
  };
}
