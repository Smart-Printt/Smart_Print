import { QueueStatus } from '@prisma/client';

export { QueueStatus };

// Safe, API-facing shape. position is always derived (never stored) - see
// queue.service.ts computePosition. null when the entry is not WAITING
// (PRINTING is reported as position 0 - "being printed right now"; a
// COMPLETED/CANCELLED entry has no meaningful position).
export interface SafeQueueEntry {
  queueId: string;
  orderId: string;
  orderCode: string;
  shopId: string;
  queueNumber: number;
  queueStatus: QueueStatus;
  enteredAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  position: number | null;
  // Predicted whole minutes until this order starts printing: 0 when it is
  // already printing, null when the entry is not WAITING/PRINTING. Produced
  // by a model trained on the shop's own completed orders - an estimate, not
  // a promise (see services/waitModel.ts).
  estimatedWaitMinutes: number | null;
  // 80% range around the estimate, from the model's own uncertainty.
  estimatedWaitRange: { low: number; high: number } | null;
  // What the estimate is based on, so the UI can be honest about it.
  estimateBasis: EstimateBasis | null;
  // Whether the estimate can be trusted right now. When it is not 'normal'
  // the numbers above are null: showing none beats showing a wrong one.
  //  normal   - estimate shown
  //  delayed  - the order printing now is running far longer than predicted
  //  stalled  - orders are waiting but the shop has not started printing
  //  disabled - estimates are switched off (WAIT_ESTIMATES_ENABLED=false)
  // null when the entry is not WAITING/PRINTING.
  estimateStatus: EstimateStatus | null;
}

export type EstimateStatus = 'normal' | 'delayed' | 'stalled' | 'disabled';

export interface EstimateBasis {
  method: 'bayesian-linear-regression';
  // Completed orders the model has learned from (0 = typical printer speeds).
  trainingOrders: number;
  // Leave-one-out error of the model vs. a plain-average baseline, in
  // minutes; null until there are enough orders to measure.
  maeMinutes: number | null;
  baselineMaeMinutes: number | null;
}
