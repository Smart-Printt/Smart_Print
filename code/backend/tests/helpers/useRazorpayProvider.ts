// Imported FIRST by Razorpay test files: the payment provider is chosen once,
// when src/services/payments is first loaded, so these must be set before.
// Keys are made-up test values; every Razorpay API call is stubbed.
process.env.PAYMENT_PROVIDER = 'razorpay';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fakekey';
process.env.RAZORPAY_KEY_SECRET = 'fake-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fake-webhook-secret';

export const RAZORPAY_KEY_SECRET = 'fake-key-secret';
export const RAZORPAY_WEBHOOK_SECRET = 'fake-webhook-secret';
