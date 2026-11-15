export type PaymentMethod = 'UPI' | 'CARD' | 'WALLET' | 'CASH'
export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED'

// Present on a PENDING payment when the backend uses Razorpay: what the
// browser needs to open Razorpay Checkout. Absent with the mock provider.
export interface CheckoutDetails {
  provider: 'razorpay'
  keyId: string
  gatewayOrderId: string
  // Paise
  amount: number
  currency: string
}

export interface SafePayment {
  paymentId: string
  orderId: string
  amount: string
  paymentMethod: PaymentMethod
  transactionId: string
  paymentStatus: PaymentStatus
  createdAt: string
  paidAt: string | null
  checkout?: CheckoutDetails
}

// What Razorpay Checkout hands back after a successful payment; the backend
// verifies it before marking the order paid.
export interface RazorpayCheckoutResult {
  razorpayOrderId: string
  razorpayPaymentId: string
  razorpaySignature: string
}
