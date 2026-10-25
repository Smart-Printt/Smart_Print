import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/types/api'
import { refundApi } from './refundApi'

const REFUND = {
  refundId: 'r1',
  orderId: 'o1',
  paymentId: 'p1',
  refundAmount: '25',
  refundReason: 'Cancelled',
  refundStatus: 'REQUESTED',
  refundTransactionId: 'RFD-1',
  requestedAt: '2026-01-01T00:00:00.000Z',
  processedAt: null,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('refundApi.getForOrder', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('returns the refund when one exists', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: { refund: REFUND } }))
    await expect(refundApi.getForOrder('o1')).resolves.toEqual(REFUND)
  })

  it('treats 404 as "no refund" and resolves null instead of throwing', async () => {
    fetchMock.mockResolvedValue(json(404, { success: false, message: 'No refund found for this order' }))
    await expect(refundApi.getForOrder('o1')).resolves.toBeNull()
  })

  it.each([500, 502, 401, 403])('does NOT swallow a genuine %s error', async (status) => {
    fetchMock.mockResolvedValue(json(status, { success: false, message: 'nope' }))
    const err = await refundApi.getForOrder('o1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
  })

  it('does NOT swallow a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const err = await refundApi.getForOrder('o1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })
})
