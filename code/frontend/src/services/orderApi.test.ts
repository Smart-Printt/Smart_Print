import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { orderApi } from './orderApi'

const INPUT = {
  shopId: 'shop-1',
  items: [{ documentId: 'doc-1', copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
} as Parameters<typeof orderApi.create>[0]

describe('orderApi.create', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { order: { orderId: 'o-1' } } }), { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('sends the Idempotency-Key header when given a key', async () => {
    await orderApi.create(INPUT, 'key-12345678')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('key-12345678')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(INPUT)
  })

  it('sends no Idempotency-Key header without a key', async () => {
    await orderApi.create(INPUT)
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeUndefined()
  })
})
