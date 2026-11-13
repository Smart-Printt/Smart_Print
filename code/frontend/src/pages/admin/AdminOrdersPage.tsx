import { useMemo, useState } from 'react'

import { Card } from '@/components/ui/Card'
import { OrderStatusBadge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Pager } from '@/components/ui/Pager'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useOrderList } from '@/hooks/useOrderList'
import { PageHeader } from '@/layouts/AppShell'
import type { OrderStatus } from '@/types'
import { formatDateTime } from '@/utils/date'
import { formatMoney } from '@/utils/money'

const PAGE_SIZE = 20

const STATUS_FILTERS: (OrderStatus | 'ALL')[] = [
  'ALL',
  'PLACED',
  'PAYMENT_CONFIRMED',
  'QUEUED',
  'PRINTING',
  'READY',
  'COLLECTED',
  'CANCELLED',
]

export function AdminOrdersPage() {
  const [filter, setFilter] = useState<OrderStatus | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim())

  // Filtering, searching and paging all happen on the server.
  const params = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      status: filter === 'ALL' ? undefined : [filter],
      q: debouncedSearch || undefined,
    }),
    [page, filter, debouncedSearch],
  )
  const { data, error, reload } = useOrderList(params)
  const orders = data?.orders ?? null

  function changeFilter(next: OrderStatus | 'ALL') {
    setFilter(next)
    setPage(1)
  }

  function changeSearch(next: string) {
    setSearch(next)
    setPage(1)
  }

  return (
    <div>
      <PageHeader title="Orders" subtitle="Every order placed across all shops." />

      <div style={{ maxWidth: 360, marginBottom: 14 }}>
        <Input
          type="search"
          placeholder="Search by order code"
          aria-label="Search by order code"
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
          maxLength={40}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 20, paddingBottom: 4 }}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className={`segmented__option ${filter === s ? 'is-active' : ''}`}
            style={{ background: filter === s ? 'var(--color-primary-soft)' : 'var(--color-surface-sunken)', color: filter === s ? 'var(--color-primary)' : undefined, flexShrink: 0 }}
            onClick={() => changeFilter(s)}
          >
            {s === 'ALL' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : orders === null ? (
        <SkeletonCardList count={4} height={80} />
      ) : orders.length === 0 ? (
        <StateBlock icon="orders" title="No orders found" description="Try a different filter or search." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {orders.map((order) => (
            <Card key={order.orderId} padded>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>{order.orderCode}</div>
                  <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {order.shopName} · {formatDateTime(order.createdAt)}
                  </div>
                </div>
                <OrderStatusBadge status={order.orderStatus} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="text-secondary" style={{ fontSize: 13 }}>
                  {order.items.length} {order.items.length === 1 ? 'document' : 'documents'}
                </span>
                <span style={{ fontWeight: 700 }}>{formatMoney(order.totalAmount)}</span>
              </div>
            </Card>
          ))}
          {data && <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPageChange={setPage} />}
        </div>
      )}
    </div>
  )
}
