import { api } from './apiClient'
import type { ApiSuccess, PrintAssistantResult } from '@/types'

export const assistantApi = {
  async interpretPrintRequest(message: string, documentIds: string[]): Promise<PrintAssistantResult> {
    const res = await api.post<ApiSuccess<PrintAssistantResult>>('/assistant/print-request', {
      message,
      documentIds,
    })
    return res.data
  },
}
