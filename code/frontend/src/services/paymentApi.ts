import { api } from './apiClient'
import type { ApiSuccess, PaymentMethod, SafePayment } from '@/types'
import { ApiError } from '@/types/api'

export const paymentApi = {
  async initiate(orderId: string, paymentMethod: PaymentMethod): Promise<SafePayment> {
    const res = await api.post<ApiSuccess<{ payment: SafePayment }>>(`/orders/${orderId}/payment`, {
      paymentMethod,
    })
    return res.data.payment
  },

  async confirm(orderId: string, simulateOutcome?: 'SUCCESS' | 'FAILED'): Promise<SafePayment> {
    const res = await api.post<ApiSuccess<{ payment: SafePayment }>>(
      `/orders/${orderId}/payment/confirm`,
      simulateOutcome ? { simulateOutcome } : undefined,
    )
    return res.data.payment
  },

  // An order that was never paid (or never even started paying) has no
  // payment record and the backend answers 404. That is a normal "no payment
  // yet" answer, so it resolves to null; any other failure (500, network,
  // 401/403) still throws so callers can surface it.
  async getForOrder(orderId: string): Promise<SafePayment | null> {
    try {
      const res = await api.get<ApiSuccess<{ payment: SafePayment }>>(`/orders/${orderId}/payment`)
      return res.data.payment
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null
      }
      throw err
    }
  },
}
