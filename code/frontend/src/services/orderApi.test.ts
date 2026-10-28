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

describe('orderApi.list and summary', () => {
  const fetchMock = vi.fn()
  const PAGE = {
    orders: [],
    pagination: { page: 2, limit: 10, total: 25, totalPages: 3 },
  }

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: PAGE }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('asks for /orders with no query string when no params are given', async () => {
    await orderApi.list()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/orders')
  })

  it('turns params into a query string, joining statuses with commas', async () => {
    const result = await orderApi.list({
      page: 2,
      limit: 10,
      status: ['READY', 'COLLECTED'],
      from: '2026-01-01',
      to: '2026-02-01',
      shopId: 'shop-1',
      q: '  SP-12  ',
    })

    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(url.pathname).toBe('/api/orders')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      limit: '10',
      status: 'READY,COLLECTED',
      from: '2026-01-01',
      to: '2026-02-01',
      shopId: 'shop-1',
      q: 'SP-12',
    })
    expect(result.pagination.total).toBe(25)
  })

  it('leaves out empty params', async () => {
    await orderApi.list({ status: [], q: '   ' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/orders')
  })

  it('fetches the summary since a date', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { orderCount: 3, revenue: '45.00' } }), { status: 200 }),
    )
    await expect(orderApi.summary('2026-10-28T00:00:00.000Z')).resolves.toEqual({ orderCount: 3, revenue: '45.00' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/orders/summary?from=2026-10-28T00%3A00%3A00.000Z')
  })
})
