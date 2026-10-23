import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { ApiError } from '@/types/api'
import type { FinishingType, PricingPreviewResult, SafeOrder, SafeShop } from '@/types'
import { formatMoney, isZero } from '@/utils/money'
import { orderApi } from '@/services/orderApi'
import { saveRecentSetup } from '@/utils/recentSetup'
import type { OrderItemDraft } from './types'

const FINISHING_LABEL: Record<FinishingType, string> = {
  NONE: 'None',
  SPIRAL_BINDING: 'Spiral binding',
  HARD_BINDING: 'Hard binding',
  STAPLING: 'Stapling',
  LAMINATION: 'Lamination',
}

interface StepReviewProps {
  shop: SafeShop
  items: OrderItemDraft[]
  preview: PricingPreviewResult
  // Returns the Idempotency-Key for an order request, keyed by the request's
  // content: the same content always gets the same key (so retrying, or coming
  // back from the payment step and placing the order again, cannot create a
  // duplicate), and changed content gets a new one.
  getIdempotencyKey: (requestSignature: string) => string
  onBack: () => void
  onOrderCreated: (order: SafeOrder) => void
}

function orderErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return error.message
    if (error.status === 400) return error.message
    if (error.status === 404) return 'One of the selected documents could no longer be found.'
    if (error.status === 0) return 'Connection lost. Your order has not been placed.'
  }
  return 'Could not place your order. Please try again.'
}

export function StepReview({ shop, items, preview, getIdempotencyKey, onBack, onOrderCreated }: StepReviewProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isFree = isZero(preview.totalAmount)

  async function handlePlaceOrder() {
    setIsSubmitting(true)
    setError(null)
    try {
      const input = {
        shopId: shop.shopId,
        items: items.map((item) => ({
          documentId: item.document.documentId,
          copies: item.settings.copies,
          printType: item.settings.printType,
          paperSize: item.settings.paperSize,
          sides: item.settings.sides,
          pageRange: item.settings.pageRangeMode === 'custom' ? item.settings.pageRange.trim() : undefined,
          finishingRuleId: item.settings.finishingRuleId ?? undefined,
          specialInstructions: item.settings.specialInstructions.trim() || undefined,
        })),
      }
      const order = await orderApi.create(input, getIdempotencyKey(JSON.stringify(input)))

      const last = items[items.length - 1]
      if (last) {
        saveRecentSetup({
          shopId: shop.shopId,
          shopName: shop.shopName,
          printType: last.settings.printType,
          paperSize: last.settings.paperSize,
          sides: last.settings.sides,
          copies: last.settings.copies,
          finishingType: last.settings.finishingType,
          finishingRuleId: last.settings.finishingRuleId,
        })
      }

      onOrderCreated(order)
    } catch (err) {
      setError(orderErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card padded>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--color-primary-soft)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="shop" size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 800 }}>{shop.shopName}</div>
            <div className="text-muted" style={{ fontSize: 12.5 }}>
              {items.length} {items.length === 1 ? 'document' : 'documents'}
            </div>
          </div>
        </div>

        {items.map((item, i) => {
          const previewItem = preview.items[i]
          return (
            <div key={item.document.documentId} style={{ padding: '14px 0', borderBottom: i < items.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>
                  {i + 1}. {item.document.fileName}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                  {previewItem ? formatMoney(previewItem.lineTotal) : '—'}
                </span>
              </div>
              <p className="text-muted" style={{ fontSize: 12.5 }}>
                {previewItem ? `${previewItem.printPageCount} pages × ${previewItem.copies} ${previewItem.copies === 1 ? 'copy' : 'copies'}` : ''}
                {' · '}
                {item.settings.printType === 'BW' ? 'B&W' : 'Color'} • {item.settings.paperSize} •{' '}
                {item.settings.sides === 'SINGLE' ? 'Single' : 'Double'}
                {item.settings.finishingType && item.settings.finishingType !== 'NONE'
                  ? ` • ${FINISHING_LABEL[item.settings.finishingType]}`
                  : ''}
              </p>
              {item.settings.specialInstructions.trim() && (
                <p className="text-muted" style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
                  “{item.settings.specialInstructions.trim()}”
                </p>
              )}
            </div>
          )
        })}
      </Card>

      <Card padded className={isFree ? 'price-panel price-panel--free' : 'price-panel'} style={{ border: 'none' }}>
        <div className="price-panel__total-row">
          <span className="price-panel__total-label">Total</span>
          <span className="price-panel__total-value">{isFree ? 'Free' : formatMoney(preview.totalAmount)}</span>
        </div>
        {isFree && (
          <p style={{ fontSize: 12.5, marginTop: 8, color: 'rgba(255,255,255,0.85)' }}>
            Faculty printing entitlement — no payment required.
          </p>
        )}
      </Card>

      {error && (
        <div className="auth-error-banner" role="alert">
          <Icon name="alert" size={17} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
          Back
        </Button>
        <Button block size="lg" onClick={handlePlaceOrder} isLoading={isSubmitting}>
          {isFree ? 'Place Free Order' : 'Place Order'}
        </Button>
      </div>
    </div>
  )
}
