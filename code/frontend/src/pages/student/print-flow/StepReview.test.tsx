import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PricingPreviewResult, SafeDocument, SafeShop } from '@/types'
import { DEFAULT_SETTINGS } from './types'
import type { OrderItemDraft } from './types'
import { StepReview } from './StepReview'

vi.mock('@/services/orderApi', () => ({ orderApi: { create: vi.fn() } }))
vi.mock('@/utils/recentSetup', () => ({ saveRecentSetup: vi.fn() }))

const SHOP: SafeShop = {
  shopId: 'shop-1',
  shopCode: 'G_BLOCK',
  shopName: 'G Block Print Shop',
  location: 'G Block',
  contact: '9000000000',
  isActive: true,
  acceptingOrders: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function doc(id: string, name: string): SafeDocument {
  return {
    documentId: id,
    fileName: name,
    fileUrl: `/api/documents/${id}/download`,
    fileType: 'PDF',
    mimeType: 'application/pdf',
    fileSize: 1024,
    fileHash: 'a'.repeat(64),
    pageCount: 5,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  }
}

const items: OrderItemDraft[] = [
  { document: doc('doc-1', 'Assignment.pdf'), settings: { ...DEFAULT_SETTINGS, copies: 2, sides: 'DOUBLE' } },
  { document: doc('doc-2', 'Notes.pdf'), settings: { ...DEFAULT_SETTINGS, copies: 1 } },
  { document: doc('doc-3', 'Project.pdf'), settings: { ...DEFAULT_SETTINGS, printType: 'COLOR' } },
]

// A combined preview exactly as the backend's pricing preview endpoint would
// return for these three items (see pricing.service.ts::calculatePricingPreview)
// - the review screen must display THESE numbers, never recompute its own.
const preview: PricingPreviewResult = {
  shopId: 'shop-1',
  items: [
    { documentId: 'doc-1', fileName: 'Assignment.pdf', printType: 'BW', paperSize: 'A4', sides: 'DOUBLE', copies: 2, printPageCount: 10, pricePerPage: '2', printCost: '20', finishingType: null, finishingCost: '0', lineTotal: '20' },
    { documentId: 'doc-2', fileName: 'Notes.pdf', printType: 'BW', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 12, pricePerPage: '1', printCost: '12', finishingType: null, finishingCost: '0', lineTotal: '12' },
    { documentId: 'doc-3', fileName: 'Project.pdf', printType: 'COLOR', paperSize: 'A4', sides: 'SINGLE', copies: 1, printPageCount: 8, pricePerPage: '4.375', printCost: '35', finishingType: null, finishingCost: '0', lineTotal: '35' },
  ],
  totalAmount: '67',
}

describe('StepReview - multi-document order review', () => {
  it('displays every document in the order with its own line total', () => {
    render(<StepReview shop={SHOP} items={items} preview={preview} getIdempotencyKey={() => 'test-key-12345678'} onBack={vi.fn()} onOrderCreated={vi.fn()} />)

    expect(screen.getByText(/Assignment\.pdf/)).toBeInTheDocument()
    expect(screen.getByText(/Notes\.pdf/)).toBeInTheDocument()
    expect(screen.getByText(/Project\.pdf/)).toBeInTheDocument()
    expect(screen.getByText('₹20.00')).toBeInTheDocument()
    expect(screen.getByText('₹12.00')).toBeInTheDocument()
    expect(screen.getByText('₹35.00')).toBeInTheDocument()
  })

  it('shows the backend-provided combined total, not a client-recomputed sum', () => {
    render(<StepReview shop={SHOP} items={items} preview={preview} getIdempotencyKey={() => 'test-key-12345678'} onBack={vi.fn()} onOrderCreated={vi.fn()} />)
    // 20 + 12 + 35 = 67, exactly the server's totalAmount - displayed once, for the whole order.
    expect(screen.getByText('₹67.00')).toBeInTheDocument()
  })

  it('shows "Place Order" (not free) when the combined total is nonzero', () => {
    render(<StepReview shop={SHOP} items={items} preview={preview} getIdempotencyKey={() => 'test-key-12345678'} onBack={vi.fn()} onOrderCreated={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument()
  })

  it('shows "Place Free Order" and no charge when the combined total is ₹0 (faculty CSE order)', () => {
    const freePreview: PricingPreviewResult = {
      ...preview,
      items: preview.items.map((i) => ({ ...i, pricePerPage: '0', printCost: '0', finishingCost: '0', lineTotal: '0' })),
      totalAmount: '0',
    }
    render(<StepReview shop={SHOP} items={items} preview={freePreview} getIdempotencyKey={() => 'test-key-12345678'} onBack={vi.fn()} onOrderCreated={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Place Free Order' })).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
  })
})
