import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderStatus, SafeOrder, SafePayment } from '@/types'
import { ApiError } from '@/types/api'
import { OrderDetailsPage } from './OrderDetailsPage'

// Payment resumption: a student who left the print flow (closed the tab, hit
// Back) with an unpaid order must be able to pay it from the order page - using
// the SAME order (no new order, so no new Idempotency-Key) and only the mock
// payment provider behind paymentApi.

const mockGetOne = vi.fn()
const mockCreate = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { getOne: (id: string) => mockGetOne(id), cancel: vi.fn(), create: (...a: unknown[]) => mockCreate(...a) },
}))

const mockPaymentGet = vi.fn()
const mockInitiate = vi.fn()
const mockConfirm = vi.fn()
vi.mock('@/services/paymentApi', () => ({
  paymentApi: {
    getForOrder: (id: string) => mockPaymentGet(id),
    initiate: (id: string, method: string) => mockInitiate(id, method),
    confirm: (id: string, outcome?: string) => mockConfirm(id, outcome),
  },
}))

vi.mock('@/services/queueApi', () => ({ queueApi: { getForOrder: vi.fn().mockResolvedValue(null) } }))

const mockRefundGet = vi.fn()
vi.mock('@/services/refundApi', () => ({ refundApi: { getForOrder: (id: string) => mockRefundGet(id), request: vi.fn() } }))

const mockShowToast = vi.fn()
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ showToast: mockShowToast }) }))

function makeOrder(orderStatus: OrderStatus, overrides: Partial<SafeOrder> = {}): SafeOrder {
  return {
    orderId: 'order-1',
    orderCode: 'SP-TEST-1',
    shopId: 'shop-1',
    shopName: 'G Block Print Shop',
    customerName: 'Jane',
    customerEmail: 'jane@thapar.edu',
    orderStatus,
    totalAmount: '25',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
    cancelledReason: null,
    items: [],
    statusHistory: [{ status: 'PLACED', changedByUserId: 'u1', changedAt: '2026-01-01T00:00:00.000Z', notes: null }],
    ...overrides,
  }
}

function payment(paymentStatus: SafePayment['paymentStatus']): SafePayment {
  return {
    paymentId: 'pay-1', orderId: 'order-1', amount: '25', paymentMethod: 'UPI', transactionId: 'TXN-1',
    paymentStatus, createdAt: '2026-01-01T00:00:00.000Z', paidAt: paymentStatus === 'SUCCESS' ? '2026-01-01T00:00:00.000Z' : null,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/orders/order-1']}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderDetailsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

const payNow = () => screen.queryByRole('button', { name: /^pay now$/i })
const retryPayment = () => screen.queryByRole('button', { name: /^retry payment$/i })

// The order is PLACED until a payment "succeeds", after which every read says QUEUED.
function backendWhereOrderBecomesQueuedAfterPayment() {
  let paid = false
  mockGetOne.mockImplementation(() => Promise.resolve(makeOrder(paid ? 'QUEUED' : 'PLACED')))
  mockConfirm.mockImplementation((_id: string, outcome?: string) => {
    if (outcome !== 'FAILED') paid = true
    return Promise.resolve(payment(outcome === 'FAILED' ? 'FAILED' : 'SUCCESS'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPaymentGet.mockResolvedValue(null) // no payment yet (what paymentApi returns for a 404)
  mockRefundGet.mockResolvedValue(null)
  mockInitiate.mockResolvedValue(payment('PENDING'))
})

describe('OrderDetailsPage - Pay action', () => {
  it('offers "Pay now" for an unpaid (PLACED) order', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(payNow()).toBeInTheDocument()
    expect(mockInitiate).not.toHaveBeenCalled() // nothing is charged until the student confirms
  })

  it.each<OrderStatus>(['PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY', 'COLLECTED'])(
    'does not offer payment for an already-paid %s order',
    async (status) => {
      mockGetOne.mockResolvedValue(makeOrder(status))
      mockPaymentGet.mockResolvedValue(payment('SUCCESS'))
      renderPage()
      await screen.findByText('SP-TEST-1')
      expect(payNow()).not.toBeInTheDocument()
      expect(retryPayment()).not.toBeInTheDocument()
    },
  )

  it('does not offer payment for a cancelled order', async () => {
    mockGetOne.mockResolvedValue(makeOrder('CANCELLED'))
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(payNow()).not.toBeInTheDocument()
    expect(retryPayment()).not.toBeInTheDocument()
  })

  it('does not offer payment for a free (faculty) order', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED', { totalAmount: '0' }))
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(payNow()).not.toBeInTheDocument()
  })

  it('labels the action "Retry payment" when the latest payment attempt FAILED', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockPaymentGet.mockResolvedValue(payment('FAILED'))
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(await screen.findByRole('button', { name: /^retry payment$/i })).toBeInTheDocument()
    expect(payNow()).not.toBeInTheDocument()
  })
})

describe('OrderDetailsPage - resuming payment', () => {
  it('pays the SAME order through the mock provider: initiate -> confirm -> QUEUED, never creating an order', async () => {
    backendWhereOrderBecomesQueuedAfterPayment()
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Amount to pay')).toBeInTheDocument()
    expect(within(dialog).getByText(/No real money is charged/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Payment confirmed.', 'success'))
    expect(mockInitiate).toHaveBeenCalledTimes(1)
    expect(mockInitiate).toHaveBeenCalledWith('order-1', 'UPI')
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(mockConfirm).toHaveBeenCalledWith('order-1', undefined)
    expect(mockCreate).not.toHaveBeenCalled() // no new order => no new idempotency key
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(payNow()).not.toBeInTheDocument() // now QUEUED: nothing left to pay
  })

  it('a payment failure keeps the order unpaid, shows the error, and does not create an order', async () => {
    backendWhereOrderBecomesQueuedAfterPayment()
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('checkbox', { name: /simulate a failed payment/i }))
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    expect(await within(dialog).findByText('Payment failed. Please try again.')).toBeInTheDocument()
    expect(mockConfirm).toHaveBeenCalledWith('order-1', 'FAILED')
    expect(mockShowToast).not.toHaveBeenCalledWith('Payment confirmed.', 'success')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('after a failure the student can retry on the same order and succeed (safe retry)', async () => {
    backendWhereOrderBecomesQueuedAfterPayment()
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('checkbox', { name: /simulate a failed payment/i }))
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))
    await within(dialog).findByText('Payment failed. Please try again.')

    await user.click(within(dialog).getByRole('checkbox', { name: /simulate a failed payment/i })) // untick
    await user.click(within(dialog).getByRole('button', { name: /retry payment/i }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Payment confirmed.', 'success'))
    expect(mockInitiate).toHaveBeenCalledTimes(2)
    expect(mockInitiate).toHaveBeenNthCalledWith(2, 'order-1', 'UPI') // the same order both times
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('resumes a payment that was started but never confirmed: "already in progress" (409) still confirms it', async () => {
    backendWhereOrderBecomesQueuedAfterPayment()
    mockInitiate.mockRejectedValue(new ApiError(409, 'A payment is already in progress for this order'))
    mockPaymentGet.mockResolvedValue(payment('PENDING'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledWith('order-1', undefined))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Payment confirmed.', 'success'))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not try to confirm when starting the payment fails for another reason (e.g. 500)', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockInitiate.mockRejectedValue(new ApiError(500, 'Internal server error'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    expect(await within(dialog).findByText('Payment failed. Please try again.')).toBeInTheDocument()
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('an order that is no longer payable (conflict on both calls) ends in the failure message, not a crash', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockInitiate.mockRejectedValue(new ApiError(409, 'Order cannot be paid while it is CANCELLED'))
    mockConfirm.mockRejectedValue(new ApiError(404, 'No pending payment found for this order'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    expect(await within(dialog).findByText('Payment failed. Please try again.')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('Payment confirmed.', 'success')
  })

  it('Back closes the payment dialog without charging or creating anything', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^back$/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockInitiate).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(payNow()).toBeInTheDocument() // still unpaid, can resume again later
  })

  it('does not double-submit: the pay controls are replaced by a progress state while processing', async () => {
    let finish!: () => void
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockConfirm.mockReturnValue(new Promise<SafePayment>((resolve) => { finish = () => resolve(payment('SUCCESS')) }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('SP-TEST-1')

    await user.click(payNow()!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^pay /i }))

    expect(await within(dialog).findByText('Processing payment…')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^pay /i })).not.toBeInTheDocument()
    expect(mockInitiate).toHaveBeenCalledTimes(1)
    finish()
  })
})

describe('OrderDetailsPage - optional payment lookup', () => {
  const paymentCard = () => screen.queryByText(/UPI · /)
  const loadFailedNotice = () => screen.queryByText(/couldn't load the payment details/i)

  it('no payment yet (null): no payment card and no error notice, and payment can still be started', async () => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockPaymentGet.mockResolvedValue(null)
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(mockPaymentGet).toHaveBeenCalledWith('order-1')
    expect(paymentCard()).not.toBeInTheDocument()
    expect(loadFailedNotice()).not.toBeInTheDocument()
    expect(payNow()).toBeInTheDocument()
  })

  it('an existing payment is shown', async () => {
    mockGetOne.mockResolvedValue(makeOrder('QUEUED'))
    mockPaymentGet.mockResolvedValue(payment('SUCCESS'))
    renderPage()
    expect(await screen.findByText(/UPI · SUCCESS/)).toBeInTheDocument()
    expect(loadFailedNotice()).not.toBeInTheDocument()
  })

  it('does not look up a payment for a free order (it can never have one)', async () => {
    mockGetOne.mockResolvedValue(makeOrder('QUEUED', { totalAmount: '0' }))
    renderPage()
    await screen.findByText('SP-TEST-1')
    expect(mockPaymentGet).not.toHaveBeenCalled()
  })

  it.each([
    ['server error (500)', new ApiError(500, 'Internal server error')],
    ['network failure', new ApiError(0, 'Connection lost.')],
  ])('does NOT hide a %s: tells the student the payment details could not be loaded', async (_label, err) => {
    mockGetOne.mockResolvedValue(makeOrder('PLACED'))
    mockPaymentGet.mockRejectedValue(err)
    renderPage()
    expect(await screen.findByText(/couldn't load the payment details/i)).toBeInTheDocument()
    expect(payNow()).toBeInTheDocument() // the order itself is still payable
  })
})
