import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { OrderStatus, SafeOrder, SafeOrderItem } from '@/types'
import { ApiError } from '@/types/api'
import { StaffOrderDetailsPage } from './StaffOrderDetailsPage'

const mockGetOne = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { getOne: (id: string) => mockGetOne(id) },
}))

const mockQueueGetForOrder = vi.fn()
const mockCollect = vi.fn()
vi.mock('@/services/queueApi', () => ({
  queueApi: { getForOrder: (id: string) => mockQueueGetForOrder(id), collect: (id: string) => mockCollect(id) },
}))

const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }))

const mockPaymentGetForOrder = vi.fn()
vi.mock('@/services/paymentApi', () => ({
  paymentApi: { getForOrder: (id: string) => mockPaymentGetForOrder(id) },
}))

const mockRefundGetForOrder = vi.fn()
vi.mock('@/services/refundApi', () => ({
  refundApi: { getForOrder: (id: string) => mockRefundGetForOrder(id) },
}))

vi.mock('@/services/shopQueueApi', () => ({
  shopQueueApi: { startNext: vi.fn(), complete: vi.fn() },
}))

const mockDownload = vi.fn()
const mockView = vi.fn()
vi.mock('@/services/documentApi', () => ({
  documentApi: {
    download: (id: string, fileName: string) => mockDownload(id, fileName),
    view: (id: string) => mockView(id),
  },
}))

const mockShowToast = vi.fn()
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

function makeItem(overrides: Partial<SafeOrderItem>): SafeOrderItem {
  return {
    orderDocumentId: `od-${overrides.documentId}`,
    documentId: 'doc-1',
    fileName: 'file.pdf',
    printType: 'BW',
    paperSize: 'A4',
    sides: 'SINGLE',
    copies: 1,
    pageRange: null,
    printPageCount: 5,
    finishingType: null,
    specialInstructions: null,
    pricePerPage: '5',
    finishingPrice: '0',
    lineTotal: '25',
    ...overrides,
  }
}

function makeOrder(items: SafeOrderItem[], overrides: Partial<SafeOrder> = {}): SafeOrder {
  return {
    orderId: 'order-1',
    orderCode: 'SP-TEST-1',
    shopId: 'shop-1',
    shopName: 'G Block Print Shop',
    customerName: 'Jane Doe',
    customerEmail: 'jane@thapar.edu',
    orderStatus: 'READY',
    totalAmount: '25',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancelledAt: null,
    cancelledReason: null,
    items,
    statusHistory: [
      { status: 'PLACED', changedByUserId: 'u1', changedAt: new Date().toISOString(), notes: null },
    ],
    ...overrides,
  }
}

function renderPage(orderId = 'order-1') {
  return render(
    <MemoryRouter initialEntries={[`/staff/orders/${orderId}`]}>
      <Routes>
        <Route path="/staff/orders/:orderId" element={<StaffOrderDetailsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQueueGetForOrder.mockRejectedValue(new Error('no queue entry'))
  mockPaymentGetForOrder.mockResolvedValue(null) // no payment yet (what paymentApi returns for a 404)
  mockRefundGetForOrder.mockRejectedValue(new Error('no refund'))
  mockCollect.mockResolvedValue(undefined)
  mockUseAuth.mockReturnValue({ user: { userId: 'staff-1', role: 'SHOP_STAFF', shopId: 'shop-1' } })
})

describe('StaffOrderDetailsPage document view/download', () => {
  it('renders every document in the order, keyed by its real documentId', async () => {
    const order = makeOrder([
      makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' }),
      makeItem({ documentId: 'doc-b', fileName: 'notes.docx' }),
    ])
    mockGetOne.mockResolvedValue(order)

    renderPage()

    expect(await screen.findByText('assignment.pdf')).toBeInTheDocument()
    expect(screen.getByText('notes.docx')).toBeInTheDocument()
    expect(screen.getByText('Documents (2)')).toBeInTheDocument()
  })

  it('renders a View and Download button for each document', async () => {
    const order = makeOrder([
      makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' }),
      makeItem({ documentId: 'doc-b', fileName: 'notes.docx' }),
    ])
    mockGetOne.mockResolvedValue(order)

    renderPage()

    await screen.findByText('assignment.pdf')
    expect(screen.getAllByRole('button', { name: /^view$/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^download$/i })).toHaveLength(2)
  })

  it('clicking Download calls documentApi.download with the real documentId, not the orderDocumentId', async () => {
    const order = makeOrder([makeItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'assignment.pdf' })])
    mockGetOne.mockResolvedValue(order)
    mockDownload.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('assignment.pdf')
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-a', 'assignment.pdf'))
    expect(mockDownload).not.toHaveBeenCalledWith('od-a', expect.anything())
  })

  it('clicking View calls documentApi.view with the documentId and renders the preview once the blob resolves', async () => {
    const order = makeOrder([makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    mockGetOne.mockResolvedValue(order)
    const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' })
    mockView.mockResolvedValue(blob)

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('assignment.pdf')
    await user.click(screen.getByRole('button', { name: /^view$/i }))

    await waitFor(() => expect(mockView).toHaveBeenCalledWith('doc-a'))
    await waitFor(() => {
      const obj = document.querySelector('object[type="application/pdf"]')
      expect(obj).toBeTruthy()
      expect(obj?.getAttribute('data')).toMatch(/^blob:/)
    })
  })

  it('shows a fallback message for non-PDF files instead of attempting a blob preview', async () => {
    const order = makeOrder([makeItem({ documentId: 'doc-a', fileName: 'notes.docx' })])
    mockGetOne.mockResolvedValue(order)

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('notes.docx')
    await user.click(screen.getByRole('button', { name: /^view$/i }))

    expect(await screen.findByText('Preview unavailable for this file type.')).toBeInTheDocument()
    expect(mockView).not.toHaveBeenCalled()
  })

  it('shows an error message in the preview modal when the view request fails', async () => {
    const order = makeOrder([makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    mockGetOne.mockResolvedValue(order)
    mockView.mockRejectedValue(new Error('403'))

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('assignment.pdf')
    await user.click(screen.getByRole('button', { name: /^view$/i }))

    expect(await screen.findByText('Unable to preview this document.')).toBeInTheDocument()
  })

  it('shows a toast error when download fails, without crashing', async () => {
    const order = makeOrder([makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    mockGetOne.mockResolvedValue(order)
    mockDownload.mockRejectedValue(new Error('network error'))

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('assignment.pdf')
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not download this file.', 'error'))
  })

  it('renders all documents in a multi-document order and binds each row to its own documentId (not the first row for every button)', async () => {
    const order = makeOrder([
      makeItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'a.pdf' }),
      makeItem({ documentId: 'doc-b', orderDocumentId: 'od-b', fileName: 'b.pdf' }),
      makeItem({ documentId: 'doc-c', orderDocumentId: 'od-c', fileName: 'c.pdf' }),
    ])
    mockGetOne.mockResolvedValue(order)
    mockDownload.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('a.pdf')
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
    expect(screen.getByText('c.pdf')).toBeInTheDocument()

    const downloadButtons = screen.getAllByRole('button', { name: /^download$/i })
    expect(downloadButtons).toHaveLength(3)

    await user.click(downloadButtons[1]!)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-b', 'b.pdf'))

    await user.click(downloadButtons[2]!)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-c', 'c.pdf'))

    await user.click(downloadButtons[0]!)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-a', 'a.pdf'))

    expect(mockDownload).toHaveBeenCalledTimes(3)
  })
})

const collectButton = () => screen.queryByRole('button', { name: /mark as collected/i })
const oneItem = () => [makeItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })]

describe('StaffOrderDetailsPage - Collect action', () => {
  it('shows "Mark as Collected" for a READY order viewed by shop staff', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    renderPage()
    await screen.findByText('assignment.pdf')
    expect(collectButton()).toBeInTheDocument()
    expect(mockCollect).not.toHaveBeenCalled() // never collects on its own
  })

  it.each<OrderStatus>(['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'COLLECTED', 'CANCELLED'])(
    'is hidden for a %s order (the server only allows READY -> COLLECTED)',
    async (orderStatus) => {
      mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus }))
      renderPage()
      await screen.findByText('assignment.pdf')
      expect(collectButton()).not.toBeInTheDocument()
    },
  )

  it.each(['ADMIN', 'STUDENT', 'FACULTY'])('is hidden when the signed-in role is %s', async (role) => {
    mockUseAuth.mockReturnValue({ user: { userId: 'x', role, shopId: null } })
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    renderPage()
    await screen.findByText('assignment.pdf')
    expect(collectButton()).not.toBeInTheDocument()
  })

  it('collects the order, confirms with a toast, and re-reads it so the button disappears', async () => {
    mockGetOne
      .mockResolvedValueOnce(makeOrder(oneItem(), { orderStatus: 'READY' }))
      .mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'COLLECTED' }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('assignment.pdf')

    await user.click(collectButton()!)

    await waitFor(() => expect(mockCollect).toHaveBeenCalledWith('order-1'))
    expect(mockCollect).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Order marked as collected.', 'success'))
    await waitFor(() => expect(collectButton()).not.toBeInTheDocument())
    expect(mockGetOne).toHaveBeenCalledTimes(2) // initial load + refresh
  })

  it('shows the loading state and ignores a second click while the request is in flight', async () => {
    let finish!: () => void
    mockCollect.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('assignment.pdf')

    await user.click(collectButton()!)
    await waitFor(() => expect(collectButton()).toBeDisabled())
    await user.click(collectButton()!)
    expect(mockCollect).toHaveBeenCalledTimes(1)

    finish()
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Order marked as collected.', 'success'))
  })

  it('handles duplicate collection: shows the server message, re-reads the order, and the button goes away', async () => {
    mockGetOne
      .mockResolvedValueOnce(makeOrder(oneItem(), { orderStatus: 'READY' }))
      .mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'COLLECTED' }))
    mockCollect.mockRejectedValue(new ApiError(409, 'Order cannot be collected while it is COLLECTED'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('assignment.pdf')

    await user.click(collectButton()!)

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Order cannot be collected while it is COLLECTED', 'error'))
    await waitFor(() => expect(collectButton()).not.toBeInTheDocument())
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), 'success')
  })

  it('shows a generic error for an unexpected failure and lets staff retry (button re-enabled)', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    mockCollect.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('assignment.pdf')

    await user.click(collectButton()!)
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not mark this order as collected.', 'error'))
    await waitFor(() => expect(collectButton()).toBeEnabled())

    await user.click(collectButton()!)
    await waitFor(() => expect(mockCollect).toHaveBeenCalledTimes(2))
  })

  it('shows the server permission error (e.g. another shop) without changing the page', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    mockCollect.mockRejectedValue(new ApiError(403, 'You are not authorized to manage this shop'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('assignment.pdf')
    await user.click(collectButton()!)
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('You are not authorized to manage this shop', 'error'))
    expect(screen.getByText('assignment.pdf')).toBeInTheDocument()
  })
})

describe('StaffOrderDetailsPage - optional refund lookup', () => {
  it('does not request a refund for an order that cannot have one (READY / paid, not cancelled)', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'READY' }))
    renderPage()
    await screen.findByText('assignment.pdf')
    expect(mockRefundGetForOrder).not.toHaveBeenCalled()
  })

  it('requests it for a cancelled paid order; "no refund" (null) shows nothing and no error', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'CANCELLED' }))
    mockRefundGetForOrder.mockResolvedValue(null)
    renderPage()
    await screen.findByText('assignment.pdf')
    await waitFor(() => expect(mockRefundGetForOrder).toHaveBeenCalledWith('order-1'))
    expect(screen.queryByText(/could not load the refund details/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Refund')).not.toBeInTheDocument()
  })

  it('shows the refund when one exists', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'CANCELLED' }))
    mockRefundGetForOrder.mockResolvedValue({
      refundId: 'r1',
      orderId: 'order-1',
      paymentId: 'p1',
      refundAmount: '25',
      refundReason: 'Cancelled',
      refundStatus: 'REQUESTED',
      refundTransactionId: 'RFD-1',
      requestedAt: new Date().toISOString(),
      processedAt: null,
    })
    renderPage()
    expect(await screen.findByText('Refund')).toBeInTheDocument()
  })

  it('does NOT hide a genuine server error: it tells the staff member the refund could not be loaded', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'CANCELLED' }))
    mockRefundGetForOrder.mockRejectedValue(new ApiError(500, 'Internal server error'))
    renderPage()
    expect(await screen.findByText(/could not load the refund details/i)).toBeInTheDocument()
  })
})

describe('StaffOrderDetailsPage - optional payment lookup', () => {
  it('no payment yet (null): no payment card and no error notice', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'PLACED' }))
    mockPaymentGetForOrder.mockResolvedValue(null)
    renderPage()
    await screen.findByText('assignment.pdf')
    expect(mockPaymentGetForOrder).toHaveBeenCalledWith('order-1')
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
    expect(screen.queryByText(/could not load the payment details/i)).not.toBeInTheDocument()
  })

  it('shows an existing payment', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'QUEUED' }))
    mockPaymentGetForOrder.mockResolvedValue({
      paymentId: 'p1', orderId: 'order-1', amount: '25', paymentMethod: 'UPI', transactionId: 'TXN-9',
      paymentStatus: 'SUCCESS', createdAt: new Date().toISOString(), paidAt: new Date().toISOString(),
    })
    renderPage()
    expect(await screen.findByText(/UPI · SUCCESS/)).toBeInTheDocument()
  })

  it('does NOT hide a genuine server error: staff are told the payment could not be loaded', async () => {
    mockGetOne.mockResolvedValue(makeOrder(oneItem(), { orderStatus: 'PLACED' }))
    mockPaymentGetForOrder.mockRejectedValue(new ApiError(500, 'Internal server error'))
    renderPage()
    expect(await screen.findByText(/could not load the payment details/i)).toBeInTheDocument()
  })
})
