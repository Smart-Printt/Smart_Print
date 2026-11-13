import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { useAuth } from '@/hooks/useAuth'
import { useOrderList } from '@/hooks/useOrderList'
import { queueApi } from '@/services/queueApi'
import type { OrderStatus, SafeOrder, SafeQueueEntry } from '@/types'
import { greetingForNow } from '@/utils/date'
import { isZero } from '@/utils/money'

const PRIORITY: OrderStatus[] = ['PRINTING', 'QUEUED', 'PAYMENT_CONFIRMED', 'PLACED']
const ACTIVE_ORDER_PARAMS = { status: PRIORITY, limit: 20 }

function pickActiveOrder(orders: SafeOrder[]): SafeOrder | null {
  for (const status of PRIORITY) {
    const match = orders.find((o) => o.orderStatus === status)
    if (match) return match
  }
  return null
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [queue, setQueue] = useState<SafeQueueEntry | null>(null)
  // Only the orders that can be "active" are fetched, newest first.
  const { data, error, reload: load } = useOrderList(ACTIVE_ORDER_PARAMS)
  const orders = data?.orders ?? null

  const activeOrder = useMemo(() => (orders ? pickActiveOrder(orders) : null), [orders])

  useEffect(() => {
    if (!activeOrder || !['QUEUED', 'PRINTING'].includes(activeOrder.orderStatus)) {
      setQueue(null)
      return
    }
    let cancelled = false
    queueApi
      .getForOrder(activeOrder.orderId)
      .then((entry) => {
        if (!cancelled) setQueue(entry)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeOrder])

  const firstName = user?.name.split(' ')[0] ?? ''

  return (
    <div>
      <p style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>
        {greetingForNow()}, {firstName} 👋
      </p>
      <p className="text-secondary" style={{ marginBottom: 28 }}>
        {user?.role === 'FACULTY'
          ? 'Ready to send something to print?'
          : "Here's what's happening with your prints."}
      </p>

      <Card
        padded
        interactive
        onClick={() => navigate('/print')}
        style={{
          background: 'linear-gradient(135deg, #4338ff 0%, #2c22b3 100%)',
          border: 'none',
          color: '#fff',
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <p style={{ fontWeight: 800, fontSize: 19, marginBottom: 4 }}>Start a Print</p>
            <p style={{ fontSize: 13.5, opacity: 0.85 }}>Upload a document and send it to a shop in seconds.</p>
          </div>
          <span style={{ width: 46, height: 46, borderRadius: 14, background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="arrowRight" size={22} />
          </span>
        </div>
      </Card>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : orders === null ? (
        <Skeleton height={160} radius="18px" />
      ) : activeOrder ? (
        <ActiveOrderCard order={activeOrder} queue={queue} />
      ) : (
        <Card padded>
          <StateBlock
            icon="print"
            title="Nothing printing yet"
            description="Your next print is just a few taps away."
            action={
              <Link to="/print">
                <Button>
                  Start Printing <Icon name="arrowRight" size={15} />
                </Button>
              </Link>
            }
          />
        </Card>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <Link to="/documents" style={{ flex: 1 }}>
          <Card interactive padded style={{ textAlign: 'center' }}>
            <Icon name="upload" size={20} style={{ margin: '0 auto 8px', color: 'var(--color-primary)' }} />
            <p style={{ fontWeight: 700, fontSize: 13.5 }}>Upload document</p>
          </Card>
        </Link>
        <Link to="/orders" style={{ flex: 1 }}>
          <Card interactive padded style={{ textAlign: 'center' }}>
            <Icon name="orders" size={20} style={{ margin: '0 auto 8px', color: 'var(--color-primary)' }} />
            <p style={{ fontWeight: 700, fontSize: 13.5 }}>Order history</p>
          </Card>
        </Link>
      </div>
    </div>
  )
}

function ActiveOrderCard({ order, queue }: { order: SafeOrder; queue: SafeQueueEntry | null }) {
  const navigate = useNavigate()
  const documentName =
    order.items.length === 1 ? order.items[0]?.fileName ?? 'Your document' : `${order.items.length} documents`
  const isFree = isZero(order.totalAmount)

  if (order.orderStatus === 'PRINTING') {
    return (
      <Card padded interactive onClick={() => navigate(`/orders/${order.orderId}`)}>
        <p className="text-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
          Printing now
        </p>
        <p style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>{documentName}</p>
        <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 12 }}>{order.shopName}</p>
        {queue && <p style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 12 }}>Token #{queue.queueNumber} · Currently printing</p>}
        <Button size="sm">
          Track Order <Icon name="arrowRight" size={14} />
        </Button>
      </Card>
    )
  }

  if (order.orderStatus === 'QUEUED' && queue) {
    return (
      <Card padded interactive onClick={() => navigate(`/orders/${order.orderId}`)}>
        <p className="text-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
          You're in the queue
        </p>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: "'Manrope', sans-serif", fontSize: 30, fontWeight: 800 }}>#{queue.position}</span>
          {queue.position !== null && queue.position > 1 && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {queue.position - 1} {queue.position - 1 === 1 ? 'order' : 'orders'} ahead of you
            </span>
          )}
        </div>
        <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 12 }}>{order.shopName}</p>
        {isFree && <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>Faculty printing — no payment required.</p>}
        <Button size="sm">
          View Queue <Icon name="arrowRight" size={14} />
        </Button>
        <p className="text-muted" style={{ fontSize: 11.5, marginTop: 10 }}>Position updates automatically.</p>
      </Card>
    )
  }

  return (
    <Card padded interactive onClick={() => navigate(`/orders/${order.orderId}`)}>
      <p className="text-muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        {order.orderStatus === 'PLACED' ? 'Awaiting payment' : 'Payment confirmed'}
      </p>
      <p style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>{documentName}</p>
      <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 12 }}>{order.shopName}</p>
      <Button size="sm">Continue</Button>
    </Card>
  )
}
