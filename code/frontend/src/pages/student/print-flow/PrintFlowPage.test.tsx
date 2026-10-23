import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { SafeDocument, SafeOrder, SafeQueueEntry, SafeShop } from '@/types'
import { ApiError } from '@/types/api'
import { PrintFlowPage } from './PrintFlowPage'

const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }))

const mockDocList = vi.fn()
const mockDocGetOne = vi.fn()
vi.mock('@/services/documentApi', () => ({
  documentApi: {
    list: () => mockDocList(),
    getOne: (id: string) => mockDocGetOne(id),
    upload: vi.fn(),
  },
}))

const mockShopList = vi.fn()
vi.mock('@/services/shopApi', () => ({ shopApi: { list: () => mockShopList() } }))

const mockListFinishingRules = vi.fn()
const mockPreview = vi.fn()
vi.mock('@/services/pricingApi', () => ({
  pricingApi: {
    listFinishingRules: () => mockListFinishingRules(),
    preview: (req: unknown) => mockPreview(req),
  },
}))

const mockOrderCreate = vi.fn()
const mockOrderGetOne = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: {
    create: (...args: unknown[]) => mockOrderCreate(...args),
    getOne: (id: string) => mockOrderGetOne(id),
  },
}))

const mockPaymentInitiate = vi.fn()
const mockPaymentConfirm = vi.fn()
vi.mock('@/services/paymentApi', () => ({
  paymentApi: {
    initiate: (...args: unknown[]) => mockPaymentInitiate(...args),
    confirm: (...args: unknown[]) => mockPaymentConfirm(...args),
  },
}))

const mockQueueGetForOrder = vi.fn()
vi.mock('@/services/queueApi', () => ({ queueApi: { getForOrder: () => mockQueueGetForOrder() } }))

vi.mock('@/utils/recentSetup', () => ({ saveRecentSetup: vi.fn() }))

function doc(id: string, name: string, pageCount = 5): SafeDocument {
  return {
    documentId: id,
    fileName: name,
    fileUrl: `/api/documents/${id}/download`,
    fileType: 'PDF',
    mimeType: 'application/pdf',
    fileSize: 1024,
    fileHash: 'a'.repeat(64),
    pageCount,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  }
}

const DOC_A = doc('doc-a', 'Assignment.pdf')
const DOC_B = doc('doc-b', 'Notes.pdf', 12)

const CSE_SHOP: SafeShop = {
  shopId: 'shop-cse',
  shopCode: 'CSE_FACULTY',
  shopName: 'CSE Department Faculty Printer',
  location: 'CSE Department',
  contact: '9000000000',
  isActive: true,
  acceptingOrders: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const G_BLOCK: SafeShop = {
  shopId: 'shop-gblock',
  shopCode: 'G_BLOCK',
  shopName: 'G Block Print Shop',
  location: 'G Block',
  contact: '9000000000',
  isActive: true,
  acceptingOrders: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function renderFlow() {
  return render(
    <MemoryRouter initialEntries={['/print']}>
      <PrintFlowPage />
    </MemoryRouter>,
  )
}

async function selectTwoDocumentsAndShop(shop: SafeShop) {
  await waitFor(() => expect(screen.getByText('Assignment.pdf')).toBeInTheDocument())
  await userEvent.click(screen.getByText('Assignment.pdf'))
  await userEvent.click(screen.getByText('Notes.pdf'))
  await userEvent.click(screen.getByRole('button', { name: /continue with 2 documents/i }))

  await waitFor(() => expect(screen.getByText(shop.shopName)).toBeInTheDocument())
  await userEvent.click(screen.getByText(shop.shopName))
  const shopContinue = screen.getAllByRole('button', { name: 'Continue' })[0]
  await userEvent.click(shopContinue)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDocList.mockResolvedValue([DOC_A, DOC_B])
  mockListFinishingRules.mockResolvedValue([])
})

describe('PrintFlowPage - multi-document order flow', () => {
  it('configures independent settings for two documents, then reviews and creates ONE order with both items (paid, non-free shop)', async () => {
    mockUseAuth.mockReturnValue({ user: { userId: 'u1', name: 'Student', role: 'STUDENT', shopId: null } })
    mockShopList.mockResolvedValue([G_BLOCK])
    mockPreview.mockResolvedValue({
      shopId: G_BLOCK.shopId,
      items: [
        { documentId: 'doc-a', fileName: 'Assignment.pdf', printType: 'BW', paperSize: 'A4', sides: 'DOUBLE', copies: 2, printPageCount: 10, pricePerPage: '2', printCost: '20', finishingType: null, finishingCost: '0', lineTotal: '20' },
        { documentId: 'doc-b', fileName: 'Notes.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 12, pricePerPage: '1', printCost: '12', finishingType: null, finishingCost: '0', lineTotal: '12' },
      ],
      totalAmount: '32',
    })
    const createdOrder: SafeOrder = {
      orderId: 'order-1',
      orderCode: 'SP-0001',
      shopId: G_BLOCK.shopId,
      shopName: G_BLOCK.shopName,
      customerName: 'Test Student',
      customerEmail: 'student@example.edu',
      orderStatus: 'PLACED',
      totalAmount: '32',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      cancelledReason: null,
      items: [],
      statusHistory: [],
    }
    mockOrderCreate.mockResolvedValue(createdOrder)

    renderFlow()
    await selectTwoDocumentsAndShop(G_BLOCK)

    // Both documents must appear as SEPARATE configuration cards on the
    // Settings step - each keeps its own settings state.
    await waitFor(() => expect(screen.getAllByText('Assignment.pdf').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Notes.pdf').length).toBeGreaterThan(0)

    // Give Assignment.pdf double-sided + 2 copies; leave Notes.pdf on defaults.
    const sidesToggles = screen.getAllByRole('button', { name: 'Double-sided' })
    await userEvent.click(sidesToggles[0]);
    const plusButtons = screen.getAllByRole('button', { name: 'Increase copies' })
    await userEvent.click(plusButtons[0])

    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    const lastCall = mockPreview.mock.calls[mockPreview.mock.calls.length - 1][0]
    expect(lastCall.items).toHaveLength(2)
    // The combined preview must be a SINGLE backend call covering both items,
    // never one call per document.
    expect(lastCall.items[0].documentId).toBe('doc-a')
    expect(lastCall.items[1].documentId).toBe('doc-b')

    await waitFor(() => expect(screen.getByText('₹32.00')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument())
    // Review must show both documents.
    expect(screen.getByText(/Assignment\.pdf/)).toBeInTheDocument()
    expect(screen.getByText(/Notes\.pdf/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))

    await waitFor(() => expect(mockOrderCreate).toHaveBeenCalledTimes(1))
    const orderReq = mockOrderCreate.mock.calls[0][0]
    expect(orderReq.items).toHaveLength(2)
    expect(orderReq.shopId).toBe(G_BLOCK.shopId)

    // A paid order stays PLACED -> must reach the payment screen, not skip it.
    await waitFor(() => expect(screen.getByText('Amount to pay')).toBeInTheDocument())
  })

  it('a free FACULTY+CSE_FACULTY multi-document order skips payment entirely and reaches one queue entry', async () => {
    mockUseAuth.mockReturnValue({ user: { userId: 'u2', name: 'Faculty', role: 'FACULTY', shopId: null } })
    mockShopList.mockResolvedValue([CSE_SHOP])
    mockPreview.mockResolvedValue({
      shopId: CSE_SHOP.shopId,
      items: [
        { documentId: 'doc-a', fileName: 'Assignment.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 5, pricePerPage: '0', printCost: '0', finishingType: null, finishingCost: '0', lineTotal: '0' },
        { documentId: 'doc-b', fileName: 'Notes.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 12, pricePerPage: '0', printCost: '0', finishingType: null, finishingCost: '0', lineTotal: '0' },
      ],
      totalAmount: '0',
    })
    // Free orders are created already QUEUED (see order.service.ts::createOrder) -
    // no payment is ever created for them.
    const freeOrder: SafeOrder = {
      orderId: 'order-2',
      orderCode: 'SP-0002',
      shopId: CSE_SHOP.shopId,
      shopName: CSE_SHOP.shopName,
      customerName: 'Test Faculty',
      customerEmail: 'faculty@example.edu',
      orderStatus: 'QUEUED',
      totalAmount: '0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      cancelledReason: null,
      items: [],
      statusHistory: [],
    }
    mockOrderCreate.mockResolvedValue(freeOrder)
    const queueEntry: SafeQueueEntry = {
      queueId: 'q-1',
      orderId: 'order-2',
      orderCode: 'SP-0002',
      shopId: CSE_SHOP.shopId,
      queueNumber: 18,
      queueStatus: 'WAITING',
      enteredAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      position: 1,
    }
    mockQueueGetForOrder.mockResolvedValue(queueEntry)

    renderFlow()
    await selectTwoDocumentsAndShop(CSE_SHOP)

    await waitFor(() => expect(screen.getAllByText('Free').length).toBeGreaterThan(0))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Place Free Order' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Place Free Order' }))

    await waitFor(() => expect(mockOrderCreate).toHaveBeenCalledTimes(1))
    const orderReq = mockOrderCreate.mock.calls[0][0]
    expect(orderReq.items).toHaveLength(2)

    // Payment must never be initiated for a free order.
    expect(mockPaymentInitiate).not.toHaveBeenCalled()
    expect(screen.queryByText('Amount to pay')).not.toBeInTheDocument()

    // Reaches the queue screen with exactly one token for the whole order.
    await waitFor(() => expect(screen.getByText("You're in the queue")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('#18')).toBeInTheDocument())
    expect(mockQueueGetForOrder).toHaveBeenCalledTimes(1)
  })
})

describe('PrintFlowPage - duplicate order protection', () => {
  const PLACED_ORDER: SafeOrder = {
    orderId: 'order-9',
    orderCode: 'SP-0009',
    shopId: G_BLOCK.shopId,
    shopName: G_BLOCK.shopName,
    customerName: 'Test Student',
    customerEmail: 'student@example.edu',
    orderStatus: 'PLACED',
    totalAmount: '32',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
    cancelledReason: null,
    items: [],
    statusHistory: [],
  }

  async function reachReviewStep() {
    mockUseAuth.mockReturnValue({ user: { userId: 'u1', name: 'Student', role: 'STUDENT', shopId: null } })
    mockShopList.mockResolvedValue([G_BLOCK])
    mockPreview.mockResolvedValue({
      shopId: G_BLOCK.shopId,
      items: [
        { documentId: 'doc-a', fileName: 'Assignment.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 5, pricePerPage: '2', printCost: '10', finishingType: null, finishingCost: '0', lineTotal: '10' },
        { documentId: 'doc-b', fileName: 'Notes.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 12, pricePerPage: '1', printCost: '12', finishingType: null, finishingCost: '0', lineTotal: '12' },
      ],
      totalAmount: '22',
    })
    renderFlow()
    await selectTwoDocumentsAndShop(G_BLOCK)
    await waitFor(() => expect(screen.getByText('₹22.00')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument())
  }

  it('retries a failed placement with the SAME Idempotency-Key', async () => {
    mockOrderCreate
      .mockRejectedValueOnce(new ApiError(0, 'Connection lost. Please check your network and try again.'))
      .mockResolvedValueOnce(PLACED_ORDER)
    await reachReviewStep()

    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(screen.getByText('Amount to pay')).toBeInTheDocument())

    expect(mockOrderCreate).toHaveBeenCalledTimes(2)
    const firstKey = mockOrderCreate.mock.calls[0][1]
    expect(typeof firstKey).toBe('string')
    expect(firstKey.length).toBeGreaterThanOrEqual(8)
    expect(mockOrderCreate.mock.calls[1][1]).toBe(firstKey)
  })

  it('going back from payment and placing the unchanged order again reuses the key', async () => {
    mockOrderCreate.mockResolvedValue(PLACED_ORDER)
    await reachReviewStep()

    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(screen.getByText('Amount to pay')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(mockOrderCreate).toHaveBeenCalledTimes(2))

    expect(mockOrderCreate.mock.calls[1][1]).toBe(mockOrderCreate.mock.calls[0][1])
  })

  it('changing the order after going back uses a NEW key', async () => {
    mockOrderCreate.mockResolvedValue(PLACED_ORDER)
    await reachReviewStep()

    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(screen.getByText('Amount to pay')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Back' })) // review -> settings
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Increase copies' }).length).toBeGreaterThan(0))
    await userEvent.click(screen.getAllByRole('button', { name: 'Increase copies' })[0])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Place Order' }))
    await waitFor(() => expect(mockOrderCreate).toHaveBeenCalledTimes(2))

    expect(mockOrderCreate.mock.calls[1][1]).not.toBe(mockOrderCreate.mock.calls[0][1])
  })
})
