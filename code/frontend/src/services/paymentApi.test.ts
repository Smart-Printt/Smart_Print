import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/types/api'
import { paymentApi } from './paymentApi'

const PAYMENT = {
  paymentId: 'p1',
  orderId: 'o1',
  amount: '25',
  paymentMethod: 'UPI',
  transactionId: 'TXN-1',
  paymentStatus: 'SUCCESS',
  createdAt: '2026-01-01T00:00:00.000Z',
  paidAt: '2026-01-01T00:00:00.000Z',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('paymentApi.getForOrder', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('returns the payment when the order has one', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: { payment: PAYMENT } }))
    await expect(paymentApi.getForOrder('o1')).resolves.toEqual(PAYMENT)
  })

  it('treats 404 as "no payment yet" and resolves null instead of throwing', async () => {
    fetchMock.mockResolvedValue(json(404, { success: false, message: 'No payment found for this order' }))
    await expect(paymentApi.getForOrder('o1')).resolves.toBeNull()
  })

  it.each([500, 502, 401, 403])('does NOT swallow a genuine %s error', async (status) => {
    fetchMock.mockResolvedValue(json(status, { success: false, message: 'nope' }))
    const err = await paymentApi.getForOrder('o1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
  })

  it('does NOT swallow a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const err = await paymentApi.getForOrder('o1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('asks for the right endpoint, once', async () => {
    fetchMock.mockResolvedValue(json(404, { success: false, message: 'none' }))
    await paymentApi.getForOrder('order-xyz')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/orders\/order-xyz\/payment$/)
  })
})
