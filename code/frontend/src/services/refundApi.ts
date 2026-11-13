import { api } from './apiClient'
import type { ApiSuccess, SafeRefund } from '@/types'
import { ApiError } from '@/types/api'

export const refundApi = {
  async request(orderId: string, reason: string): Promise<SafeRefund> {
    const res = await api.post<ApiSuccess<{ refund: SafeRefund }>>(`/orders/${orderId}/refund`, {
      reason,
    })
    return res.data.refund
  },

  async process(orderId: string, simulateOutcome?: 'SUCCESS' | 'FAILED'): Promise<SafeRefund> {
    const res = await api.patch<ApiSuccess<{ refund: SafeRefund }>>(
      `/orders/${orderId}/refund/process`,
      simulateOutcome ? { simulateOutcome } : undefined,
    )
    return res.data.refund
  },

  // Most orders never have a refund, and the backend answers 404 for them.
  // That is a normal "no refund" answer, so it resolves to null; any other
  // failure (500, network, 401/403) still throws so callers can surface it.
  async getForOrder(orderId: string): Promise<SafeRefund | null> {
    try {
      const res = await api.get<ApiSuccess<{ refund: SafeRefund }>>(`/orders/${orderId}/refund`)
      return res.data.refund
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null
      }
      throw err
    }
  },
}
