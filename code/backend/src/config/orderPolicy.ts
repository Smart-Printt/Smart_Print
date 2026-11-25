// Business-policy constants for order creation. Plain constants rather than
// env vars - unlike UPLOAD_DIR/MAX_FILE_SIZE_MB (Phase 3), nothing in the
// existing project configures these today, and there's no concrete need yet
// to make them deployment-tunable.
export const MAX_ITEMS_PER_ORDER = 20;
export const MAX_COPIES_PER_ITEM = 100;
export const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 500;

// Statuses from which a student may still cancel their own order. Printing
// has not started for any of these. Deliberately excludes PRINTING, READY,
// COLLECTED, and CANCELLED itself.
export const CANCELLABLE_ORDER_STATUSES = ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED'] as const;

// Phase 6: an order accepts a new payment attempt only while PLACED. Once a
// payment succeeds the order moves to PAYMENT_CONFIRMED and is no longer
// payable - this single check is what stops a second successful charge on
// the same order, on top of the PENDING-payment guard in payment.service.ts.
export const PAYABLE_ORDER_STATUSES = ['PLACED'] as const;

// A refund may only be requested once the order has actually been
// cancelled (via the existing Phase 4 cancellation flow) - refunds are
// never available for an order that is still active or has completed.
export const REFUNDABLE_ORDER_STATUSES = ['CANCELLED'] as const;

export const MAX_REFUND_REASON_LENGTH = 500;

// Queue wait-time prediction (see services/waitModel.ts and
// queue.service.ts). The model is trained on a shop's recently completed
// orders; these only bound how much history it reads and how long a trained
// model is reused before being re-fitted.
export const WAIT_MODEL_LOOKBACK_DAYS = 60;
export const WAIT_MODEL_MAX_TRAINING_ORDERS = 200;
export const WAIT_MODEL_CACHE_MS = 60_000;

// Master switch for wait-time estimates (env WAIT_ESTIMATES_ENABLED, default
// on). Set it to false/0/off/no to stop showing estimates everywhere - e.g.
// if a shop's data looks odd right before a demo. Read at call time so it can
// be flipped without code changes (and tests can toggle it).
export function waitEstimatesEnabled(): boolean {
  const raw = (process.env.WAIT_ESTIMATES_ENABLED ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

// Orders are waiting, nothing is printing, and the shop has shown no activity
// for this long: staff are probably away / not starting the queue. The
// estimate is withheld (it assumes the shop keeps working).
export const STALL_MINUTES = 15;
