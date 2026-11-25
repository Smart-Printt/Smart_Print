import { Prisma } from '@prisma/client';

import { prisma } from '../config/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';

// Admin analytics: read-only aggregates over orders, payments, refunds and
// the print queue. Nothing here writes, and nothing here is per-student
// personal data - only counts, sums and medians.
//
// Definitions (the dashboard repeats these in plain words):
//  - orders:        every order CREATED in the range, any status
//  - gross revenue: successful payments whose paid_at falls in the range
//  - refunded:      PROCESSED refunds whose processed_at falls in the range
//  - net revenue:   gross - refunded
//  - refund rate:   refund requests made in the range / successful payments
//  - median wait:   entered_at -> started_at, for orders that started in range
//  - median print:  started_at -> completed_at, for orders completed in range
// Medians (not averages) so one order left in PRINTING overnight can't
// distort the numbers.

export const ANALYTICS_TIMEZONE = 'Asia/Kolkata';
export const ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;
export type AnalyticsRangeDays = (typeof ANALYTICS_RANGE_DAYS)[number];

export interface AnalyticsReport {
  // 'all' = every shop (admin); 'shop' = one shop's own numbers (its staff).
  scope: { type: 'all' } | { type: 'shop'; shopId: string; shopName: string };
  range: { days: number; timezone: string; from: string; to: string };
  totals: {
    orders: number;
    cancelledOrders: number;
    paidOrders: number;
    grossRevenue: string;
    refundedAmount: string;
    netRevenue: string;
    averageOrderValue: string | null;
    refundRequests: number;
    refundRate: number | null;
    medianWaitMinutes: number | null;
    medianPrintMinutes: number | null;
  };
  daily: { date: string; orders: number; revenue: string }[];
  hourly: { hour: number; orders: number }[];
  shops: {
    shopId: string;
    shopName: string;
    orders: number;
    revenue: string;
    medianWaitMinutes: number | null;
  }[];
}

export function parseRangeDays(raw: unknown): AnalyticsRangeDays {
  if (raw === undefined || raw === null || raw === '') return 30;
  const value = Number(raw);
  if (!ANALYTICS_RANGE_DAYS.includes(value as AnalyticsRangeDays)) {
    throw new ValidationError(`days must be one of ${ANALYTICS_RANGE_DAYS.join(', ')}`);
  }
  return value as AnalyticsRangeDays;
}

// "YYYY-MM-DD" minus n days, using UTC arithmetic on the calendar date only
// (no clock time involved, so no DST/offset surprises).
export function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const money = (value: Prisma.Decimal | null | undefined): string =>
  (value ?? new Prisma.Decimal(0)).toFixed(2);

const roundOne = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;

// Stored timestamps are UTC (`timestamp without time zone`). Converting to
// wall-clock time in the campus timezone is what makes "per day" and "per
// hour" mean what an admin expects.
const localTs = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`((${column}) AT TIME ZONE 'UTC') AT TIME ZONE ${ANALYTICS_TIMEZONE}`;

// Pass a shopId to restrict EVERY figure to that shop; omit for all shops.
// The caller is responsible for authorizing access to that shop first.
export async function getAnalytics(days: AnalyticsRangeDays, shopId?: string): Promise<AnalyticsReport> {
  let scope: AnalyticsReport['scope'] = { type: 'all' };
  if (shopId) {
    const shop = await prisma.printShop.findUnique({ where: { shopId }, select: { shopName: true } });
    if (!shop) throw new NotFoundError('Shop not found');
    scope = { type: 'shop', shopId, shopName: shop.shopName };
  }

  // Shop filters, one per table alias used below. Empty when unscoped.
  const orderShop = shopId ? Prisma.sql`AND o.shop_id = ${shopId}` : Prisma.empty;
  const paymentShop = shopId
    ? Prisma.sql`AND p.order_id IN (SELECT order_id FROM orders WHERE shop_id = ${shopId})`
    : Prisma.empty;
  const refundShop = shopId
    ? Prisma.sql`AND r.payment_id IN (
        SELECT pay.payment_id FROM payments pay JOIN orders ord ON ord.order_id = pay.order_id
        WHERE ord.shop_id = ${shopId})`
    : Prisma.empty;
  const queueShop = shopId
    ? Prisma.sql`AND q.order_id IN (SELECT order_id FROM orders WHERE shop_id = ${shopId})`
    : Prisma.empty;
  const shopRowFilter = shopId ? Prisma.sql`WHERE s.shop_id = ${shopId}` : Prisma.empty;

  const [{ today }] = await prisma.$queryRaw<{ today: string }[]>`
    SELECT to_char(now() AT TIME ZONE ${ANALYTICS_TIMEZONE}, 'YYYY-MM-DD') AS today`;
  const from = shiftDate(today, -(days - 1));
  // First local midnight of the range, as a local wall-clock timestamp.
  const fromTs = Prisma.sql`${from}::date::timestamp`;

  const created = localTs(Prisma.sql`o.created_at`);
  const paid = localTs(Prisma.sql`p.paid_at`);

  const [orderTotals, paymentTotals, refundTotals, waitPrint, dailyOrders, dailyRevenue, hourly, shopRows] =
    await Promise.all([
      prisma.$queryRaw<{ orders: number; cancelled: number }[]>`
        SELECT COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE o.order_status = 'CANCELLED')::int AS cancelled
        FROM orders o WHERE ${created} >= ${fromTs} ${orderShop}`,
      prisma.$queryRaw<{ paid_orders: number; gross: Prisma.Decimal | null }[]>`
        SELECT COUNT(DISTINCT p.order_id)::int AS paid_orders, SUM(p.amount) AS gross
        FROM payments p
        WHERE p.payment_status = 'SUCCESS' AND ${paid} >= ${fromTs} ${paymentShop}`,
      prisma.$queryRaw<{ requests: number; refunded: Prisma.Decimal | null }[]>`
        SELECT COUNT(*) FILTER (WHERE ${localTs(Prisma.sql`r.requested_at`)} >= ${fromTs})::int AS requests,
               SUM(r.refund_amount) FILTER (
                 WHERE r.refund_status = 'PROCESSED'
                   AND ${localTs(Prisma.sql`r.processed_at`)} >= ${fromTs}
               ) AS refunded
        FROM refunds r WHERE TRUE ${refundShop}`,
      prisma.$queryRaw<{ median_wait: number | null; median_print: number | null }[]>`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.started_at - q.entered_at)) / 60)
            FILTER (WHERE q.started_at IS NOT NULL AND ${localTs(Prisma.sql`q.started_at`)} >= ${fromTs}) AS median_wait,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.completed_at - q.started_at)) / 60)
            FILTER (WHERE q.completed_at IS NOT NULL AND q.started_at IS NOT NULL
                      AND ${localTs(Prisma.sql`q.completed_at`)} >= ${fromTs}) AS median_print
        FROM queue q WHERE TRUE ${queueShop}`,
      prisma.$queryRaw<{ day: string; orders: number }[]>`
        SELECT to_char(${created}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders
        FROM orders o WHERE ${created} >= ${fromTs} ${orderShop} GROUP BY 1`,
      prisma.$queryRaw<{ day: string; revenue: Prisma.Decimal }[]>`
        SELECT to_char(${paid}, 'YYYY-MM-DD') AS day, SUM(p.amount) AS revenue
        FROM payments p
        WHERE p.payment_status = 'SUCCESS' AND ${paid} >= ${fromTs} ${paymentShop} GROUP BY 1`,
      prisma.$queryRaw<{ hour: number; orders: number }[]>`
        SELECT EXTRACT(HOUR FROM ${created})::int AS hour, COUNT(*)::int AS orders
        FROM orders o WHERE ${created} >= ${fromTs} ${orderShop} GROUP BY 1`,
      prisma.$queryRaw<
        { shop_id: string; shop_name: string; orders: number; revenue: Prisma.Decimal; median_wait: number | null }[]
      >`
        SELECT s.shop_id, s.shop_name,
               COALESCE(oc.orders, 0)::int AS orders,
               COALESCE(rv.revenue, 0) AS revenue,
               mw.median_wait
        FROM print_shops s
        LEFT JOIN (
          SELECT o.shop_id, COUNT(*) AS orders
          FROM orders o WHERE ${created} >= ${fromTs} GROUP BY o.shop_id
        ) oc ON oc.shop_id = s.shop_id
        LEFT JOIN (
          SELECT o.shop_id, SUM(p.amount) AS revenue
          FROM payments p JOIN orders o ON o.order_id = p.order_id
          WHERE p.payment_status = 'SUCCESS' AND ${paid} >= ${fromTs} GROUP BY o.shop_id
        ) rv ON rv.shop_id = s.shop_id
        LEFT JOIN (
          SELECT o.shop_id,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.started_at - q.entered_at)) / 60) AS median_wait
          FROM queue q JOIN orders o ON o.order_id = q.order_id
          WHERE q.started_at IS NOT NULL AND ${localTs(Prisma.sql`q.started_at`)} >= ${fromTs}
          GROUP BY o.shop_id
        ) mw ON mw.shop_id = s.shop_id
        ${shopRowFilter}
        ORDER BY orders DESC, s.shop_name ASC`,
    ]);

  const gross = paymentTotals[0]?.gross ?? new Prisma.Decimal(0);
  const refunded = refundTotals[0]?.refunded ?? new Prisma.Decimal(0);
  const paidOrders = paymentTotals[0]?.paid_orders ?? 0;
  const refundRequests = refundTotals[0]?.requests ?? 0;

  const ordersByDay = new Map(dailyOrders.map((r) => [r.day, r.orders]));
  const revenueByDay = new Map(dailyRevenue.map((r) => [r.day, r.revenue]));
  const daily = Array.from({ length: days }, (_, i) => {
    const date = shiftDate(from, i);
    return { date, orders: ordersByDay.get(date) ?? 0, revenue: money(revenueByDay.get(date)) };
  });

  const ordersByHour = new Map(hourly.map((r) => [r.hour, r.orders]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: ordersByHour.get(hour) ?? 0 }));

  return {
    scope,
    range: { days, timezone: ANALYTICS_TIMEZONE, from, to: today },
    totals: {
      orders: orderTotals[0]?.orders ?? 0,
      cancelledOrders: orderTotals[0]?.cancelled ?? 0,
      paidOrders,
      grossRevenue: money(gross),
      refundedAmount: money(refunded),
      netRevenue: money(gross.minus(refunded)),
      averageOrderValue: paidOrders > 0 ? money(gross.dividedBy(paidOrders)) : null,
      refundRequests,
      refundRate: paidOrders > 0 ? Math.round((refundRequests / paidOrders) * 1000) / 1000 : null,
      medianWaitMinutes: roundOne(waitPrint[0]?.median_wait),
      medianPrintMinutes: roundOne(waitPrint[0]?.median_print),
    },
    daily,
    hourly: hours,
    shops: shopRows.map((r) => ({
      shopId: r.shop_id,
      shopName: r.shop_name,
      orders: r.orders,
      revenue: money(r.revenue),
      medianWaitMinutes: roundOne(r.median_wait),
    })),
  };
}
