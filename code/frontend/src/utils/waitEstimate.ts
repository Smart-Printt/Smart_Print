import type { EstimateBasis, EstimateStatus } from '@/types'

// Plain-language footnote about what a queue wait estimate is built on, so the
// student knows whether it is a guess from typical speeds or learned from
// this shop's own completed orders.
export function estimateNote(basis: EstimateBasis | null): string {
  if (!basis) return 'Wait is an estimate.'
  if (basis.trainingOrders === 0) {
    return 'AI estimate from typical print speeds — it gets sharper as this shop completes orders.'
  }
  const accuracy = basis.maeMinutes !== null ? `, typically within ±${basis.maeMinutes} min` : ''
  const noun = basis.trainingOrders === 1 ? 'order' : 'orders'
  return `AI estimate learned from ${basis.trainingOrders} recent ${noun} at this shop${accuracy}.`
}

export interface EstimateNotice {
  title: string
  body: string
}

// When the estimate cannot be trusted the page shows this INSTEAD of a number.
// 'normal', 'disabled' and null show no notice (disabled simply hides the
// estimate; position and token still work).
export function estimateNotice(status: EstimateStatus | null): EstimateNotice | null {
  switch (status) {
    case 'delayed':
      return {
        title: 'Taking longer than usual',
        body: 'The printer at this shop is running behind, so we can’t give a reliable wait time. This page updates by itself as soon as it moves.',
      }
    case 'stalled':
      return {
        title: 'Waiting for the shop to start',
        body: 'Orders are waiting but the shop hasn’t started printing yet. Your place in the queue is unchanged — we’ll show a wait time once printing resumes.',
      }
    default:
      return null
  }
}
