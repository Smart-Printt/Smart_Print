import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { Card } from '@/components/ui/Card'
import { OrderStatusBadge, RefundStatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/StateBlock'
import { OrderDocumentList } from '@/components/staff/OrderDocumentList'
import { PageHeader } from '@/layouts/AppShell'
import { orderApi } from '@/services/orderApi'
import { queueApi } from '@/services/queueApi'
import { refundApi } from '@/services/refundApi'
import { paymentApi } from '@/services/paymentApi'
import { shopQueueApi } from '@/services/shopQueueApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import type { OrderStatus, SafeOrder, SafePayment, SafeQueueEntry, SafeRefund } from '@/types'
import { ApiError } from '@/types/api'
import { formatDateTime } from '@/utils/date'
import { formatMoney, isZero } from '@/utils/money'

const CANONICAL_STEPS: OrderStatus[] = ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY', 'COLLECTED']

const STEP_LABEL: Record<OrderStatus, string> = {
  PLACED: 'Order placed',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  QUEUED: 'Queued',
  PRINTING: 'Printing',
  READY: 'Ready for pickup',
  COLLECTED: 'Collected',
  CANCELLED: 'Order cancelled',
}

// Order detail view for shop staff. Access is enforced entirely server-side
// (order.service.ts::getOrderForRequester -> shopService.assertShopAccess,
// and per-document via document.service.ts::findAccessibleDocumentOrThrow)
// - a staff member who manually navigates here with another shop's orderId
// gets the backend's 403/404, rendered below via ErrorState. Staff may view
// documents and (only when it genuinely applies to this exact order) drive
// the shop's FIFO queue forward, and hand over a READY order at the counter
// ("Mark as Collected") - but never cancel/refund on the customer's behalf,
// and refunds stay view-only. Those actions are intentionally absent here.
export function StaffOrderDetailsPage() {
  const { orderId } = useParams<{ orderId: string }>()
  const { showToast } = useToast()
  const { user } = useAuth()

  const [order, setOrder] = useState<SafeOrder | null>(null)
  const [queue, setQueue] = useState<SafeQueueEntry | null>(null)
  const [payment, setPayment] = useState<SafePayment | null>(null)
  const [refund, setRefund] = useState<SafeRefund | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [isActing, setIsActing] = useState(false)
  const [isCollecting, setIsCollecting] = useState(false)
  const [refundLoadFailed, setRefundLoadFailed] = useState(false)
  const [paymentLoadFailed, setPaymentLoadFailed] = useState(false)

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

      // null = no payment yet (not an error); a genuine failure is shown below.
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

      // A refund can only exist for a cancelled, paid order, so only ask then
      // (no pointless request that is guaranteed to 404). "No refund" comes
      // back as null; a genuine failure is shown rather than hidden.
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
      } else {
        setRefund(null)
        setRefundLoadFailed(false)
      }
    } catch (err) {
      setError(err)
    }
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  // "Start next" always starts whatever is actually first in the shop's FIFO
  // queue (see queue.service.ts) - it never targets a specific order. It is
  // only offered here when this order genuinely IS that head-of-queue entry
  // (position 1, still WAITING), so clicking it can never act on a different
  // order than the one being viewed.
  async function handleStartNext() {
    if (!order) return
    setIsActing(true)
    try {
      await shopQueueApi.startNext(order.shopId)
      showToast('Printing started.', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not start the next order.', 'error')
    } finally {
      setIsActing(false)
    }
  }

  async function handleCompletePrint() {
    if (!order || !queue) return
    setIsActing(true)
    try {
      await shopQueueApi.complete(order.shopId, queue.queueId)
      showToast('Marked ready for collection.', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not complete this order.', 'error')
    } finally {
      setIsActing(false)
    }
  }

  // Hand-over at the counter. The server owns the rules (only READY, only this
  // shop's staff); this just calls it and re-reads the order, so a duplicate
  // click or a colleague collecting first shows the real, current state
  // instead of leaving the screen stale.
  async function handleCollect() {
    if (!order || isCollecting) return
    setIsCollecting(true)
    try {
      await queueApi.collect(order.orderId)
      showToast('Order marked as collected.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not mark this order as collected.', 'error')
    } finally {
      setIsCollecting(false)
    }
    await load()
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Order" action={<Link to="/staff"><Button variant="ghost">Back to Queue</Button></Link>} />
        <ErrorState error={error} onRetry={load} title="We couldn't load this order" />
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
  const canCollect = order.orderStatus === 'READY' && user?.role === 'SHOP_STAFF'
  const upcoming =
    order.orderStatus === 'CANCELLED'
      ? []
      : CANONICAL_STEPS.slice(CANONICAL_STEPS.indexOf(order.orderStatus) + 1)

  const totalPages = order.items.reduce((sum, item) => sum + item.printPageCount, 0)
  const totalCopies = order.items.reduce((sum, item) => sum + item.copies, 0)

  return (
    <div>
      <PageHeader
        title={order.orderCode}
        subtitle={`Placed ${formatDateTime(order.createdAt)}${queue ? ` · Token #${queue.queueNumber}` : ''}`}
        action={<OrderStatusBadge status={order.orderStatus} />}
      />

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr' }}>
        <Card padded>
          <p style={{ fontWeight: 800, marginBottom: 10 }}>Customer</p>
          <p style={{ fontWeight: 700, fontSize: 14.5 }}>{order.customerName}</p>
          <p className="text-muted" style={{ fontSize: 13 }}>{order.customerEmail}</p>
        </Card>

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
              <TimelineRow key={status} label={STEP_LABEL[status]} state="upcoming" isLast={i === upcoming.length - 1} />
            ))}
          </div>
        </Card>

        <Card padded>
          <p style={{ fontWeight: 800, marginBottom: 4 }}>Documents ({order.items.length})</p>
          <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            Total pages: {totalPages} · Total copies: {totalCopies}
          </p>
          <OrderDocumentList items={order.items} />
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
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              Transaction {payment.transactionId}{payment.paidAt ? ` · Paid ${formatDateTime(payment.paidAt)}` : ''}
            </p>
          </Card>
        )}

        {queue?.queueStatus === 'WAITING' && queue.position === 1 && (
          <Card padded>
            <p style={{ fontWeight: 800, marginBottom: 10 }}>Queue actions</p>
            <p className="text-secondary" style={{ fontSize: 13, marginBottom: 12 }}>
              This order is next in line for Token #{queue.queueNumber}.
            </p>
            <Button onClick={() => void handleStartNext()} isLoading={isActing}>
              Start Next
            </Button>
          </Card>
        )}

        {queue?.queueStatus === 'PRINTING' && (
          <Card padded>
            <p style={{ fontWeight: 800, marginBottom: 10 }}>Queue actions</p>
            <p className="text-secondary" style={{ fontSize: 13, marginBottom: 12 }}>
              This order is currently printing (Token #{queue.queueNumber}).
            </p>
            <Button onClick={() => void handleCompletePrint()} isLoading={isActing}>
              Complete Print
            </Button>
          </Card>
        )}

        {paymentLoadFailed && (
          <Card padded>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>
              Could not load the payment details for this order. Refresh to try again.
            </p>
          </Card>
        )}

        {canCollect && (
          <Card padded>
            <p style={{ fontWeight: 800, marginBottom: 10 }}>Collection</p>
            <p className="text-secondary" style={{ fontSize: 13, marginBottom: 12 }}>
              This order is ready. Mark it as collected once the customer has picked it up.
            </p>
            <Button onClick={() => void handleCollect()} isLoading={isCollecting}>
              Mark as Collected
            </Button>
          </Card>
        )}

        {refundLoadFailed && (
          <Card padded>
            <p className="text-secondary" style={{ fontSize: 13.5 }}>
              Could not load the refund details for this order. Refresh to try again.
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
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              Requested {formatDateTime(refund.requestedAt)}
              {refund.processedAt ? ` · Processed ${formatDateTime(refund.processedAt)}` : ''}
            </p>
          </Card>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <Link to="/staff">
          <Button variant="ghost">
            <Icon name="chevronLeft" size={15} />
            Back to Queue
          </Button>
        </Link>
      </div>
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
