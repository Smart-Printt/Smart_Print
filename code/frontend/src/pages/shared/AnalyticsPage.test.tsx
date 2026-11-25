import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnalyticsReport } from '@/types'
import { ApiError } from '@/types/api'
import { AnalyticsPage } from './AnalyticsPage'

const mockGet = vi.fn()
const mockGetForShop = vi.fn()
vi.mock('@/services/analyticsApi', () => ({
  analyticsApi: {
    get: (days: number) => mockGet(days),
    getForShop: (shopId: string, days: number) => mockGetForShop(shopId, days),
  },
}))

function report(days: number, overrides: Partial<AnalyticsReport['totals']> = {}): AnalyticsReport {
  const daily = Array.from({ length: days }, (_, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    orders: i === days - 1 ? 5 : 1,
    revenue: '10.00',
  }))
  return {
    scope: { type: 'all' },
    range: { days, timezone: 'Asia/Kolkata', from: daily[0]!.date, to: daily[days - 1]!.date },
    totals: {
      orders: 42,
      cancelledOrders: 3,
      paidOrders: 30,
      grossRevenue: '600.00',
      refundedAmount: '40.00',
      netRevenue: '560.00',
      averageOrderValue: '20.00',
      refundRequests: 3,
      refundRate: 0.1,
      medianWaitMinutes: 4.5,
      medianPrintMinutes: 0.4,
      ...overrides,
    },
    daily,
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hour === 14 ? 9 : 1 })),
    shops: [
      { shopId: 's1', shopName: 'G Block Print', orders: 30, revenue: '400.00', medianWaitMinutes: 3 },
      { shopId: 's2', shopName: 'Library Print', orders: 12, revenue: '200.00', medianWaitMinutes: null },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AnalyticsPage (all shops)', () => {
  it('shows the headline numbers with their definitions', async () => {
    mockGet.mockResolvedValue(report(30))
    render(<AnalyticsPage />)

    expect(await screen.findByText('₹560.00')).toBeInTheDocument()
    expect(screen.getByText('₹600.00 paid − ₹40.00 refunded')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('3 cancelled')).toBeInTheDocument()
    expect(screen.getByText('10%')).toBeInTheDocument()
    expect(screen.getByText('4.5 min')).toBeInTheDocument()
    expect(screen.getByText('<1 min')).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledWith(30)
  })

  it('names the busiest hour and lists every shop, including one with no wait data', async () => {
    mockGet.mockResolvedValue(report(30))
    render(<AnalyticsPage />)

    expect(await screen.findByText(/peak is 2 PM \(9 orders\)/)).toBeInTheDocument()
    expect(screen.getAllByText('G Block Print').length).toBeGreaterThan(0)
    expect(screen.getByText('₹200.00 paid · median wait —')).toBeInTheDocument()
  })

  it('refetches when the range changes and marks the active preset', async () => {
    mockGet.mockImplementation((days: number) => Promise.resolve(report(days)))
    const user = userEvent.setup()
    render(<AnalyticsPage />)
    await screen.findByText('₹560.00')

    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }))

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(7))
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows dashes instead of NaN when there is no data yet', async () => {
    mockGet.mockResolvedValue(
      report(7, {
        orders: 0,
        cancelledOrders: 0,
        paidOrders: 0,
        grossRevenue: '0.00',
        refundedAmount: '0.00',
        netRevenue: '0.00',
        averageOrderValue: null,
        refundRequests: 0,
        refundRate: null,
        medianWaitMinutes: null,
        medianPrintMinutes: null,
      }),
    )
    render(<AnalyticsPage />)

    expect(await screen.findByText(/No orders in this period yet/)).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4)
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })

  it('offers every chart as a table too', async () => {
    mockGet.mockResolvedValue(report(7))
    render(<AnalyticsPage />)
    await screen.findByText('₹560.00')
    expect(screen.getAllByText('View as table')).toHaveLength(3)
  })

  it('shows an error state with retry when the first load fails', async () => {
    mockGet.mockRejectedValueOnce(new ApiError(500, 'Boom'))
    mockGet.mockResolvedValue(report(30))
    const user = userEvent.setup()
    render(<AnalyticsPage />)

    const retry = await screen.findByRole('button', { name: /try again|retry/i })
    await user.click(retry)
    expect(await screen.findByText('₹560.00')).toBeInTheDocument()
  })
})

describe('AnalyticsPage (one shop, for its staff)', () => {
  function shopReport(days: number): AnalyticsReport {
    const base = report(days)
    return {
      ...base,
      scope: { type: 'shop', shopId: 'shop-cos', shopName: 'COS Shop' },
      shops: [{ shopId: 'shop-cos', shopName: 'COS Shop', orders: 42, revenue: '600.00', medianWaitMinutes: 4.5 }],
    }
  }

  it('asks for that shop only and never touches the all-shops endpoint', async () => {
    mockGetForShop.mockImplementation((_id: string, days: number) => Promise.resolve(shopReport(days)))
    render(<AnalyticsPage shopId="shop-cos" />)

    expect(await screen.findByText('₹560.00')).toBeInTheDocument()
    expect(mockGetForShop).toHaveBeenCalledWith('shop-cos', 30)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('names the shop and hides the cross-shop comparison', async () => {
    mockGetForShop.mockResolvedValue(shopReport(30))
    render(<AnalyticsPage shopId="shop-cos" />)

    expect(await screen.findByText(/COS Shop — orders, revenue and waiting times for your shop/)).toBeInTheDocument()
    expect(screen.queryByText('Shop load')).not.toBeInTheDocument()
    // Orders per day, Busiest hours - and no third (shop) table.
    expect(screen.getAllByText('View as table')).toHaveLength(2)
  })

  it('keeps the same range presets and refetches for the same shop', async () => {
    mockGetForShop.mockImplementation((_id: string, days: number) => Promise.resolve(shopReport(days)))
    const user = userEvent.setup()
    render(<AnalyticsPage shopId="shop-cos" />)
    await screen.findByText('₹560.00')

    await user.click(screen.getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() => expect(mockGetForShop).toHaveBeenCalledWith('shop-cos', 7))
  })
})
