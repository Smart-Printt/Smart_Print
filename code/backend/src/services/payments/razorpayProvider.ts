import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ServiceUnavailableError, ValidationError } from '../../utils/errors';
import { generateReference } from '../../utils/transactionId';
import {
  CheckoutDetails,
  ConfirmPaymentParams,
  ConfirmPaymentResult,
  ConfirmRefundParams,
  ConfirmRefundResult,
  InitiatePaymentParams,
  InitiatePaymentResult,
  InitiateRefundParams,
  InitiateRefundResult,
  PaymentProvider,
} from './paymentProvider';

// Razorpay (https://razorpay.com/docs/api/). Works the same with test keys
// (rzp_test_...) and live keys (rzp_live_...); test keys never move real money.
//
// Payment flow:
//   1. initiatePayment creates a Razorpay ORDER for the exact amount; its id
//      (order_...) is our Payment.transactionId.
//   2. The browser opens Razorpay Checkout with that order id. After paying,
//      Checkout returns { razorpay_order_id, razorpay_payment_id,
//      razorpay_signature } and the frontend sends them to /payment/confirm.
//   3. confirmPayment checks the signature (HMAC with our key secret), then
//      asks Razorpay for the payment itself and only reports SUCCESS if it
//      belongs to our order, is for the full amount and is captured.
//   4. A webhook (routes/razorpayWebhook.routes.ts) does the same check for a
//      buyer who paid but closed the tab before step 2.
// Refunds: a student's request only records a reference; the money is sent
// back when an admin processes the refund (confirmRefund).

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  currency?: string;
  apiBaseUrl?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface RazorpayPayment {
  id: string;
  order_id: string | null;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number;
  currency: string;
}

interface RazorpayRefund {
  id: string;
  receipt?: string | null;
  status: 'pending' | 'processed' | 'failed';
}

export function toPaise(amount: Prisma.Decimal): number {
  return amount.mul(100).toDecimalPlaces(0).toNumber();
}

function hmacHex(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyCheckoutSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

export function verifyWebhookSignature(webhookSecret: string, rawBody: Buffer, signature: string): boolean {
  return safeEqualHex(hmacHex(webhookSecret, rawBody.toString('utf8')), signature);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new ValidationError(`${name} is required`);
  }
  return value.trim();
}

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private readonly currency: string;
  private readonly baseUrl: string;

  constructor(
    private readonly config: RazorpayConfig,
    // Looked up on every call (not bound once) so tests can stub global fetch.
    private readonly fetchImpl: FetchLike = (url, init) => (fetch as unknown as FetchLike)(url, init),
  ) {
    this.currency = config.currency ?? 'INR';
    this.baseUrl = config.apiBaseUrl ?? 'https://api.razorpay.com/v1';
  }

  get webhookSecret(): string | undefined {
    return this.config.webhookSecret;
  }

  get isTestMode(): boolean {
    return this.config.keyId.startsWith('rzp_test_');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ServiceUnavailableError('The payment gateway could not be reached. Please try again.');
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    if (!res.ok) {
      // Razorpay's description is safe to show; never log the auth header.
      // eslint-disable-next-line no-console
      console.error(`Razorpay ${method} ${path.split('/')[1]} failed (${res.status}):`, json.error?.description);
      throw new ServiceUnavailableError(
        `The payment gateway refused the request${json.error?.description ? `: ${json.error.description}` : ''}`,
      );
    }
    return json as T;
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    if (params.paymentMethod === 'CASH') {
      throw new ValidationError('Cash is not available for online payment. Choose UPI, card or wallet.');
    }
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: toPaise(params.amount),
      currency: this.currency,
      receipt: params.orderReference.slice(0, 40),
      notes: { smartprint_order: params.orderReference },
    });
    return { providerReference: order.id };
  }

  checkoutFor(providerReference: string, amount: Prisma.Decimal): CheckoutDetails {
    return {
      provider: 'razorpay',
      keyId: this.config.keyId,
      gatewayOrderId: providerReference,
      amount: toPaise(amount),
      currency: this.currency,
    };
  }

  // Shared by confirm (with the checkout signature) and the webhook (already
  // verified by its own signature): is THIS payment a full, captured payment
  // of THIS Razorpay order?
  async settlePayment(gatewayOrderId: string, paymentId: string, amount: Prisma.Decimal): Promise<ConfirmPaymentResult> {
    let payment = await this.call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== gatewayOrderId) {
      throw new ValidationError('This payment does not belong to this order');
    }
    if (payment.amount !== toPaise(amount) || payment.currency !== this.currency) {
      throw new ValidationError('The paid amount does not match the order');
    }
    if (payment.status === 'authorized') {
      // Accounts without auto-capture: capture it now so the money is ours.
      payment = await this.call<RazorpayPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
        amount: payment.amount,
        currency: payment.currency,
      });
    }
    if (payment.status === 'captured') {
      return { outcome: 'SUCCESS' };
    }
    if (payment.status === 'failed') {
      return { outcome: 'FAILED' };
    }
    throw new ValidationError('The payment is not complete yet. Please try again in a moment.');
  }

  async confirmPayment(params: ConfirmPaymentParams): Promise<ConfirmPaymentResult> {
    const response = params.gatewayResponse ?? {};
    const orderId = requireString(response.razorpayOrderId, 'razorpayOrderId');
    const paymentId = requireString(response.razorpayPaymentId, 'razorpayPaymentId');
    const signature = requireString(response.razorpaySignature, 'razorpaySignature');

    if (orderId !== params.providerReference) {
      throw new ValidationError('This payment does not belong to this order');
    }
    if (!verifyCheckoutSignature(this.config.keySecret, orderId, paymentId, signature)) {
      throw new ValidationError('Payment could not be verified');
    }
    return this.settlePayment(orderId, paymentId, params.amount);
  }

  async initiateRefund(params: InitiateRefundParams): Promise<InitiateRefundResult> {
    void params;
    // Only a reference for now: the money moves when an admin processes it.
    return { providerReference: generateReference('RFD') };
  }

  async confirmRefund(params: ConfirmRefundParams): Promise<ConfirmRefundResult> {
    const payments = await this.call<{ items: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(params.originalProviderReference)}/payments`,
    );
    const paid = payments.items.find((p) => p.status === 'captured' || p.status === 'refunded');
    if (!paid) {
      return { outcome: 'FAILED' };
    }

    // Idempotent: if this refund was already sent (e.g. an earlier attempt
    // timed out after Razorpay accepted it), reuse it instead of sending a
    // second one. Our reference is the refund's receipt.
    const existing = await this.call<{ items: RazorpayRefund[] }>(
      'GET',
      `/payments/${encodeURIComponent(paid.id)}/refunds`,
    );
    let refund = existing.items.find((r) => r.receipt === params.providerReference);
    if (!refund) {
      refund = await this.call<RazorpayRefund>('POST', `/payments/${encodeURIComponent(paid.id)}/refund`, {
        amount: toPaise(params.amount),
        receipt: params.providerReference,
        speed: 'normal',
      });
    }
    return { outcome: refund.status === 'failed' ? 'FAILED' : 'SUCCESS' };
  }
}
