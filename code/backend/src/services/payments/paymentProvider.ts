import { PaymentMethod, Prisma } from '@prisma/client';

// PaymentService (payment.service.ts) is written entirely against this
// interface, never against a concrete provider - swapping MockPaymentProvider
// for a real gateway (Razorpay/Stripe/etc.) later means implementing this
// interface, not touching payment.service.ts.

export type ProviderOutcome = 'SUCCESS' | 'FAILED';

export interface InitiatePaymentParams {
  orderReference: string;
  amount: Prisma.Decimal;
  paymentMethod: PaymentMethod;
}

export interface InitiatePaymentResult {
  providerReference: string;
}

// What the browser needs to open a gateway's own payment window (Razorpay
// Checkout). The mock provider has none: it settles on confirm alone.
export interface CheckoutDetails {
  provider: 'razorpay';
  keyId: string;
  gatewayOrderId: string;
  // Smallest currency unit (paise).
  amount: number;
  currency: string;
}

// Returned by the gateway's checkout window after the buyer pays, and
// verified (signature + gateway lookup) - never trusted as-is.
export interface GatewayPaymentResponse {
  razorpayOrderId?: unknown;
  razorpayPaymentId?: unknown;
  razorpaySignature?: unknown;
}

export interface ConfirmPaymentParams {
  providerReference: string;
  // Mock-provider-only test hook - see mockPaymentProvider.ts. A real
  // provider's confirmPayment would instead verify a signed gateway
  // callback/webhook payload and would not accept a client-chosen outcome.
  simulateOutcome?: ProviderOutcome;
  // Real gateways only: the checkout window's signed result.
  gatewayResponse?: GatewayPaymentResponse;
  amount: Prisma.Decimal;
}

export interface ConfirmPaymentResult {
  outcome: ProviderOutcome;
}

// Mirrors initiatePayment/confirmPayment: a refund reference is issued
// up front when the refund is requested (Refund.refundTransactionId is
// NOT NULL - a real gateway also typically hands back a refund reference
// as soon as the refund is submitted), and the outcome is settled later
// when the refund is processed.
export interface InitiateRefundParams {
  originalProviderReference: string;
  amount: Prisma.Decimal;
}

export interface InitiateRefundResult {
  providerReference: string;
}

export interface ConfirmRefundParams {
  providerReference: string;
  // The payment being refunded (its providerReference) and the amount.
  originalProviderReference: string;
  amount: Prisma.Decimal;
  simulateOutcome?: ProviderOutcome;
}

export interface ConfirmRefundResult {
  outcome: ProviderOutcome;
}

export interface PaymentProvider {
  // Stable identifier matching the PAYMENT_PROVIDER setting (e.g. "mock").
  readonly name: string;
  initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult>;
  confirmPayment(params: ConfirmPaymentParams): Promise<ConfirmPaymentResult>;
  initiateRefund(params: InitiateRefundParams): Promise<InitiateRefundResult>;
  confirmRefund(params: ConfirmRefundParams): Promise<ConfirmRefundResult>;
  // Checkout details for a PENDING payment, or null when the provider has no
  // checkout window (mock).
  checkoutFor(providerReference: string, amount: Prisma.Decimal): CheckoutDetails | null;
}
