import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Card } from '@/components/ui/Card'
import { Pager } from '@/components/ui/Pager'
import { OrderStatusBadge } from '@/components/ui/Badge'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { useOrderList } from '@/hooks/useOrderList'
import { PageHeader } from '@/layouts/AppShell'
import type { OrderStatus } from '@/types'
import { formatDate } from '@/utils/date'
import { formatMoney } from '@/utils/money'

type Tab = 'active' | 'completed' | 'cancelled'

const ACTIVE_STATUSES: OrderStatus[] = ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED', 'PRINTING', 'READY']
const COMPLETED_STATUSES: OrderStatus[] = ['COLLECTED']
const CANCELLED_STATUSES: OrderStatus[] = ['CANCELLED']

const PAGE_SIZE = 10

const TABS: { key: Tab; label: string; statuses: OrderStatus[] }[] = [
  { key: 'active', label: 'Active', statuses: ACTIVE_STATUSES },
  { key: 'completed', label: 'Completed', statuses: COMPLETED_STATUSES },
  { key: 'cancelled', label: 'Cancelled', statuses: CANCELLED_STATUSES },
]

export function OrdersPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('active')
  const [page, setPage] = useState(1)

  const activeTabDef = TABS.find((t) => t.key === tab)!
  // The server does the filtering and paging: only the current tab's page is
  // ever downloaded.
  const params = useMemo(
    () => ({ status: activeTabDef.statuses, page, limit: PAGE_SIZE }),
    [activeTabDef, page],
  )
  const { data, error, reload } = useOrderList(params)
  const orders = data?.orders ?? null
  const filtered = orders ?? []

  function changeTab(next: Tab) {
    setTab(next)
    setPage(1)
  }

  return (
    <div>
      <PageHeader title="My Orders" subtitle="Track and manage everything you've printed." />

      <div className="segmented" style={{ marginBottom: 22 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`segmented__option ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => changeTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : orders === null ? (
        <SkeletonCardList count={3} height={92} />
      ) : filtered.length === 0 ? (
        <StateBlock
          icon="orders"
          title={tab === 'active' ? 'Nothing here yet' : `No ${tab} orders`}
          description={tab === 'active' ? 'Your print history will appear here.' : undefined}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((order) => (
            <Card key={order.orderId} interactive padded onClick={() => navigate(`/orders/${order.orderId}`)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>{order.orderCode}</div>
                  <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {order.shopName} · {formatDate(order.createdAt)}
                  </div>
                </div>
                <OrderStatusBadge status={order.orderStatus} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="text-secondary" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {order.items.map((i) => i.fileName).join(', ')}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14, flexShrink: 0, marginLeft: 12 }}>
                  {formatMoney(order.totalAmount)}
                </span>
              </div>
            </Card>
          ))}
          {data && <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPageChange={setPage} />}
        </div>
      )}
    </div>
  )
}
