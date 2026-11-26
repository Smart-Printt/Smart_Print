import type { FinishingType, PaperSize, PrintType, Sides } from './pricing'

export interface PrintAssistantResult {
  settings: {
    printType?: PrintType
    paperSize?: PaperSize
    sides?: Sides
    copies?: number
    pageRange?: string
    finishingType?: FinishingType
    specialInstructions?: string
  }
  shopId: string | null
  shopName: string | null
  finishingRuleId: string | null
  estimatedTotal: string | null
  notes: string[]
  source: 'ai' | 'rules'
}
