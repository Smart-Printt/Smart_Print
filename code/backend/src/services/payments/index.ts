import { readPaymentProviderName } from '../../config/security';
import { mockPaymentProvider } from './mockPaymentProvider';
import { PaymentProvider } from './paymentProvider';

// The single place a payment provider is chosen. payment.service.ts and
// refund.service.ts import `paymentProvider` from here, never a concrete
// provider. Production use of "mock" is refused at startup by
// config/security.ts::assertStartupSafety (and by the mock itself).
export function createPaymentProvider(name: string): PaymentProvider {
  switch (name) {
    case 'mock':
      return mockPaymentProvider;
    default:
      throw new Error(`Unknown payment provider "${name}".`);
  }
}

export const paymentProvider: PaymentProvider = createPaymentProvider(readPaymentProviderName());
