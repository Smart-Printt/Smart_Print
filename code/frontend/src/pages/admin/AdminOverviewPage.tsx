import { useEffect, useState } from 'react'

import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import type { IconName } from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/StateBlock'
import { PageHeader } from '@/layouts/AppShell'
import { orderApi } from '@/services/orderApi'
import { shopApi } from '@/services/shopApi'
import { shopQueueApi } from '@/services/shopQueueApi'
import type { SafeShop } from '@/types'
import { formatMoney } from '@/utils/money'

// Midnight at the start of today in the admin's own timezone.
function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

interface Metrics {
  activeShops: number
  totalShops: number
  ordersToday: number
  revenueToday: number
  ordersInQueue: number
}

export function AdminOverviewPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function load() {
    setError(null)
    try {
      // The server counts today's orders and sums revenue, so the overview
      // never downloads the orders themselves.
      const [shops, summary] = await Promise.all([shopApi.list(), orderApi.summary(startOfToday())])
      const queueCounts = await Promise.all(
        shops.map(async (shop: SafeShop) => {
          const [waiting, current] = await Promise.all([
            shopQueueApi.list(shop.shopId).catch(() => []),
            shopQueueApi.current(shop.shopId).catch(() => null),
          ])
          return waiting.length + (current ? 1 : 0)
        }),
      )

      setMetrics({
        activeShops: shops.filter((s) => s.isActive).length,
        totalShops: shops.length,
        ordersToday: summary.orderCount,
        revenueToday: Number(summary.revenue),
        ordersInQueue: queueCounts.reduce((a, b) => a + b, 0),
      })
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div>
      <PageHeader title="Overview" subtitle="A snapshot of SmartPrint right now." />

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !metrics ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={100} radius="18px" />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <MetricCard icon="shop" label="Active Shops" value={`${metrics.activeShops} / ${metrics.totalShops}`} />
          <MetricCard icon="orders" label="Orders Today" value={String(metrics.ordersToday)} />
          <MetricCard icon="clock" label="Orders in Queue" value={String(metrics.ordersInQueue)} />
          <MetricCard icon="gift" label="Revenue Today" value={formatMoney(metrics.revenueToday)} />
        </div>
      )}
    </div>
  )
}

function MetricCard({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <Card padded>
      <span style={{ width: 38, height: 38, borderRadius: 12, background: 'var(--color-primary-soft)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
        <Icon name={icon} size={18} />
      </span>
      <p className="text-muted" style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Manrope', sans-serif" }}>{value}</p>
    </Card>
  )
}
