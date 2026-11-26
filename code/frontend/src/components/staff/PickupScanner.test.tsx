import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SafeOrder } from '@/types'
import { ApiError } from '@/types/api'
import { PickupScanner } from './PickupScanner'

const mockGetByCode = vi.fn()
vi.mock('@/services/orderApi', () => ({
  orderApi: { getByCode: (code: string) => mockGetByCode(code) },
}))

const mockCollect = vi.fn()
vi.mock('@/services/queueApi', () => ({
  queueApi: { collect: (id: string) => mockCollect(id) },
}))

const mockShowToast = vi.fn()
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

function order(overrides: Partial<SafeOrder>): SafeOrder {
  return {
    orderId: 'order-1',
    orderCode: 'SP-ABC-123',
    shopName: 'G Block Print',
    customerName: 'Asha Student',
    orderStatus: 'READY',
    items: [
      {
        orderDocumentId: 'od-1',
        documentId: 'doc-1',
        fileName: 'report.pdf',
        printPageCount: 12,
        copies: 2,
      },
    ],
    ...overrides,
  } as SafeOrder
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PickupScanner', () => {
  it('looks the typed code up and hands the order over after confirmation', async () => {
    mockGetByCode.mockResolvedValue(order({}))
    mockCollect.mockResolvedValue(undefined)
    const onCollected = vi.fn()
    const user = userEvent.setup()
    render(<PickupScanner onCollected={onCollected} />)

    await user.type(screen.getByLabelText(/order code/i), 'sp-abc-123')
    await user.click(screen.getByRole('button', { name: /find order/i }))

    expect(mockGetByCode).toHaveBeenCalledWith('sp-abc-123')
    expect(await screen.findByText('Asha Student · G Block Print')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /confirm handover/i }))
    await waitFor(() => expect(mockCollect).toHaveBeenCalledWith('order-1'))
    expect(onCollected).toHaveBeenCalled()
    expect(mockShowToast).toHaveBeenCalledWith('SP-ABC-123 handed over.', 'success')
  })

  it('submits on Enter, which is what a handheld barcode scanner does', async () => {
    mockGetByCode.mockResolvedValue(order({}))
    const user = userEvent.setup()
    render(<PickupScanner />)
    await user.type(screen.getByLabelText(/order code/i), 'SP-ABC-123{Enter}')
    expect(mockGetByCode).toHaveBeenCalledWith('SP-ABC-123')
  })

  it('offers no handover for an order that is not READY', async () => {
    mockGetByCode.mockResolvedValue(order({ orderStatus: 'PRINTING' }))
    const user = userEvent.setup()
    render(<PickupScanner />)
    await user.type(screen.getByLabelText(/order code/i), 'SP-ABC-123{Enter}')

    expect(await screen.findByText(/not ready for pickup yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /confirm handover/i })).not.toBeInTheDocument()
  })

  it('says so when the order was already collected', async () => {
    mockGetByCode.mockResolvedValue(order({ orderStatus: 'COLLECTED' }))
    const user = userEvent.setup()
    render(<PickupScanner />)
    await user.type(screen.getByLabelText(/order code/i), 'SP-ABC-123{Enter}')
    expect(await screen.findByText(/already been collected/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /confirm handover/i })).not.toBeInTheDocument()
  })

  it('shows a friendly message when the code is unknown at this shop', async () => {
    mockGetByCode.mockRejectedValue(new ApiError(404, 'Order not found'))
    const user = userEvent.setup()
    render(<PickupScanner />)
    await user.type(screen.getByLabelText(/order code/i), 'SP-NOPE{Enter}')
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('No order with that code at your shop.', 'error'))
  })

  it('keeps "Find order" disabled until something is typed', () => {
    render(<PickupScanner />)
    expect(screen.getByRole('button', { name: /find order/i })).toBeDisabled()
  })

  it('explains when the camera is unavailable instead of failing silently', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const user = userEvent.setup()
    render(<PickupScanner />)
    await user.click(screen.getByRole('button', { name: /scan qr/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot use the camera/i)
    if (original) Object.defineProperty(navigator, 'mediaDevices', original)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
  })
})
