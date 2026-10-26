import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { OrderStatusBadge, RefundStatusBadge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/StateBlock'
import { TextArea } from '@/components/ui/Input'
import { PageHeader } from '@/layouts/AppShell'
import { StepPayment } from '@/pages/student/print-flow/StepPayment'
import { orderApi } from '@/services/orderApi'
import { queueApi } from '@/services/queueApi'
import { refundApi } from '@/services/refundApi'
import { paymentApi } from '@/services/paymentApi'
import { useToast } from '@/hooks/useToast'
import { CANCELLABLE_ORDER_STATUSES } from '@/types/order'
import type { OrderStatus, SafeOrder, SafePayment, SafeQueueEntry, SafeRefund } from '@/types'
import { ApiError } from '@/types/api'
import { formatDateTime } from '@/utils/date'
import { formatMoney, isZero } from '@/utils/money'

const CANONICAL_STEPS: OrderStatus[] = ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY', 'COLLECTED']

const STEP_LABEL: Record<OrderStatus, string> = {
  PLACED: 'Order placed',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  QUEUED: 'Joined the queue',
  PRINTING: 'Printing your documents',
  READY: 'Ready for pickup',
  COLLECTED: 'Collected',
  CANCELLED: 'Order cancelled',
}

const POLL_INTERVAL_MS = 8000

export function OrderDetailsPage() {
  const { orderId } = useParams<{ orderId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [order, setOrder] = useState<SafeOrder | null>(null)
  const [queue, setQueue] = useState<SafeQueueEntry | null>(null)
  const [payment, setPayment] = useState<SafePayment | null>(null)
  const [refund, setRefund] = useState<SafeRefund | null>(null)
  const [refundLoadFailed, setRefundLoadFailed] = useState(false)
  const [paymentLoadFailed, setPaymentLoadFailed] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [isCancelOpen, setIsCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [isCancelling, setIsCancelling] = useState(false)
  const [isRequestingRefund, setIsRequestingRefund] = useState(false)
  const [isPaying, setIsPaying] = useState(false)

  const load = useCallback(async () => {
    if (!orderId) return
    try {
      const fetched = await orderApi.getOne(orderId)
      setOrder(fetched)
      setError(null)

      if (['QUEUED', 'PRINTING'].includes(fetched.orderStatus)) {
        queueApi.getForOrder(orderId).then(setQueue).catch(() => setQueue(null))
      } else {
        setQueue(null)
      }

      // null = no payment yet (not an error). A genuine failure is shown below
      // instead of being mistaken for "no payment".
      if (!isZero(fetched.totalAmount)) {
        paymentApi
          .getForOrder(orderId)
          .then((p) => {
            setPayment(p)
            setPaymentLoadFailed(false)
          })
          .catch(() => {
            setPayment(null)
            setPaymentLoadFailed(true)
          })
      }

      if (fetched.orderStatus === 'CANCELLED' && !isZero(fetched.totalAmount)) {
        refundApi
          .getForOrder(orderId)
          .then((r) => {
            setRefund(r)
            setRefundLoadFailed(false)
          })
          .catch(() => {
            setRefund(null)
            setRefundLoadFailed(true)
          })
      }
    } catch (err) {
      setError(err)
    }
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  // Live position/status polling only while the order is actually moving
  // through the queue - never on terminal states, and at a gentle interval.
  useEffect(() => {
    if (!order || !['QUEUED', 'PRINTING'].includes(order.orderStatus)) return
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [order, load])

  async function handleCancel() {
    if (!orderId) return
    setIsCancelling(true)
    try {
      const updated = await orderApi.cancel(orderId, cancelReason.trim() || undefined)
      setOrder(updated)
      setIsCancelOpen(false)
      showToast('Order cancelled.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not cancel this order.', 'error')
    } finally {
      setIsCancelling(false)
    }
  }

  // Resumes the existing mock-payment flow for THIS order (no new order, so
  // no idempotency key is involved): StepPayment initiates (or picks up the
  // already pending payment) and confirms, then we re-read the order.
  function handlePaid(paid: SafeOrder) {
    setOrder(paid)
    setIsPaying(false)
    showToast('Payment confirmed.', 'success')
    void load()
  }

  async function handleRequestRefund() {
    if (!orderId) return
    setIsRequestingRefund(true)
    try {
      const created = await refundApi.request(orderId, 'Requested by student after order cancellation')
      setRefund(created)
      showToast('Refund requested.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not request a refund.', 'error')
    } finally {
      setIsRequestingRefund(false)
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Order" />
        <ErrorState error={error} onRetry={load} title="We couldn't find that order" />
      </div>
    )
  }

  if (!order) {
    return (
      <div>
        <PageHeader title="Order" />
        <Skeleton height={280} radius="18px" />
      </div>
    )
  }

  const isFree = isZero(order.totalAmount)
  const canCancel = CANCELLABLE_ORDER_STATUSES.includes(order.orderStatus)
  const canRequestRefund = order.orderStatus === 'CANCELLED' && !isFree && payment?.paymentStatus === 'SUCCESS' && !refund
  // Only an unpaid (PLACED), non-free order can be paid; a PAYMENT_CONFIRMED /
  // QUEUED / ... order is already paid and a CANCELLED one is no longer payable.
  const canPay = order.orderStatus === 'PLACED' && !isFree
  const canReprint = order.orderStatus === 'COLLECTED' || order.orderStatus === 'CANCELLED'

  const upcoming =
    order.orderStatus === 'CANCELLED'
      ? []
      : CANONICAL_STEPS.slice(CANONICAL_STEPS.indexOf(order.orderStatus) + 1)

  return (
    <div>
      <PageHeader
        title={order.orderCode}
        subtitle={`${order.shopName} · Placed ${formatDateTime(order.createdAt)}`}
        action={<OrderStatusBadge status={order.orderStatus} />}
      />

      {order.orderStatus === 'READY' && (
        <Card padded style={{ background: 'var(--color-success-soft)', border: 'none', marginBottom: 20, textAlign: 'center' }}>
          <p style={{ fontSize: 28, marginBottom: 4 }}>🎉</p>
          <p style={{ fontWeight: 800, color: 'var(--color-success)', fontSize: 16 }}>Your prints are ready!</p>
          <p className="text-secondary" style={{ fontSize: 13.5, marginTop: 4 }}>
            Head to {order.shopName} to collect them.
          </p>
        </Card>
      )}

      {queue && ['QUEUED', 'PRINTING'].includes(order.orderStatus) && (
        <Card padded style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
            <div>
              <p className="text-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Token</p>
              <p style={{ fontSize: 24, fontWeight: 800 }}>#{queue.queueNumber}</p>
            </div>
            {queue.position !== null && (
              <div>
                <p className="text-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                  {queue.position === 0 ? 'Status' : 'Position'}
                </p>
                <p style={{ fontSize: 24, fontWeight: 800 }}>{queue.position === 0 ? 'Now' : `#${queue.position}`}</p>
              </div>
            )}
          </div>
          <p className="text-muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 10 }}>
            Position updates automatically.
          </p>
        </Card>
      )}

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr' }}>
        <Card padded>
          <p style={{ fontWeight: 800, marginBottom: 14 }}>Order timeline</p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {order.statusHistory.map((event, i) => (
              <TimelineRow
                key={i}
                label={STEP_LABEL[event.status]}
                timestamp={formatDateTime(event.changedAt)}
                notes={event.notes}
                state={i === order.statusHistory.length - 1 && order.orderStatus !== 'CANCELLED' ? 'current' : 'done'}
                isLast={i === order.statusHistory.length - 1 && upcoming.length === 0}
                danger={event.status === 'CANCELLED'}
              />
            ))}
            {upcoming.map((status, i) => (
              <TimelineRow
                key={status}
                label={STEP_LABEL[status]}
                state="upcoming"
                isLast={i === upcoming.length - 1}
              />
            ))}
          </div>
        </Card>

        <Card padded>
          <p style={{ fontWeight: 800, marginBottom: 14 }}>Documents & settings</p>
          {order.items.map((item) => (
            <div key={item.orderDocumentId} style={{ padding: '12px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                <span>{item.fileName}</span>
                <span>{formatMoney(item.lineTotal)}</span>
              </div>
              <p className="text-muted" style={{ fontSize: 12.5 }}>
                {item.printType === 'BW' ? 'B&W' : 'Color'} · {item.paperSize} · {item.sides === 'SINGLE' ? 'Single-sided' : 'Double-sided'} ·{' '}
                {item.copies} {item.copies === 1 ? 'copy' : 'copies'} · {item.printPageCount} pages
                {item.finishingType && item.finishingType !== 'NONE' ? ` · ${item.finishingType.replace('_', ' ').toLowerCase()}` : ''}
              </p>
              {item.specialInstructions && (
                <p className="text-muted" style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
                  “{item.specialInstructions}”
                </p>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, fontWeight: 800, fontSize: 15 }}>
            <span>Total</span>
            <span>{isFree ? 'Free' : formatMoney(order.totalAmount)}</span>
          </div>
          {isFree && (
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>Faculty printing — no payment required.</p>
          )}
        </Card>

        {payment && (
          <Card padded>
            <p style={{ fontWeight: 800, marginBottom: 10 }}>Payment</p>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>
              {payment.paymentMethod} · {payment.paymentStatus} · {formatMoney(payment.amount)}
            </p>
          </Card>
        )}

        {paymentLoadFailed && (
          <Card padded>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>
              We couldn't load the payment details for this order. Please refresh to try again.
            </p>
          </Card>
        )}

        {refundLoadFailed && (
          <Card padded>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>
              We couldn't load the refund details for this order. Please refresh to try again.
            </p>
          </Card>
        )}

        {refund && (
          <Card padded>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <p style={{ fontWeight: 800 }}>Refund</p>
              <RefundStatusBadge status={refund.refundStatus} />
            </div>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>{formatMoney(refund.refundAmount)} · {refund.refundReason}</p>
          </Card>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24 }}>
        {canCancel && (
          <Button variant="danger" onClick={() => setIsCancelOpen(true)}>
            Cancel Order
          </Button>
        )}
        {canPay && (
          <Button onClick={() => setIsPaying(true)}>
            {payment?.paymentStatus === 'FAILED' ? 'Retry payment' : 'Pay now'}
          </Button>
        )}
        {canRequestRefund && (
          <Button variant="secondary" onClick={handleRequestRefund} isLoading={isRequestingRefund}>
            Request Refund
          </Button>
        )}
        {canReprint && (
          <Button
            variant="secondary"
            onClick={() => navigate(`/print?documentIds=${order.items.map((i) => i.documentId).join(',')}`)}
          >
            <Icon name="refresh" size={15} />
            Print again
          </Button>
        )}
        <Link to="/orders">
          <Button variant="ghost">Back to Orders</Button>
        </Link>
      </div>

      <Modal isOpen={isPaying && canPay} title="Complete payment" onClose={() => setIsPaying(false)} maxWidth={520}>
        <StepPayment order={order} onPaid={handlePaid} onBack={() => setIsPaying(false)} />
      </Modal>

      <Modal isOpen={isCancelOpen} title="Cancel this order?" onClose={() => setIsCancelOpen(false)}>
        <p className="modal__body">This can't be undone once printing has started.</p>
        <TextArea
          label="Reason (optional)"
          placeholder="e.g. Changed my mind"
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
        />
        <div className="modal__actions" style={{ marginTop: 18 }}>
          <Button variant="secondary" onClick={() => setIsCancelOpen(false)} disabled={isCancelling}>
            Keep Order
          </Button>
          <Button variant="danger" onClick={handleCancel} isLoading={isCancelling}>
            Cancel Order
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function TimelineRow({
  label,
  timestamp,
  notes,
  state,
  isLast,
  danger,
}: {
  label: string
  timestamp?: string
  notes?: string | null
  state: 'done' | 'current' | 'upcoming'
  isLast: boolean
  danger?: boolean
}) {
  const color = danger ? 'var(--color-danger)' : state === 'upcoming' ? 'var(--color-text-muted)' : state === 'current' ? 'var(--color-primary)' : 'var(--color-success)'
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: state === 'upcoming' ? 'var(--color-surface-sunken)' : color,
            color: state === 'upcoming' ? 'var(--color-text-muted)' : '#fff',
            flexShrink: 0,
          }}
        >
          {state === 'done' && <Icon name="check" size={12} />}
          {state === 'current' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
        </span>
        {!isLast && <span style={{ width: 2, flex: 1, background: 'var(--color-border)', minHeight: 24 }} />}
      </div>
      <div style={{ paddingBottom: 18 }}>
        <p style={{ fontWeight: state === 'upcoming' ? 500 : 700, fontSize: 13.5, color: state === 'upcoming' ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
          {label}
        </p>
        {timestamp && <p className="text-muted" style={{ fontSize: 12 }}>{timestamp}</p>}
        {notes && <p className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{notes}</p>}
      </div>
    </div>
  )
}
