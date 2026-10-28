import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderStatus, PaginatedOrders, SafeOrder } from '@/types'
import { OrdersPage } from './OrdersPage'

const mockList = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { list: (params: unknown) => mockList(params) },
}))

function order(code: string, status: OrderStatus = 'PLACED'): SafeOrder {
  return {
    orderId: `id-${code}`,
    orderCode: code,
    shopId: 's1',
    shopName: 'G Block Shop',
    customerName: 'Asha',
    customerEmail: 'asha@thapar.edu',
    orderStatus: status,
    totalAmount: '10.00',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    cancelledAt: null,
    cancelledReason: null,
    items: [],
    statusHistory: [],
  }
}

function pageOf(orders: SafeOrder[], page: number, totalPages: number, total: number): PaginatedOrders {
  return { orders, pagination: { page, limit: 10, total, totalPages } }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OrdersPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockList.mockReset()
})

describe('student OrdersPage', () => {
  it('asks the server for the active statuses, first page, 10 per page', async () => {
    mockList.mockResolvedValue(pageOf([order('SP-1')], 1, 1, 1))
    renderPage()

    expect(await screen.findByText('SP-1')).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledWith({
      status: ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY'],
      page: 1,
      limit: 10,
    })
  })

  it('switches tab by asking the server for that tab\'s statuses, back on page 1', async () => {
    mockList.mockResolvedValue(pageOf([], 1, 1, 0))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Nothing here yet')

    await user.click(screen.getByRole('button', { name: 'Cancelled' }))

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith({ status: ['CANCELLED'], page: 1, limit: 10 }),
    )
    expect(await screen.findByText('No cancelled orders')).toBeInTheDocument()
  })

  it('shows a pager and loads the next page', async () => {
    mockList
      .mockResolvedValueOnce(pageOf([order('SP-A')], 1, 2, 11))
      .mockResolvedValueOnce(pageOf([order('SP-B')], 2, 2, 11))
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Page 1 of 2 · 11 orders')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))

    expect(await screen.findByText('SP-B')).toBeInTheDocument()
    expect(screen.queryByText('SP-A')).not.toBeInTheDocument()
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
  })

  it('goes back to page 1 when the tab changes while on page 2', async () => {
    mockList
      .mockResolvedValueOnce(pageOf([order('SP-A')], 1, 2, 11))
      .mockResolvedValueOnce(pageOf([order('SP-B')], 2, 2, 11))
      .mockResolvedValue(pageOf([], 1, 1, 0))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-A')
    await user.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('SP-B')

    await user.click(screen.getByRole('button', { name: 'Completed' }))

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith({ status: ['COLLECTED'], page: 1, limit: 10 }),
    )
  })

  it('shows an error with a retry that loads again', async () => {
    mockList.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(pageOf([order('SP-OK')], 1, 1, 1))
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /try again|retry/i }))

    expect(await screen.findByText('SP-OK')).toBeInTheDocument()
  })
})
