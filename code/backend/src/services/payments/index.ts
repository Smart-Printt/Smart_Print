import { readPaymentProviderName } from '../../config/security';
import { mockPaymentProvider } from './mockPaymentProvider';
import { PaymentProvider } from './paymentProvider';
import { RazorpayPaymentProvider } from './razorpayProvider';

export function readRazorpayConfig() {
  return {
    keyId: (process.env.RAZORPAY_KEY_ID ?? '').trim(),
    keySecret: (process.env.RAZORPAY_KEY_SECRET ?? '').trim(),
    webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim() || undefined,
  };
}

// The single place a payment provider is chosen. payment.service.ts and
// refund.service.ts import `paymentProvider` from here, never a concrete
// provider. Production use of "mock" is refused at startup by
// config/security.ts::assertStartupSafety (and by the mock itself).
export function createPaymentProvider(name: string): PaymentProvider {
  switch (name) {
    case 'mock':
      return mockPaymentProvider;
    case 'razorpay': {
      const config = readRazorpayConfig();
      if (!config.keyId || !config.keySecret) {
        throw new Error('PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
      }
      // Without the webhook, a student who pays and closes the tab before
      // returning to the site would be charged but never queued.
      if ((process.env.NODE_ENV ?? 'development') === 'production' && !config.webhookSecret) {
        throw new Error('PAYMENT_PROVIDER=razorpay needs RAZORPAY_WEBHOOK_SECRET in production.');
      }
      return new RazorpayPaymentProvider(config);
    }
    default:
      throw new Error(`Unknown payment provider "${name}".`);
  }
}

export const paymentProvider: PaymentProvider = createPaymentProvider(readPaymentProviderName());
