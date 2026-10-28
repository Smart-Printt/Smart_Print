import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { RefundStatusBadge } from '@/components/ui/Badge'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { Pager } from '@/components/ui/Pager'
import { PageHeader } from '@/layouts/AppShell'
import { useToast } from '@/hooks/useToast'
import { orderApi } from '@/services/orderApi'
import { refundApi } from '@/services/refundApi'
import type { Pagination, SafeOrder, SafeRefund } from '@/types'
import { ApiError } from '@/types/api'
import { formatDateTime } from '@/utils/date'
import { formatMoney, isZero } from '@/utils/money'

const PAGE_SIZE = 20

interface RefundRow {
  order: SafeOrder
  refund: SafeRefund
}

export function AdminRefundsPage() {
  const { showToast } = useToast()
  const [rows, setRows] = useState<RefundRow[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<Pagination | null>(null)

  async function load() {
    setError(null)
    try {
      const { orders, pagination: pageInfo } = await orderApi.list({ status: ['CANCELLED'], page, limit: PAGE_SIZE })
      setPagination(pageInfo)
      // No dedicated "list all refunds" endpoint exists - refunds are only
      // ever readable per-order (GET /orders/:id/refund). Cancelled, paid
      // orders are the only ones that could ever have one, so that's the
      // full candidate set; a 404 just means no refund was ever requested.
      const candidates = orders.filter((o) => !isZero(o.totalAmount))
      // getForOrder resolves null for "no refund"; a genuine failure rejects
      // and lands in the catch below (the page's error state), rather than
      // silently dropping the row.
      const results = await Promise.all(
        candidates.map(async (order) => {
          const refund = await refundApi.getForOrder(order.orderId)
          return refund ? { order, refund } : null
        }),
      )
      setRows(results.filter((r): r is RefundRow => r !== null))
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    void load()
    // load() reads `page`, so the effect is keyed on it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  function changePage(next: number) {
    setRows(null)
    setPage(next)
  }

  async function handleProcess(orderId: string) {
    setBusyId(orderId)
    try {
      await refundApi.process(orderId)
      showToast('Refund processed.', 'success')
      void load()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not process this refund.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Refunds" subtitle="Review and process refund requests." />

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : rows === null ? (
        <SkeletonCardList count={3} height={100} />
      ) : rows.length === 0 ? (
        <StateBlock icon="gift" title="No refund requests" description="Refund requests from cancelled paid orders will appear here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(({ order, refund }) => (
            <Card key={refund.refundId} padded>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>{order.orderCode}</div>
                  <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {order.shopName} · Requested {formatDateTime(refund.requestedAt)}
                  </div>
                </div>
                <RefundStatusBadge status={refund.refundStatus} />
              </div>
              <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 10 }}>{refund.refundReason}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 800, fontSize: 15 }}>{formatMoney(refund.refundAmount)}</span>
                {refund.refundStatus === 'REQUESTED' && (
                  <Button size="sm" isLoading={busyId === order.orderId} onClick={() => handleProcess(order.orderId)}>
                    Process Refund
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {pagination && (rows !== null || error !== null) && (
        <Pager page={pagination.page} totalPages={pagination.totalPages} total={pagination.total} onPageChange={changePage} />
      )}
    </div>
  )
}
