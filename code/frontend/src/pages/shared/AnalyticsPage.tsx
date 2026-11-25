import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { ColumnChart } from '@/components/charts/ColumnChart'
import type { ColumnDatum } from '@/components/charts/ColumnChart'
import { RankedBars } from '@/components/charts/RankedBars'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/StateBlock'
import { PageHeader } from '@/layouts/AppShell'
import { analyticsApi } from '@/services/analyticsApi'
import type { AnalyticsRangeDays, AnalyticsReport } from '@/types'
import { hourLabel } from '@/utils/hours'
import { formatMoney } from '@/utils/money'

const RANGES: { days: AnalyticsRangeDays; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
]

// "2026-11-25" -> a local Date at midnight (no timezone shift of the day).
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function formatMinutes(value: number | null): string {
  if (value === null) return '—'
  return value < 1 ? '<1 min' : `${value} min`
}

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${Math.round(value * 1000) / 10}%`
}

interface AnalyticsPageProps {
  // Set for a shop's own view (its staff); omit for the all-shops admin view.
  shopId?: string
}

export function AnalyticsPage({ shopId }: AnalyticsPageProps = {}) {
  const [days, setDays] = useState<AnalyticsRangeDays>(30)
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const load = useCallback(async () => {
    setIsRefreshing(true)
    try {
      setReport(shopId ? await analyticsApi.getForShop(shopId, days) : await analyticsApi.get(days))
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setIsRefreshing(false)
    }
  }, [days, shopId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle={
          report?.scope.type === 'shop'
            ? `${report.scope.shopName} — orders, revenue and waiting times for your shop.`
            : shopId
              ? 'Orders, revenue and waiting times for your shop.'
              : 'How SmartPrint is being used, across all shops.'
        }
      />

      {/* One filter row above everything it scopes. */}
      <div role="group" aria-label="Date range" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {RANGES.map((range) => (
          <button
            key={range.days}
            type="button"
            className={`btn btn--sm ${days === range.days ? 'btn--primary' : 'btn--secondary'}`}
            aria-pressed={days === range.days}
            onClick={() => setDays(range.days)}
          >
            {range.label}
          </button>
        ))}
      </div>

      {error && !report ? (
        <ErrorState error={error} onRetry={load} />
      ) : !report ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 16 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={96} radius="18px" />
          ))}
        </div>
      ) : (
        // Refetching keeps the previous render, just dimmed - no skeleton, no layout jump.
        <div style={{ opacity: isRefreshing ? 0.55 : 1, transition: 'opacity 0.15s' }} aria-busy={isRefreshing}>
          {error !== null && (
            <p role="alert" style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>
              Could not refresh — showing the last loaded numbers.
            </p>
          )}
          <Dashboard report={report} />
        </div>
      )}
    </div>
  )
}

function Dashboard({ report }: { report: AnalyticsReport }) {
  const { totals } = report

  const dailyData: ColumnDatum[] = report.daily.map((d) => {
    const date = parseDay(d.date)
    return {
      key: d.date,
      label: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      fullLabel: date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
      value: d.orders,
    }
  })
  const labelEvery = report.range.days <= 7 ? 1 : report.range.days <= 30 ? 5 : 15

  const hourlyData: ColumnDatum[] = report.hourly.map((h) => ({
    key: String(h.hour),
    label: hourLabel(h.hour, true),
    fullLabel: `${hourLabel(h.hour)} – ${hourLabel((h.hour + 1) % 24)}`,
    value: h.orders,
  }))
  const peak = report.hourly.reduce((best, h) => (h.orders > best.orders ? h : best), report.hourly[0]!)
  const hasHourlyData = peak.orders > 0

  return (
    <>
      {totals.orders === 0 && (
        <p className="text-secondary" style={{ fontSize: 13.5, marginBottom: 16 }}>
          No orders in this period yet — the charts will fill in as students print.
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 20 }}>
        <StatTile label="Orders" value={String(totals.orders)} hint={`${totals.cancelledOrders} cancelled`} />
        <StatTile
          label="Net revenue"
          value={formatMoney(totals.netRevenue)}
          hint={`${formatMoney(totals.grossRevenue)} paid − ${formatMoney(totals.refundedAmount)} refunded`}
        />
        <StatTile
          label="Average order"
          value={totals.averageOrderValue === null ? '—' : formatMoney(totals.averageOrderValue)}
          hint={`${totals.paidOrders} paid orders`}
        />
        <StatTile label="Refund rate" value={formatPercent(totals.refundRate)} hint={`${totals.refundRequests} requests`} />
        <StatTile label="Median wait" value={formatMinutes(totals.medianWaitMinutes)} hint="Joined queue → printing starts" />
        <StatTile label="Median print time" value={formatMinutes(totals.medianPrintMinutes)} hint="Printing starts → ready" />
      </div>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <ChartCard
          title="Orders per day"
          subtitle={`Orders placed each day, ${report.range.from} to ${report.range.to}`}
          table={
            <DataTable
              headers={['Date', 'Orders', 'Paid revenue']}
              rows={report.daily.map((d) => [d.date, String(d.orders), formatMoney(d.revenue)])}
            />
          }
        >
          <ColumnChart data={dailyData} unit="orders" ariaLabel="Orders per day" labelEvery={labelEvery} />
        </ChartCard>

        <ChartCard
          title="Busiest hours"
          subtitle={
            hasHourlyData
              ? `Orders by hour of day — peak is ${hourLabel(peak.hour)} (${peak.orders} orders)`
              : 'Orders by hour of day'
          }
          table={
            <DataTable
              headers={['Hour', 'Orders']}
              rows={report.hourly.map((h) => [`${hourLabel(h.hour)} – ${hourLabel((h.hour + 1) % 24)}`, String(h.orders)])}
            />
          }
        >
          <ColumnChart
            data={hourlyData}
            unit="orders"
            ariaLabel="Orders by hour of day"
            labelEvery={3}
            highlightKey={hasHourlyData ? String(peak.hour) : null}
          />
        </ChartCard>
      </div>

      {report.scope.type === 'all' && (
      <div style={{ marginTop: 20 }}>
        <ChartCard
          title="Shop load"
          subtitle="Orders per shop, busiest first. Revenue counts paid orders before refunds."
          table={
            <DataTable
              headers={['Shop', 'Orders', 'Paid revenue', 'Median wait']}
              rows={report.shops.map((s) => [s.shopName, String(s.orders), formatMoney(s.revenue), formatMinutes(s.medianWaitMinutes)])}
            />
          }
        >
          {report.shops.length === 0 ? (
            <p className="text-secondary" style={{ fontSize: 13.5 }}>No shops yet.</p>
          ) : (
            <RankedBars
              unit="orders"
              ariaLabel="Orders per shop"
              rows={report.shops.map((s) => ({
                key: s.shopId,
                name: s.shopName,
                value: s.orders,
                detail: `${formatMoney(s.revenue)} paid · median wait ${formatMinutes(s.medianWaitMinutes)}`,
              }))}
            />
          )}
        </ChartCard>
      </div>
      )}

      <p className="text-muted" style={{ fontSize: 12, marginTop: 16 }}>
        Times use {report.range.timezone}. Waits and print times are medians, so one order left open overnight can’t skew them.
      </p>
    </>
  )
}

function StatTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card padded>
      <p className="text-muted" style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{label}</p>
      <p style={{ fontSize: 26, fontWeight: 800, fontFamily: "'Manrope', sans-serif", lineHeight: 1.1 }}>{value}</p>
      <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>{hint}</p>
    </Card>
  )
}

function ChartCard({ title, subtitle, children, table }: { title: string; subtitle: string; children: ReactNode; table: ReactNode }) {
  return (
    <Card padded>
      <p style={{ fontWeight: 800 }}>{title}</p>
      <p className="text-muted" style={{ fontSize: 12.5, margin: '2px 0 16px' }}>{subtitle}</p>
      {children}
      <details style={{ marginTop: 14 }}>
        <summary className="text-secondary" style={{ fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
          View as table
        </summary>
        <div style={{ marginTop: 10, maxHeight: 260, overflow: 'auto' }}>{table}</div>
      </details>
    </Card>
  )
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th
              key={h}
              scope="col"
              className="text-muted"
              style={{ textAlign: i === 0 ? 'left' : 'right', padding: '6px 8px', borderBottom: '1px solid var(--color-border)', fontWeight: 700 }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td
                key={i}
                style={{
                  textAlign: i === 0 ? 'left' : 'right',
                  padding: '6px 8px',
                  borderBottom: '1px solid var(--color-border)',
                  fontVariantNumeric: i === 0 ? undefined : 'tabular-nums',
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
