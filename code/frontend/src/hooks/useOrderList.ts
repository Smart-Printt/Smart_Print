import { useEffect, useState } from 'react'

import { orderApi } from '@/services/orderApi'
import type { OrderListParams, PaginatedOrders } from '@/types'

// Loads one page of orders and reloads whenever the params change. While a
// new page is loading `data` is null, and an answer to an older request is
// never shown (the results are tagged with the request they belong to).
export function useOrderList(params: OrderListParams) {
  const paramsKey = JSON.stringify(params)
  const [reloadCount, setReloadCount] = useState(0)
  const requestKey = `${paramsKey}#${reloadCount}`

  const [result, setResult] = useState<{ key: string; data: PaginatedOrders } | null>(null)
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null)

  useEffect(() => {
    let cancelled = false
    orderApi
      .list(JSON.parse(paramsKey) as OrderListParams)
      .then((data) => {
        if (!cancelled) setResult({ key: requestKey, data })
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure({ key: requestKey, error })
      })
    return () => {
      cancelled = true
    }
  }, [paramsKey, requestKey])

  const data = result?.key === requestKey ? result.data : null
  const error = failure?.key === requestKey ? failure.error : null

  return {
    data,
    error,
    isLoading: data === null && error === null,
    reload: () => setReloadCount((count) => count + 1),
  }
}
