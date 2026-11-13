import { generateReference } from '../../utils/transactionId';
import {
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

// NODE_ENV values in which simulated payments may run. An allowlist rather
// than "anything but production", so a mistyped or unexpected NODE_ENV
// (e.g. "staging") disables the mock instead of enabling it.
const MOCK_ALLOWED_NODE_ENVS = ['development', 'test'];

// Second safety net behind the startup guard in config/security.ts: even if
// the mock were somehow wired into a deployed process, it refuses to
// approve anything. Read at call time so it reflects the live process.
function assertMockPaymentsAllowed(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (!MOCK_ALLOWED_NODE_ENVS.includes(nodeEnv)) {
    throw new Error(
      `[payments] The mock payment provider is disabled when NODE_ENV="${nodeEnv}". ` +
        'Simulated payments are only available in development and test.',
    );
  }
}

// Development/testing-only stand-in for a real payment gateway. Never
// contacts a network, never charges anything real. Every method is
// deterministic: an outcome is decided immediately and synchronously,
// rather than settling asynchronously via a webhook the way a real
// provider would - callers that need to exercise both the success and
// failure paths pass `simulateOutcome` explicitly; it defaults to SUCCESS
// so the common case ("just pay") works with no extra input.
class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    assertMockPaymentsAllowed();
    void params;
    return { providerReference: generateReference('TXN') };
  }

  async confirmPayment(params: ConfirmPaymentParams): Promise<ConfirmPaymentResult> {
    assertMockPaymentsAllowed();
    return { outcome: params.simulateOutcome ?? 'SUCCESS' };
  }

  async initiateRefund(params: InitiateRefundParams): Promise<InitiateRefundResult> {
    assertMockPaymentsAllowed();
    void params;
    return { providerReference: generateReference('RFD') };
  }

  async confirmRefund(params: ConfirmRefundParams): Promise<ConfirmRefundResult> {
    assertMockPaymentsAllowed();
    return { outcome: params.simulateOutcome ?? 'SUCCESS' };
  }
}

export const mockPaymentProvider: PaymentProvider = new MockPaymentProvider();
