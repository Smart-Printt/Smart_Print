import { api } from './apiClient'
import type { ApiSuccess, CreateOrderInput, SafeOrder } from '@/types'

export const orderApi = {
  // The same idempotencyKey with the same input returns the order that the
  // first call created instead of creating another, so a retry after a lost
  // response or a double click can never place a duplicate order.
  async create(input: CreateOrderInput, idempotencyKey?: string): Promise<SafeOrder> {
    const res = await api.post<ApiSuccess<{ order: SafeOrder }>>(
      '/orders',
      input,
      undefined,
      idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    )
    return res.data.order
  },

  async list(): Promise<SafeOrder[]> {
    const res = await api.get<ApiSuccess<{ orders: SafeOrder[] }>>('/orders')
    return res.data.orders
  },

  async getOne(orderId: string, signal?: AbortSignal): Promise<SafeOrder> {
    const res = await api.get<ApiSuccess<{ order: SafeOrder }>>(`/orders/${orderId}`, signal)
    return res.data.order
  },

  async cancel(orderId: string, reason?: string): Promise<SafeOrder> {
    const res = await api.patch<ApiSuccess<{ order: SafeOrder }>>(`/orders/${orderId}/cancel`, {
      reason,
    })
    return res.data.order
  },
}
