import { FinishingType, OrderStatus, PaperSize, PrintType, Sides } from '@prisma/client';

export { OrderStatus };

export interface CreateOrderItemInput {
  documentId: unknown;
  copies: unknown;
  printType: unknown;
  paperSize: unknown;
  sides: unknown;
  pageRange?: unknown;
  finishingRuleId?: unknown;
  specialInstructions?: unknown;
}

export interface CreateOrderInput {
  shopId: unknown;
  items: unknown;
}

// Safe, fully-resolved shapes returned by the API - snapshot pricing only,
// never a live join back to current shop pricing.
export interface SafeOrderItem {
  orderDocumentId: string;
  documentId: string;
  fileName: string;
  printType: PrintType;
  paperSize: PaperSize;
  sides: Sides;
  copies: number;
  pageRange: string | null;
  printPageCount: number;
  finishingType: FinishingType | null;
  specialInstructions: string | null;
  pricePerPage: string;
  finishingPrice: string;
  lineTotal: string;
}

export interface SafeOrderStatusEvent {
  status: OrderStatus;
  changedByUserId: string | null;
  changedAt: Date;
  notes: string | null;
}

export interface SafeOrder {
  orderId: string;
  orderCode: string;
  shopId: string;
  shopName: string;
  customerName: string;
  customerEmail: string;
  orderStatus: OrderStatus;
  totalAmount: string;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  items: SafeOrderItem[];
  statusHistory: SafeOrderStatusEvent[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedOrders {
  orders: SafeOrder[];
  pagination: Pagination;
}

// Admin dashboard numbers for orders created since a given moment.
export interface OrderSummary {
  orderCount: number;
  // Decimal string, like every other money value in the API.
  revenue: string;
}
