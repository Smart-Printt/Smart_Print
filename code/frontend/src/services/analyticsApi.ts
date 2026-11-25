import { api } from './apiClient'
import type { AnalyticsRangeDays, AnalyticsReport, ApiSuccess } from '@/types'

export const analyticsApi = {
  async get(days: AnalyticsRangeDays, signal?: AbortSignal): Promise<AnalyticsReport> {
    const res = await api.get<ApiSuccess<{ analytics: AnalyticsReport }>>(`/admin/analytics?days=${days}`, signal)
    return res.data.analytics
  },

  // One shop's own numbers: its staff (or an admin).
  async getForShop(shopId: string, days: AnalyticsRangeDays, signal?: AbortSignal): Promise<AnalyticsReport> {
    const res = await api.get<ApiSuccess<{ analytics: AnalyticsReport }>>(
      `/shops/${encodeURIComponent(shopId)}/analytics?days=${days}`,
      signal,
    )
    return res.data.analytics
  },
}
