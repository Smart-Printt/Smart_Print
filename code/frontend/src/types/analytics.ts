export type AnalyticsRangeDays = 7 | 30 | 90

// Money fields are decimal strings, like everywhere else in the API.
export interface AnalyticsReport {
  // 'all' = every shop (admin); 'shop' = one shop's own numbers (its staff).
  scope: { type: 'all' } | { type: 'shop'; shopId: string; shopName: string }
  range: { days: number; timezone: string; from: string; to: string }
  totals: {
    orders: number
    cancelledOrders: number
    paidOrders: number
    grossRevenue: string
    refundedAmount: string
    netRevenue: string
    averageOrderValue: string | null
    refundRequests: number
    refundRate: number | null
    medianWaitMinutes: number | null
    medianPrintMinutes: number | null
  }
  daily: { date: string; orders: number; revenue: string }[]
  hourly: { hour: number; orders: number }[]
  shops: {
    shopId: string
    shopName: string
    orders: number
    revenue: string
    medianWaitMinutes: number | null
  }[]
}
