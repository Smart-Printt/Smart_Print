import { PaymentMethod, PaymentStatus } from '@prisma/client';

import { CheckoutDetails, GatewayPaymentResponse } from '../services/payments/paymentProvider';

export interface InitiatePaymentInput {
  paymentMethod: unknown;
}

// Mock-provider-only test hook (see mockPaymentProvider.ts) - never present
// on a real gateway's callback shape, which would instead carry a signed
// payload the backend verifies rather than trusts.
export interface ConfirmPaymentInput {
  simulateOutcome?: unknown;
  // Razorpay Checkout's signed result (real gateway only).
  gatewayResponse?: GatewayPaymentResponse;
}

// Safe, API-facing shape - amount is a string (Decimal.toString()), same
// convention as SafeOrder.totalAmount.
export interface SafePayment {
  paymentId: string;
  orderId: string;
  amount: string;
  paymentMethod: PaymentMethod;
  transactionId: string;
  paymentStatus: PaymentStatus;
  createdAt: Date;
  paidAt: Date | null;
  // Only for a PENDING payment with a real gateway: what the browser needs to
  // open the gateway's payment window. Absent for the mock provider.
  checkout?: CheckoutDetails;
}
