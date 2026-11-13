import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Stepper } from '@/components/ui/Stepper'
import { PageHeader } from '@/layouts/AppShell'
import { documentApi } from '@/services/documentApi'
import { createIdempotencyKey } from '@/utils/idempotencyKey'
import type { PricingPreviewResult, SafeDocument, SafeOrder, SafeShop } from '@/types'
import { StepDocument } from './StepDocument'
import { StepPayment } from './StepPayment'
import { StepQueue } from './StepQueue'
import { StepReview } from './StepReview'
import { StepShop } from './StepShop'
import { StepSettings } from './StepSettings'
import { DEFAULT_SETTINGS, STEP_LABELS } from './types'
import type { OrderItemDraft, PrintSettings } from './types'

export function PrintFlowPage() {
  const [searchParams] = useSearchParams()
  const [stepIndex, setStepIndex] = useState(0)
  const [items, setItems] = useState<OrderItemDraft[]>([])
  const [shop, setShop] = useState<SafeShop | null>(null)
  const [preview, setPreview] = useState<PricingPreviewResult | null>(null)
  const [order, setOrder] = useState<SafeOrder | null>(null)
  const orderAttempt = useRef<{ signature: string; key: string } | null>(null)

  // One Idempotency-Key per distinct order request. Kept here rather than in
  // the review step because that step unmounts when the user goes back from
  // payment; placing the unchanged order again must return the order that
  // already exists, not create a second one.
  function getIdempotencyKey(signature: string): string {
    if (orderAttempt.current?.signature !== signature) {
      orderAttempt.current = { signature, key: createIdempotencyKey() }
    }
    return orderAttempt.current.key
  }

  useEffect(() => {
    // Supports two entry points: a single ?documentId= (the "Print" quick
    // action on one document) and a comma-separated ?documentIds= (the
    // "Print again" reprint action, which carries forward every document
    // that was part of the original order).
    const single = searchParams.get('documentId')
    const multi = searchParams.get('documentIds')
    const ids = multi ? multi.split(',').filter(Boolean) : single ? [single] : []
    if (ids.length === 0) return

    Promise.all(ids.map((id) => documentApi.getOne(id).catch(() => null))).then((docs) => {
      const found = docs.filter((d): d is NonNullable<typeof d> => d !== null)
      if (found.length === 0) return
      setItems((current) => {
        const existingIds = new Set(current.map((item) => item.document.documentId))
        const additions = found
          .filter((doc) => !existingIds.has(doc.documentId))
          .map((doc) => ({ document: doc, settings: DEFAULT_SETTINGS }))
        return [...current, ...additions]
      })
      setStepIndex(1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleAddDocument(doc: SafeDocument) {
    setItems((current) => [...current, { document: doc, settings: DEFAULT_SETTINGS }])
  }

  function handleRemoveDocument(documentId: string) {
    setItems((current) => current.filter((item) => item.document.documentId !== documentId))
  }

  function handleChangeItemSettings(documentId: string, settings: PrintSettings) {
    setItems((current) =>
      current.map((item) => (item.document.documentId === documentId ? { ...item, settings } : item)),
    )
  }

  function handleOrderCreated(created: SafeOrder) {
    setOrder(created)
    // A FACULTY order at the CSE Department Faculty Printer skips payment
    // entirely - the backend has already moved it straight to QUEUED (see
    // order.service.ts::createOrder). Only jump to Queue when the backend
    // itself reports the order no longer needs payment; a normal order
    // stays PLACED and goes to the Payment step as usual.
    setStepIndex(created.orderStatus === 'PLACED' ? 4 : 5)
  }

  function handlePaid(paidOrder: SafeOrder) {
    setOrder(paidOrder)
    setStepIndex(5)
  }

  return (
    <div>
      <PageHeader title="New Print Order" subtitle="Upload, configure, and send it to a shop." />

      <div style={{ marginBottom: 28, overflowX: 'auto' }}>
        <Stepper steps={STEP_LABELS} currentIndex={stepIndex} />
      </div>

      <div style={{ maxWidth: 640 }}>
        {stepIndex === 0 && (
          <StepDocument
            selectedDocuments={items.map((item) => item.document)}
            onAdd={handleAddDocument}
            onRemove={handleRemoveDocument}
            onContinue={() => setStepIndex(shop ? 2 : 1)}
          />
        )}

        {stepIndex === 1 && items.length > 0 && (
          <StepShop
            selected={shop}
            onSelect={setShop}
            onContinue={() => setStepIndex(2)}
            onBack={() => setStepIndex(0)}
          />
        )}

        {stepIndex === 2 && items.length > 0 && shop && (
          <StepSettings
            shop={shop}
            items={items}
            onChangeItemSettings={handleChangeItemSettings}
            onRemoveItem={handleRemoveDocument}
            onAddAnotherDocument={() => setStepIndex(0)}
            onContinue={(p) => {
              setPreview(p)
              setStepIndex(3)
            }}
            onBack={() => setStepIndex(1)}
          />
        )}

        {stepIndex === 3 && items.length > 0 && shop && preview && (
          <StepReview
            shop={shop}
            items={items}
            preview={preview}
            getIdempotencyKey={getIdempotencyKey}
            onBack={() => setStepIndex(2)}
            onOrderCreated={handleOrderCreated}
          />
        )}

        {stepIndex === 4 && order && (
          <StepPayment order={order} onPaid={handlePaid} onBack={() => setStepIndex(3)} />
        )}

        {stepIndex === 5 && order && <StepQueue order={order} />}
      </div>
    </div>
  )
}
