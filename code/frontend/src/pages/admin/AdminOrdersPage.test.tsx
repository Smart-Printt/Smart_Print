import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaginatedOrders } from '@/types'
import { AdminOrdersPage } from './AdminOrdersPage'

const mockList = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { list: (params: unknown) => mockList(params) },
}))

const EMPTY: PaginatedOrders = { orders: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } }

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue(EMPTY)
})

describe('AdminOrdersPage', () => {
  it('starts with all statuses, page 1, 20 per page', async () => {
    render(<AdminOrdersPage />)
    await screen.findByText('No orders found')
    expect(mockList).toHaveBeenCalledWith({ page: 1, limit: 20 })
  })

  it('filters by status on the server', async () => {
    const user = userEvent.setup()
    render(<AdminOrdersPage />)
    await screen.findByText('No orders found')

    await user.click(screen.getByRole('button', { name: 'READY' }))

    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ page: 1, limit: 20, status: ['READY'] }))
  })

  it('searches by order code after the typing pauses, not on every keystroke', async () => {
    const user = userEvent.setup()
    render(<AdminOrdersPage />)
    await screen.findByText('No orders found')
    mockList.mockClear()

    await user.type(screen.getByLabelText('Search by order code'), 'SP-9')

    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ page: 1, limit: 20, q: 'SP-9' }))
    expect(mockList.mock.calls.filter(([params]) => (params as { q?: string }).q === 'S')).toHaveLength(0)
  })

  it('shows the pager and requests the next page', async () => {
    mockList.mockResolvedValueOnce({
      orders: [
        {
          orderId: 'o1',
          orderCode: 'SP-ONE',
          shopId: 's1',
          shopName: 'Shop',
          customerName: 'A',
          customerEmail: 'a@x.edu',
          orderStatus: 'PLACED',
          totalAmount: '5.00',
          createdAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          cancelledAt: null,
          cancelledReason: null,
          items: [],
          statusHistory: [],
        },
      ],
      pagination: { page: 1, limit: 20, total: 45, totalPages: 3 },
    })
    const user = userEvent.setup()
    render(<AdminOrdersPage />)

    expect(await screen.findByText('Page 1 of 3 · 45 orders')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))

    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ page: 2, limit: 20 }))
  })
})
