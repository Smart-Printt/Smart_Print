import type { FinishingType, PaperSize, PrintType, Sides } from './pricing'

export type OrderStatus =
  | 'PLACED'
  | 'PAYMENT_CONFIRMED'
  | 'QUEUED'
  | 'PRINTING'
  | 'READY'
  | 'COLLECTED'
  | 'CANCELLED'

export const CANCELLABLE_ORDER_STATUSES: OrderStatus[] = ['PLACED', 'PAYMENT_CONFIRMED', 'QUEUED']

export interface SafeOrderItem {
  orderDocumentId: string
  documentId: string
  fileName: string
  printType: PrintType
  paperSize: PaperSize
  sides: Sides
  copies: number
  pageRange: string | null
  printPageCount: number
  finishingType: FinishingType | null
  specialInstructions: string | null
  pricePerPage: string
  finishingPrice: string
  lineTotal: string
}

export interface SafeOrderStatusEvent {
  status: OrderStatus
  changedByUserId: string | null
  changedAt: string
  notes: string | null
}

export interface SafeOrder {
  orderId: string
  orderCode: string
  shopId: string
  shopName: string
  customerName: string
  customerEmail: string
  orderStatus: OrderStatus
  totalAmount: string
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  cancelledReason: string | null
  items: SafeOrderItem[]
  statusHistory: SafeOrderStatusEvent[]
}

export interface CreateOrderItemInput {
  documentId: string
  copies: number
  printType: PrintType
  paperSize: PaperSize
  sides: Sides
  pageRange?: string
  finishingRuleId?: string
  specialInstructions?: string
}

export interface CreateOrderInput {
  shopId: string
  items: CreateOrderItemInput[]
}

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface PaginatedOrders {
  orders: SafeOrder[]
  pagination: Pagination
}

// Every field is optional: the server defaults to page 1, 20 per page, any status.
export interface OrderListParams {
  page?: number
  limit?: number
  status?: OrderStatus[]
  from?: string
  to?: string
  shopId?: string
  q?: string
}

export interface OrderSummary {
  orderCount: number
  revenue: string
}
