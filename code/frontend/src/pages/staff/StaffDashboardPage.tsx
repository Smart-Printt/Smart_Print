import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Badge, PaymentStatusBadge as SharedPaymentStatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { OrderDocumentList } from '@/components/staff/OrderDocumentList'
import { PageHeader } from '@/layouts/AppShell'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { orderApi } from '@/services/orderApi'
import { paymentApi } from '@/services/paymentApi'
import { shopApi } from '@/services/shopApi'
import { shopQueueApi } from '@/services/shopQueueApi'
import type { SafeOrder, SafePayment, SafeQueueEntry, SafeShop } from '@/types'
import { ApiError } from '@/types/api'
import { formatMoney, isZero } from '@/utils/money'
import { formatTime } from '@/utils/date'

const POLL_INTERVAL_MS = 7000

// A queue entry is always ONE order, which may bundle several documents
// (see order.service.ts's items: CreateOrderItemInput[]) - each with its own
// independent settings. These helpers describe the whole order rather than
// assuming a single document/settings pair.
function orderTitle(order: SafeOrder | null): string {
  if (!order) return ''
  if (order.items.length === 1) return order.items[0]?.fileName ?? order.orderCode
  return `${order.items.length} documents`
}

function orderSummary(order: SafeOrder | null): string {
  if (!order || order.items.length === 0) return ''
  if (order.items.length === 1) {
    const item = order.items[0]!
    return `${item.printPageCount} pages · ${item.printType === 'BW' ? 'B&W' : 'Color'} · ${item.copies} ${item.copies === 1 ? 'copy' : 'copies'}${item.finishingType && item.finishingType !== 'NONE' ? ` · ${item.finishingType.replace('_', ' ').toLowerCase()}` : ''}`
  }
  const totalPages = order.items.reduce((sum, item) => sum + item.printPageCount, 0)
  const totalCopies = order.items.reduce((sum, item) => sum + item.copies, 0)
  return `Total pages: ${totalPages} · Copies: ${totalCopies}`
}

// Free (faculty) orders never have a Payment row - distinguish "no payment
// needed" from "payment not loaded yet" so the badge never falsely implies
// something failed.
function OrderPaymentBadge({ order, payment }: { order: SafeOrder | null; payment: SafePayment | null | undefined }) {
  if (!order) return null
  if (isZero(order.totalAmount)) return <Badge tone="neutral">Free</Badge>
  if (payment === undefined) return null
  if (!payment) return <Badge tone="neutral">Payment pending</Badge>
  return <SharedPaymentStatusBadge status={payment.paymentStatus} />
}

export function StaffDashboardPage() {
  const { user } = useAuth()
  const { showToast } = useToast()
  const shopId = user?.shopId ?? null

  const [shop, setShop] = useState<SafeShop | null>(null)
  const [current, setCurrent] = useState<SafeQueueEntry | null>(null)
  const [currentOrder, setCurrentOrder] = useState<SafeOrder | null>(null)
  const [currentOrderFailed, setCurrentOrderFailed] = useState(false)
  const [currentPayment, setCurrentPayment] = useState<SafePayment | null | undefined>(undefined)
  const [waiting, setWaiting] = useState<SafeQueueEntry[] | null>(null)
  const [waitingOrders, setWaitingOrders] = useState<Record<string, SafeOrder>>({})
  const [waitingPayments, setWaitingPayments] = useState<Record<string, SafePayment | null>>({})
  const [error, setError] = useState<unknown>(null)
  const [isActing, setIsActing] = useState(false)
  const [isTogglingStatus, setIsTogglingStatus] = useState(false)

  const load = useCallback(async () => {
    if (!shopId) return
    try {
      const [shopData, currentEntry, waitingEntries] = await Promise.all([
        shopApi.getOne(shopId),
        shopQueueApi.current(shopId),
        shopQueueApi.list(shopId),
      ])
      setShop(shopData)
      setCurrent(currentEntry)
      setWaiting(waitingEntries)
      setError(null)

      if (currentEntry) {
        setCurrentOrderFailed(false)
        orderApi.getOne(currentEntry.orderId).then((o) => {
          setCurrentOrder(o)
          if (isZero(o.totalAmount)) {
            setCurrentPayment(null)
          } else {
            paymentApi.getForOrder(o.orderId).then(setCurrentPayment).catch(() => setCurrentPayment(null))
          }
        }).catch(() => {
          setCurrentOrder(null)
          setCurrentPayment(undefined)
          setCurrentOrderFailed(true)
        })
      } else {
        setCurrentOrder(null)
        setCurrentPayment(undefined)
        setCurrentOrderFailed(false)
      }

      const nextFew = waitingEntries.slice(0, 5)
      const fetched = await Promise.all(
        nextFew.map((entry) => orderApi.getOne(entry.orderId).catch(() => null)),
      )
      const map: Record<string, SafeOrder> = {}
      nextFew.forEach((entry, i) => {
        const o = fetched[i]
        if (o) map[entry.orderId] = o
      })
      setWaitingOrders(map)

      const payments = await Promise.all(
        nextFew.map((entry) => {
          const o = map[entry.orderId]
          if (!o || isZero(o.totalAmount)) return Promise.resolve(null)
          return paymentApi.getForOrder(entry.orderId).catch(() => null)
        }),
      )
      const paymentMap: Record<string, SafePayment | null> = {}
      nextFew.forEach((entry, i) => {
        paymentMap[entry.orderId] = payments[i] ?? null
      })
      setWaitingPayments(paymentMap)
    } catch (err) {
      setError(err)
    }
  }, [shopId])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [load])

  async function handleStartNext() {
    if (!shopId) return
    setIsActing(true)
    try {
      await shopQueueApi.startNext(shopId)
      showToast('Printing started.', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not start the next order.', 'error')
    } finally {
      setIsActing(false)
    }
  }

  async function handleComplete() {
    if (!shopId || !current) return
    setIsActing(true)
    try {
      await shopQueueApi.complete(shopId, current.queueId)
      showToast('Marked ready for collection.', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not complete this order.', 'error')
    } finally {
      setIsActing(false)
    }
  }

  // Operational status - staff may toggle only their own shop's
  // acceptingOrders (backend: shopService.updateShop rejects any other
  // field from a SHOP_STAFF caller, and re-derives shop ownership itself).
  async function handleToggleAccepting() {
    if (!shopId || !shop) return
    setIsTogglingStatus(true)
    try {
      const updated = await shopApi.update(shopId, { acceptingOrders: !shop.acceptingOrders })
      setShop(updated)
      showToast(updated.acceptingOrders ? 'Now accepting orders.' : 'Paused new orders.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not update shop status.', 'error')
    } finally {
      setIsTogglingStatus(false)
    }
  }

  if (!shopId) {
    return (
      <div>
        <PageHeader title="Shop Staff Dashboard" />
        <StateBlock
          icon="alert"
          title="No print shop assigned"
          description="Your staff account is not assigned to a print shop. Please contact an administrator."
        />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Shop Staff Dashboard" />
        <ErrorState error={error} onRetry={load} />
      </div>
    )
  }

  if (!shop || waiting === null) {
    return (
      <div>
        <PageHeader title="Shop Staff Dashboard" />
        <Skeleton height={180} radius="18px" />
      </div>
    )
  }

  const nextEntry = waiting[0] ?? null
  // When nothing is currently printing, the immediate next order is already
  // showcased in the "Next up" hero card above - don't repeat that same row
  // in the list below. The displayed "Waiting queue" count still reflects
  // everyone actually waiting, hero row included.
  const restOfQueue = current ? waiting : waiting.slice(1)

  return (
    <div>
      <PageHeader
        title={shop.shopName}
        subtitle="Shop Staff Dashboard"
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {shop.isActive && shop.acceptingOrders ? (
              <Badge tone="success" dot>Accepting orders</Badge>
            ) : (
              <Badge tone="danger">Not accepting orders</Badge>
            )}
            {shop.isActive && (
              <Button size="sm" variant="secondary" onClick={handleToggleAccepting} isLoading={isTogglingStatus}>
                {shop.acceptingOrders ? 'Pause orders' : 'Resume orders'}
              </Button>
            )}
          </div>
        }
      />

      {current ? (
        <Card padded style={{ marginBottom: 20, background: 'var(--color-primary-soft)', border: 'none' }}>
          <p className="text-muted" style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8, color: 'var(--color-primary)' }}>
            Currently printing
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 800, fontSize: 18 }}>Token #{current.queueNumber} · {currentOrder?.orderCode ?? current.orderCode}</p>
              {currentOrder && <p className="text-secondary" style={{ fontSize: 13, marginTop: 2 }}>{currentOrder.customerName}</p>}
              <p style={{ fontWeight: 700, fontSize: 14.5, marginTop: 4 }}>{orderTitle(currentOrder)}</p>
            </div>
            <OrderPaymentBadge order={currentOrder} payment={currentPayment} />
          </div>
          <p className="text-secondary" style={{ fontSize: 13, marginTop: 4 }}>
            {orderSummary(currentOrder)}
            {currentOrder ? ` · ${isZero(currentOrder.totalAmount) ? 'Free' : formatMoney(currentOrder.totalAmount)}` : ''}
          </p>

          <div style={{ marginTop: 14, background: 'var(--color-surface)', borderRadius: 12, padding: '4px 14px' }}>
            <p className="text-muted" style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '10px 0 0' }}>
              Documents{currentOrder ? ` (${currentOrder.items.length})` : ''}
            </p>
            {currentOrderFailed ? (
              <p className="text-secondary" style={{ fontSize: 13, padding: '10px 0' }}>
                Unable to load the documents for this order.{' '}
                <button
                  type="button"
                  onClick={() => void load()}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)', fontWeight: 700, cursor: 'pointer' }}
                >
                  Retry
                </button>
              </p>
            ) : currentOrder ? (
              <OrderDocumentList items={currentOrder.items} showPrice={false} />
            ) : (
              <div style={{ padding: '10px 0' }}>
                <Skeleton height={54} radius="10px" />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <Button onClick={handleComplete} isLoading={isActing}>
              Complete Print
            </Button>
            {currentOrder && (
              <Link to={`/staff/orders/${currentOrder.orderId}`}>
                <Button variant="secondary">View Full Order</Button>
              </Link>
            )}
          </div>
        </Card>
      ) : nextEntry ? (
        <Card padded style={{ marginBottom: 20 }}>
          <p className="text-muted" style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
            Next up
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 800, fontSize: 18 }}>Token #{nextEntry.queueNumber} · {waitingOrders[nextEntry.orderId]?.orderCode ?? nextEntry.orderCode}</p>
              {waitingOrders[nextEntry.orderId] && <p className="text-secondary" style={{ fontSize: 13, marginTop: 2 }}>{waitingOrders[nextEntry.orderId]!.customerName}</p>}
              <p style={{ fontWeight: 700, fontSize: 14.5, marginTop: 4 }}>{orderTitle(waitingOrders[nextEntry.orderId] ?? null)}</p>
            </div>
            <OrderPaymentBadge order={waitingOrders[nextEntry.orderId] ?? null} payment={waitingPayments[nextEntry.orderId]} />
          </div>
          <p className="text-secondary" style={{ fontSize: 13, marginTop: 4 }}>{orderSummary(waitingOrders[nextEntry.orderId] ?? null)}</p>

          {/* Same View/Download actions (and the same server-enforced shop
              authorization) as the "Currently printing" card, so staff can open
              the file before pressing Start Printing. The order comes from the
              already-loaded waitingOrders, so this adds no extra requests. */}
          <div style={{ marginTop: 14, background: 'var(--color-surface-sunken)', borderRadius: 12, padding: '4px 14px' }}>
            <p className="text-muted" style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '10px 0 0' }}>
              Documents{waitingOrders[nextEntry.orderId] ? ` (${waitingOrders[nextEntry.orderId]!.items.length})` : ''}
            </p>
            {waitingOrders[nextEntry.orderId] ? (
              <OrderDocumentList items={waitingOrders[nextEntry.orderId]!.items} showPrice={false} />
            ) : (
              <div style={{ padding: '10px 0' }}>
                <Skeleton height={54} radius="10px" />
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <Button onClick={handleStartNext} isLoading={isActing}>
              Start Printing
            </Button>
            <Link to={`/staff/orders/${nextEntry.orderId}`}>
              <Button variant="secondary">View Order</Button>
            </Link>
          </div>
        </Card>
      ) : (
        <Card padded style={{ marginBottom: 20 }}>
          <StateBlock icon="print" title="Queue is empty" description="No orders are waiting to be printed right now." />
        </Card>
      )}

      <p style={{ fontWeight: 800, marginBottom: 12 }}>Waiting queue ({waiting.length})</p>
      {restOfQueue.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13.5 }}>
          {waiting.length === 0 ? 'Nothing else in line.' : 'Nothing else behind the next order.'}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {restOfQueue.map((entry) => {
            const order = waitingOrders[entry.orderId]
            return (
              <Card key={entry.queueId} padded>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      #{entry.queueNumber} · {order?.orderCode ?? entry.orderCode}
                    </div>
                    {order && (
                      <div className="text-secondary" style={{ fontSize: 12.5, marginTop: 2 }}>{order.customerName}</div>
                    )}
                    <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {order
                        ? `${order.items.length > 1 ? `${order.items.length} documents · ` : ''}${orderSummary(order)}`
                        : 'Loading…'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                    <div className="text-muted" style={{ fontSize: 11.5 }}>{formatTime(entry.enteredAt)}</div>
                    {order && <OrderPaymentBadge order={order} payment={waitingPayments[entry.orderId]} />}
                    <Link to={`/staff/orders/${entry.orderId}`}>
                      <Button size="sm" variant="ghost">View Order</Button>
                    </Link>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
