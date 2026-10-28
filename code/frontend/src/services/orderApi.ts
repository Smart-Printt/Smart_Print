import { api } from './apiClient'
import type {
  ApiSuccess,
  CreateOrderInput,
  OrderListParams,
  OrderSummary,
  PaginatedOrders,
  SafeOrder,
} from '@/types'

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

  // One page of orders, newest first. Filtering and paging happen on the
  // server; the response says how many orders match in total.
  async list(params: OrderListParams = {}, signal?: AbortSignal): Promise<PaginatedOrders> {
    const query = new URLSearchParams()
    if (params.page) query.set('page', String(params.page))
    if (params.limit) query.set('limit', String(params.limit))
    if (params.status && params.status.length > 0) query.set('status', params.status.join(','))
    if (params.from) query.set('from', params.from)
    if (params.to) query.set('to', params.to)
    if (params.shopId) query.set('shopId', params.shopId)
    if (params.q?.trim()) query.set('q', params.q.trim())
    const qs = query.toString()
    const res = await api.get<ApiSuccess<PaginatedOrders>>(`/orders${qs ? `?${qs}` : ''}`, signal)
    return res.data
  },

  // Admin only: order count and revenue since `from` (an ISO date-time).
  async summary(from: string): Promise<OrderSummary> {
    const res = await api.get<ApiSuccess<OrderSummary>>(`/orders/summary?from=${encodeURIComponent(from)}`)
    return res.data
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
