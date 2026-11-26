export type QueueStatus = 'WAITING' | 'PRINTING' | 'COMPLETED' | 'CANCELLED'

export interface SafeQueueEntry {
  queueId: string
  orderId: string
  orderCode: string
  shopId: string
  queueNumber: number
  queueStatus: QueueStatus
  enteredAt: string
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  position: number | null
  // Predicted whole minutes until printing starts (0 = printing now, null =
  // not waiting). From a model trained on the shop's own completed orders.
  estimatedWaitMinutes: number | null
  // 80% range around the prediction.
  estimatedWaitRange: { low: number; high: number } | null
  estimateBasis: EstimateBasis | null
  // Whether the estimate can be trusted right now. Anything but 'normal'
  // comes with no numbers (a wrong number is worse than none).
  estimateStatus: EstimateStatus | null
}

export type EstimateStatus = 'normal' | 'delayed' | 'stalled' | 'disabled'

export interface EstimateBasis {
  method: 'bayesian-linear-regression'
  // Completed orders the model has learned from; 0 = typical printer speeds.
  trainingOrders: number
  // Leave-one-out error of the model vs. a plain average, in minutes.
  maeMinutes: number | null
  baselineMaeMinutes: number | null
}
