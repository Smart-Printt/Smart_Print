import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SafeOrder, SafePayment } from '@/types'
import { ApiError } from '@/types/api'
import { StepPayment } from './StepPayment'

const mockInitiate = vi.fn()
const mockConfirm = vi.fn()
const mockGetForOrder = vi.fn()
vi.mock('@/services/paymentApi', () => ({
  paymentApi: {
    initiate: (...args: unknown[]) => mockInitiate(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
    getForOrder: (...args: unknown[]) => mockGetForOrder(...args),
  },
}))

const mockGetOne = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { getOne: (id: string) => mockGetOne(id) },
}))

const mockOpenCheckout = vi.fn()
vi.mock('@/utils/razorpayCheckout', () => {
  class CheckoutClosedError extends Error {}
  return { CheckoutClosedError, openRazorpayCheckout: (...args: unknown[]) => mockOpenCheckout(...args) }
})

const ORDER: SafeOrder = {
  orderId: 'o1',
  orderCode: 'SP-1',
  shopId: 's1',
  shopName: 'Shop',
  customerName: 'Stu',
  customerEmail: 'stu@thapar.edu',
  orderStatus: 'PLACED',
  totalAmount: '20.00',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cancelledAt: null,
  cancelledReason: null,
  items: [],
  statusHistory: [],
}

const CHECKOUT = { provider: 'razorpay' as const, keyId: 'rzp_test_x', gatewayOrderId: 'order_1', amount: 2000, currency: 'INR' }

function payment(extra: Partial<SafePayment> = {}): SafePayment {
  return {
    paymentId: 'p1',
    orderId: 'o1',
    amount: '20.00',
    paymentMethod: 'UPI',
    transactionId: 'order_1',
    paymentStatus: 'PENDING',
    createdAt: '2026-01-01T00:00:00.000Z',
    paidAt: null,
    ...extra,
  }
}

const RESULT = { razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig' }

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOne.mockResolvedValue({ ...ORDER, orderStatus: 'QUEUED' })
  mockConfirm.mockResolvedValue(payment({ paymentStatus: 'SUCCESS' }))
})

async function pay() {
  const onPaid = vi.fn()
  render(<StepPayment order={ORDER} onPaid={onPaid} onBack={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: /pay/i }))
  return onPaid
}

describe('StepPayment with Razorpay', () => {
  it('opens Razorpay Checkout and confirms with its signed result', async () => {
    mockInitiate.mockResolvedValue(payment({ checkout: CHECKOUT }))
    mockOpenCheckout.mockResolvedValue(RESULT)

    const onPaid = await pay()

    await waitFor(() => expect(onPaid).toHaveBeenCalled())
    expect(mockOpenCheckout).toHaveBeenCalledWith(expect.objectContaining({ checkout: CHECKOUT }))
    expect(mockConfirm).toHaveBeenCalledWith('o1', RESULT)
  })

  it('reuses the pending payment when one was already started', async () => {
    mockInitiate.mockRejectedValue(new ApiError(409, 'A payment is already in progress for this order'))
    mockGetForOrder.mockResolvedValue(payment({ checkout: CHECKOUT }))
    mockOpenCheckout.mockResolvedValue(RESULT)

    const onPaid = await pay()

    await waitFor(() => expect(onPaid).toHaveBeenCalled())
    expect(mockGetForOrder).toHaveBeenCalledWith('o1')
  })

  it('explains that nothing was charged when the window is closed', async () => {
    const { CheckoutClosedError } = await import('@/utils/razorpayCheckout')
    mockInitiate.mockResolvedValue(payment({ checkout: CHECKOUT }))
    mockOpenCheckout.mockRejectedValue(new CheckoutClosedError())

    const onPaid = await pay()

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was charged/i)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(onPaid).not.toHaveBeenCalled()
  })
})

describe('StepPayment with the mock provider', () => {
  it('confirms directly when there is no checkout window', async () => {
    mockInitiate.mockResolvedValue(payment())

    const onPaid = await pay()

    await waitFor(() => expect(onPaid).toHaveBeenCalled())
    expect(mockOpenCheckout).not.toHaveBeenCalled()
    expect(mockConfirm).toHaveBeenCalledWith('o1', undefined)
  })
})
