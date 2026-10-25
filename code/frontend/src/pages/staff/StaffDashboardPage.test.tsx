import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { SafeOrder, SafeOrderItem, SafeQueueEntry, SafeShop } from '@/types'
import { StaffDashboardPage } from './StaffDashboardPage'

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/staff']}>
      <StaffDashboardPage />
    </MemoryRouter>,
  )
}

const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}))

const mockShowToast = vi.fn()
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

const mockShopGetOne = vi.fn()
vi.mock('@/services/shopApi', () => ({
  shopApi: { getOne: (shopId: string) => mockShopGetOne(shopId) },
}))

const mockQueueCurrent = vi.fn()
const mockQueueList = vi.fn()
const mockStartNext = vi.fn()
const mockComplete = vi.fn()
vi.mock('@/services/shopQueueApi', () => ({
  shopQueueApi: {
    current: (shopId: string) => mockQueueCurrent(shopId),
    list: (shopId: string) => mockQueueList(shopId),
    startNext: (shopId: string) => mockStartNext(shopId),
    complete: (shopId: string, queueId: string) => mockComplete(shopId, queueId),
  },
}))

const mockOrderGetOne = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { getOne: (orderId: string) => mockOrderGetOne(orderId) },
}))

const mockPaymentGetForOrder = vi.fn()
vi.mock('@/services/paymentApi', () => ({
  paymentApi: { getForOrder: (orderId: string) => mockPaymentGetForOrder(orderId) },
}))

const mockDownload = vi.fn()
const mockView = vi.fn()
vi.mock('@/services/documentApi', () => ({
  documentApi: {
    download: (id: string, fileName: string) => mockDownload(id, fileName),
    view: (id: string) => mockView(id),
  },
}))

function queueEntry(overrides: Partial<SafeQueueEntry>): SafeQueueEntry {
  return {
    queueId: 'queue-1',
    orderId: 'order-1',
    orderCode: 'SP-1024',
    shopId: 'shop-gblock',
    queueNumber: 1,
    queueStatus: 'PRINTING',
    enteredAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:05:00.000Z',
    completedAt: null,
    cancelledAt: null,
    position: null,
    ...overrides,
  }
}

function orderItem(overrides: Partial<SafeOrderItem>): SafeOrderItem {
  return {
    orderDocumentId: `od-${overrides.documentId ?? 'doc-1'}`,
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

function order(items: SafeOrderItem[], overrides: Partial<SafeOrder> = {}): SafeOrder {
  return {
    orderId: 'order-1',
    orderCode: 'SP-1024',
    shopId: 'shop-gblock',
    shopName: 'G Block Print Shop',
    customerName: 'Student Name',
    customerEmail: 'student@thapar.edu',
    orderStatus: 'PRINTING',
    totalAmount: '28',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
    cancelledReason: null,
    items,
    statusHistory: [{ status: 'PLACED', changedByUserId: 'u1', changedAt: '2026-01-01T00:00:00.000Z', notes: null }],
    ...overrides,
  }
}

function shop(overrides: Partial<SafeShop>): SafeShop {
  return {
    shopId: 'shop-id',
    shopCode: 'CODE',
    shopName: 'A Shop',
    location: 'Somewhere',
    contact: '9000000000',
    isActive: true,
    acceptingOrders: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setUpEmptyQueue(shopData: SafeShop) {
  mockShopGetOne.mockResolvedValue(shopData)
  mockQueueCurrent.mockResolvedValue(null)
  mockQueueList.mockResolvedValue([] as SafeQueueEntry[])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StaffDashboardPage - shop-specific staff dashboard (no hardcoded shop)', () => {
  it('G_BLOCK staff (shopId=shop-gblock) sees the G Block dashboard and G_BLOCK is requested from the backend', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: 'shop-gblock' },
    })
    setUpEmptyQueue(shop({ shopId: 'shop-gblock', shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))

    renderDashboard()

    await waitFor(() => expect(screen.getByText('G Block Print Shop')).toBeInTheDocument())
    expect(mockShopGetOne).toHaveBeenCalledWith('shop-gblock')
    expect(mockQueueCurrent).toHaveBeenCalledWith('shop-gblock')
    expect(mockQueueList).toHaveBeenCalledWith('shop-gblock')
    expect(screen.queryByText('CSE Department Faculty Printer')).not.toBeInTheDocument()
    expect(screen.queryByText('COS Shop')).not.toBeInTheDocument()
  })

  it('CSE_FACULTY staff (shopId=shop-cse) sees the CSE dashboard and CSE_FACULTY is requested from the backend', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u2', name: 'CSE Staff', email: 'cse@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: 'shop-cse' },
    })
    setUpEmptyQueue(shop({ shopId: 'shop-cse', shopCode: 'CSE_FACULTY', shopName: 'CSE Department Faculty Printer' }))

    renderDashboard()

    await waitFor(() => expect(screen.getByText('CSE Department Faculty Printer')).toBeInTheDocument())
    expect(mockShopGetOne).toHaveBeenCalledWith('shop-cse')
    expect(mockQueueCurrent).toHaveBeenCalledWith('shop-cse')
    expect(mockQueueList).toHaveBeenCalledWith('shop-cse')
    expect(screen.queryByText('G Block Print Shop')).not.toBeInTheDocument()
  })

  it('COS staff (shopId=shop-cos) sees the COS dashboard and COS is requested from the backend', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u3', name: 'COS Staff', email: 'cos@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: 'shop-cos' },
    })
    setUpEmptyQueue(shop({ shopId: 'shop-cos', shopCode: 'COS', shopName: 'COS Shop' }))

    renderDashboard()

    await waitFor(() => expect(screen.getByText('COS Shop')).toBeInTheDocument())
    expect(mockShopGetOne).toHaveBeenCalledWith('shop-cos')
    expect(mockQueueCurrent).toHaveBeenCalledWith('shop-cos')
    expect(mockQueueList).toHaveBeenCalledWith('shop-cos')
  })

  it('shows a configuration error (never a G_BLOCK fallback) when shopId is missing', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u4', name: 'Unassigned', email: 'u@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: null },
    })

    renderDashboard()

    expect(
      screen.getByText('Your staff account is not assigned to a print shop. Please contact an administrator.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('G Block Print Shop')).not.toBeInTheDocument()
    expect(mockShopGetOne).not.toHaveBeenCalled()
  })

  it('there is no shop selector on the staff dashboard', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: 'shop-gblock' },
    })
    setUpEmptyQueue(shop({ shopId: 'shop-gblock', shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))

    renderDashboard()

    await waitFor(() => expect(screen.getByText('G Block Print Shop')).toBeInTheDocument())
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText(/select shop/i)).not.toBeInTheDocument()
  })
})

describe('StaffDashboardPage - Current Printing shows real, downloadable documents', () => {
  function setUpPrinting(current: SafeQueueEntry, currentOrder: SafeOrder) {
    mockShopGetOne.mockResolvedValue(shop({ shopId: current.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValue(current)
    mockQueueList.mockResolvedValue([current])
    mockOrderGetOne.mockImplementation((orderId: string) =>
      orderId === currentOrder.orderId ? Promise.resolve(currentOrder) : Promise.reject(new Error('not found')),
    )
    mockPaymentGetForOrder.mockResolvedValue(null)
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: current.shopId },
    })
  }

  it('renders every document belonging to the currently-printing order, with real filenames', async () => {
    const entry = queueEntry({})
    const currentOrder = order([
      orderItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'assignment.pdf' }),
      orderItem({ documentId: 'doc-b', orderDocumentId: 'od-b', fileName: 'notes.pdf' }),
    ])
    setUpPrinting(entry, currentOrder)

    renderDashboard()

    expect(await screen.findByText('assignment.pdf')).toBeInTheDocument()
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
    expect(screen.getByText('Documents (2)')).toBeInTheDocument()
  })

  it('renders a View and Download button for every document in Current Printing', async () => {
    const entry = queueEntry({})
    const currentOrder = order([
      orderItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'assignment.pdf' }),
      orderItem({ documentId: 'doc-b', orderDocumentId: 'od-b', fileName: 'notes.pdf' }),
    ])
    setUpPrinting(entry, currentOrder)

    renderDashboard()

    await screen.findByText('assignment.pdf')
    expect(screen.getAllByRole('button', { name: /^view$/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^download$/i })).toHaveLength(2)
  })

  it('clicking Download in Current Printing calls documentApi.download with the real documentId (not orderId/orderDocumentId)', async () => {
    const entry = queueEntry({})
    const currentOrder = order([orderItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'assignment.pdf' })])
    setUpPrinting(entry, currentOrder)
    mockDownload.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByRole('button', { name: /^download$/i })
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-a', 'assignment.pdf'))
    expect(mockDownload).not.toHaveBeenCalledWith(currentOrder.orderId, expect.anything())
    expect(mockDownload).not.toHaveBeenCalledWith('od-a', expect.anything())
  })

  it('clicking View in Current Printing calls documentApi.view with the documentId', async () => {
    const entry = queueEntry({})
    const currentOrder = order([orderItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    setUpPrinting(entry, currentOrder)
    const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' })
    mockView.mockResolvedValue(blob)

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByRole('button', { name: /^view$/i })
    await user.click(screen.getByRole('button', { name: /^view$/i }))

    await waitFor(() => expect(mockView).toHaveBeenCalledWith('doc-a'))
  })

  it('binds each document row to its own documentId in a multi-document order (not the first document for every button)', async () => {
    const entry = queueEntry({})
    const currentOrder = order([
      orderItem({ documentId: 'doc-a', orderDocumentId: 'od-a', fileName: 'a.pdf' }),
      orderItem({ documentId: 'doc-b', orderDocumentId: 'od-b', fileName: 'b.pdf' }),
      orderItem({ documentId: 'doc-c', orderDocumentId: 'od-c', fileName: 'c.pdf' }),
    ])
    setUpPrinting(entry, currentOrder)
    mockDownload.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByText('a.pdf')
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

  it('shows a toast error when download fails from Current Printing', async () => {
    const entry = queueEntry({})
    const currentOrder = order([orderItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    setUpPrinting(entry, currentOrder)
    mockDownload.mockRejectedValue(new Error('network error'))

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByRole('button', { name: /^download$/i })
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not download this file.', 'error'))
  })

  it('shows an error message when the view request fails from Current Printing', async () => {
    const entry = queueEntry({})
    const currentOrder = order([orderItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })])
    setUpPrinting(entry, currentOrder)
    mockView.mockRejectedValue(new Error('403'))

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByRole('button', { name: /^view$/i })
    await user.click(screen.getByRole('button', { name: /^view$/i }))

    expect(await screen.findByText('Unable to preview this document.')).toBeInTheDocument()
  })

  it('shows an empty state and no documents when nothing is currently printing', async () => {
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: 'shop-gblock' },
    })
    setUpEmptyQueue(shop({ shopId: 'shop-gblock', shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))

    renderDashboard()

    await waitFor(() => expect(screen.getByText('Queue is empty')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^view$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^download$/i })).not.toBeInTheDocument()
  })

  it('shows a skeleton loading state for documents while the current order is still being fetched', async () => {
    const entry = queueEntry({})
    mockShopGetOne.mockResolvedValue(shop({ shopId: entry.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValue(entry)
    mockQueueList.mockResolvedValue([])
    let resolveOrder!: (o: SafeOrder) => void
    mockOrderGetOne.mockImplementation(() => new Promise((resolve) => { resolveOrder = resolve }))
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: entry.shopId },
    })

    renderDashboard()

    await waitFor(() => expect(screen.getByText('Currently printing')).toBeInTheDocument())
    expect(document.querySelector('.skeleton')).toBeTruthy()

    resolveOrder(order([orderItem({ documentId: 'doc-a', fileName: 'assignment.pdf' })]))
    expect(await screen.findByRole('button', { name: /^download$/i })).toBeInTheDocument()
  })

  it('shows a retry option if the current order (and its documents) fails to load', async () => {
    const entry = queueEntry({})
    mockShopGetOne.mockResolvedValue(shop({ shopId: entry.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValue(entry)
    mockQueueList.mockResolvedValue([entry])
    mockOrderGetOne.mockRejectedValue(new Error('boom'))
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: entry.shopId },
    })

    renderDashboard()

    expect(await screen.findByText('Unable to load the documents for this order.')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })

  it('Start Printing refreshes and immediately shows the newly-current order documents', async () => {
    const waitingEntry = queueEntry({ queueId: 'q-wait', orderId: 'order-2', orderCode: 'SP-2000', queueStatus: 'WAITING', queueNumber: 2, position: 1 })
    const startedEntry = queueEntry({ queueId: 'q-wait', orderId: 'order-2', orderCode: 'SP-2000', queueStatus: 'PRINTING', queueNumber: 2 })
    const nextOrder = order([orderItem({ documentId: 'doc-x', fileName: 'x.pdf' })], { orderId: 'order-2', orderCode: 'SP-2000' })

    mockShopGetOne.mockResolvedValue(shop({ shopId: waitingEntry.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValueOnce(null).mockResolvedValue(startedEntry)
    mockQueueList.mockResolvedValue([waitingEntry])
    mockOrderGetOne.mockImplementation((orderId: string) =>
      orderId === nextOrder.orderId ? Promise.resolve(nextOrder) : Promise.reject(new Error('not found')),
    )
    mockPaymentGetForOrder.mockResolvedValue(null)
    mockStartNext.mockResolvedValue(undefined)
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: waitingEntry.shopId },
    })

    const user = userEvent.setup()
    renderDashboard()

    await screen.findByText('Next up')
    await user.click(screen.getByRole('button', { name: /start printing/i }))

    await waitFor(() => expect(screen.getByText('Currently printing')).toBeInTheDocument())
    expect(await screen.findByRole('button', { name: /^download$/i })).toBeInTheDocument()
    expect(screen.getAllByText('x.pdf').length).toBeGreaterThan(0)
  })
})

describe('StaffDashboardPage - "Next up" card document actions', () => {
  const waitingEntry = queueEntry({ queueId: 'q-wait', orderId: 'order-2', orderCode: 'SP-2000', queueStatus: 'WAITING', queueNumber: 2, position: 1 })

  function setUpNextUp(nextOrder: SafeOrder | null) {
    mockShopGetOne.mockResolvedValue(shop({ shopId: waitingEntry.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValue(null)
    mockQueueList.mockResolvedValue([waitingEntry])
    mockOrderGetOne.mockImplementation((orderId: string) =>
      nextOrder && orderId === nextOrder.orderId ? Promise.resolve(nextOrder) : new Promise(() => undefined),
    )
    mockPaymentGetForOrder.mockResolvedValue(null)
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: waitingEntry.shopId },
    })
  }

  it('shows View and Download for the document of the next-up order (before printing starts)', async () => {
    setUpNextUp(order([orderItem({ documentId: 'doc-n', fileName: 'next.pdf' })], { orderId: 'order-2', orderCode: 'SP-2000', orderStatus: 'QUEUED' }))
    renderDashboard()

    await screen.findByText('Next up')
    expect((await screen.findAllByText('next.pdf')).length).toBeGreaterThanOrEqual(1) // card title + document row
    expect(screen.getByRole('button', { name: /^view$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^download$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start printing/i })).toBeInTheDocument() // existing actions kept
    expect(screen.getByText('Documents (1)')).toBeInTheDocument()
  })

  it('Download calls documentApi.download with the real documentId and file name', async () => {
    setUpNextUp(order([orderItem({ documentId: 'doc-n', orderDocumentId: 'od-n', fileName: 'next.pdf' })], { orderId: 'order-2', orderStatus: 'QUEUED' }))
    mockDownload.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderDashboard()

    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-n', 'next.pdf'))
    expect(mockDownload).not.toHaveBeenCalledWith('od-n', expect.anything())
  })

  it('View opens the PDF preview through the authenticated view call', async () => {
    setUpNextUp(order([orderItem({ documentId: 'doc-n', fileName: 'next.pdf' })], { orderId: 'order-2', orderStatus: 'QUEUED' }))
    mockView.mockResolvedValue(new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }))
    const user = userEvent.setup()
    renderDashboard()

    await user.click(await screen.findByRole('button', { name: /^view$/i }))

    await waitFor(() => expect(mockView).toHaveBeenCalledWith('doc-n'))
    await waitFor(() => expect(document.querySelector('object[type="application/pdf"]')).toBeTruthy())
  })

  it('shows a view error inside the preview (e.g. missing file) without breaking the card', async () => {
    setUpNextUp(order([orderItem({ documentId: 'doc-n', fileName: 'next.pdf' })], { orderId: 'order-2', orderStatus: 'QUEUED' }))
    mockView.mockRejectedValue(new Error('404'))
    const user = userEvent.setup()
    renderDashboard()

    await user.click(await screen.findByRole('button', { name: /^view$/i }))

    expect(await screen.findByText('Unable to preview this document.')).toBeInTheDocument()
    expect(screen.getByText('Next up')).toBeInTheDocument()
  })

  it('renders one View/Download pair per document for a multi-document order, bound to each documentId', async () => {
    setUpNextUp(
      order(
        [orderItem({ documentId: 'doc-a', fileName: 'a.pdf' }), orderItem({ documentId: 'doc-b', fileName: 'b.pdf' })],
        { orderId: 'order-2', orderStatus: 'QUEUED' },
      ),
    )
    mockDownload.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderDashboard()

    await screen.findByText('a.pdf')
    expect(screen.getAllByRole('button', { name: /^view$/i })).toHaveLength(2)
    const downloads = screen.getAllByRole('button', { name: /^download$/i })
    expect(downloads).toHaveLength(2)
    await user.click(downloads[1]!)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('doc-b', 'b.pdf'))
  })

  it('shows a loading placeholder, and no document controls, until the next-up order has loaded', async () => {
    setUpNextUp(null) // getOne never resolves
    renderDashboard()

    await screen.findByText('Next up')
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^view$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^download$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start printing/i })).toBeInTheDocument()
  })

  it('does not show a second document list while an order is currently printing (the Next-up card is replaced)', async () => {
    const printing = queueEntry({ queueId: 'q-print', orderId: 'order-1', queueStatus: 'PRINTING', queueNumber: 1 })
    mockShopGetOne.mockResolvedValue(shop({ shopId: printing.shopId, shopCode: 'G_BLOCK', shopName: 'G Block Print Shop' }))
    mockQueueCurrent.mockResolvedValue(printing)
    mockQueueList.mockResolvedValue([waitingEntry])
    mockOrderGetOne.mockImplementation((orderId: string) =>
      Promise.resolve(order([orderItem({ documentId: `d-${orderId}`, fileName: `${orderId}.pdf` })], { orderId, orderStatus: orderId === 'order-1' ? 'PRINTING' : 'QUEUED' })),
    )
    mockPaymentGetForOrder.mockResolvedValue(null)
    mockUseAuth.mockReturnValue({
      user: { userId: 'u1', name: 'G Staff', email: 'g@t.com', phone: null, role: 'SHOP_STAFF', status: 'ACTIVE', shopId: printing.shopId },
    })
    renderDashboard()

    await screen.findByText('Currently printing')
    await screen.findAllByText('order-1.pdf')
    expect(screen.queryByText('Next up')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^view$/i })).toHaveLength(1)
  })
})
