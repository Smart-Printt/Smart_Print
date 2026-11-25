// Must be first: selects the Razorpay provider before the app is loaded.
import { RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } from './helpers/useRazorpayProvider';

import crypto from 'node:crypto';

import { PrintShop } from '@prisma/client';
import request from 'supertest';

import { prisma } from '../src/config/prisma';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// The real flow with Razorpay as the provider. Razorpay's API is stubbed by
// replacing global fetch - nothing here talks to the network.

jest.setTimeout(90_000);

const fx = createRaceFixtures('razorpay.');

let student: TestUser;
let admin: TestUser;
let shop: PrintShop;

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let routes: Record<string, (call: Call) => unknown>;
let gatewayCounter = 0;

function stubRazorpay(): void {
  calls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/v1', ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: { description: `no stub for ${key}` } }), { status: 400 });
    }
    return new Response(JSON.stringify(handler(call)), { status: 200 });
  });
}

function sign(orderId: string, paymentId: string): string {
  return crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

beforeAll(async () => {
  student = await fx.registerStudent('student');
  admin = await fx.createAdmin('admin');
  shop = await fx.createShop('shop');
});

beforeEach(() => {
  routes = {};
  stubRazorpay();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

// Creates an order and starts a Razorpay payment for it.
async function startPayment(method = 'UPI') {
  const orderId = await fx.createOrder(student.token, shop);
  gatewayCounter += 1;
  const gatewayOrderId = `order_TEST${Date.now()}${gatewayCounter}`;
  routes['POST /orders'] = () => ({ id: gatewayOrderId, status: 'created' });
  const res = await request(fx.app)
    .post(`/api/orders/${orderId}/payment`)
    .set('Authorization', `Bearer ${student.token}`)
    .send({ paymentMethod: method });
  return { orderId, gatewayOrderId, res };
}

function confirm(orderId: string, body: Record<string, unknown>) {
  return request(fx.app)
    .post(`/api/orders/${orderId}/payment/confirm`)
    .set('Authorization', `Bearer ${student.token}`)
    .send(body);
}

async function orderStatus(orderId: string) {
  return (await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus;
}

describe('starting a payment', () => {
  it('creates a Razorpay order for the exact amount and returns checkout details', async () => {
    const { orderId, gatewayOrderId, res } = await startPayment();
    expect(res.status).toBe(201);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
    const paise = Math.round(Number(order.totalAmount) * 100);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orders', body: { amount: paise, currency: 'INR' } });
    expect(res.body.data.payment).toMatchObject({
      transactionId: gatewayOrderId,
      paymentStatus: 'PENDING',
      checkout: { provider: 'razorpay', keyId: 'rzp_test_fakekey', gatewayOrderId, amount: paise, currency: 'INR' },
    });
    // The key secret never leaves the server.
    expect(JSON.stringify(res.body)).not.toContain(RAZORPAY_KEY_SECRET);
  });

  it('shows checkout details again for the pending payment (retry after closing the window)', async () => {
    const { orderId, gatewayOrderId } = await startPayment();
    const res = await request(fx.app)
      .get(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.payment.checkout.gatewayOrderId).toBe(gatewayOrderId);
  });

  it('refuses cash for an online payment', async () => {
    const { res } = await startPayment('CASH');
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('confirming a payment', () => {
  it('queues the order when the signature is valid and Razorpay says captured', async () => {
    const { orderId, gatewayOrderId, res } = await startPayment();
    const amount = res.body.data.payment.checkout.amount;
    routes['GET /payments/pay_ok1'] = () => ({
      id: 'pay_ok1',
      order_id: gatewayOrderId,
      status: 'captured',
      amount,
      currency: 'INR',
    });

    const done = await confirm(orderId, {
      razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: 'pay_ok1',
      razorpaySignature: sign(gatewayOrderId, 'pay_ok1'),
    });

    expect(done.status).toBe(200);
    expect(done.body.data.payment.paymentStatus).toBe('SUCCESS');
    expect(done.body.data.payment.checkout).toBeUndefined();
    expect(await orderStatus(orderId)).toBe('QUEUED');
  });

  it('captures an authorized payment before accepting it', async () => {
    const { orderId, gatewayOrderId, res } = await startPayment();
    const amount = res.body.data.payment.checkout.amount;
    const entity = { id: 'pay_auth', order_id: gatewayOrderId, amount, currency: 'INR' };
    routes['GET /payments/pay_auth'] = () => ({ ...entity, status: 'authorized' });
    routes['POST /payments/pay_auth/capture'] = () => ({ ...entity, status: 'captured' });

    const done = await confirm(orderId, {
      razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: 'pay_auth',
      razorpaySignature: sign(gatewayOrderId, 'pay_auth'),
    });

    expect(done.status).toBe(200);
    expect(calls.some((c) => c.path === '/payments/pay_auth/capture')).toBe(true);
    expect(await orderStatus(orderId)).toBe('QUEUED');
  });

  it('rejects a forged signature and leaves the payment pending', async () => {
    const { orderId, gatewayOrderId } = await startPayment();
    const done = await confirm(orderId, {
      razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: 'pay_forged',
      razorpaySignature: 'f'.repeat(64),
    });
    expect(done.status).toBe(400);
    expect(await orderStatus(orderId)).toBe('PLACED');
    expect(await prisma.payment.count({ where: { orderId, paymentStatus: 'PENDING' } })).toBe(1);
  });

  it('rejects a payment made for another Razorpay order', async () => {
    const { orderId } = await startPayment();
    const other = 'order_SOMEONEELSE';
    const done = await confirm(orderId, {
      razorpayOrderId: other,
      razorpayPaymentId: 'pay_x',
      razorpaySignature: sign(other, 'pay_x'),
    });
    expect(done.status).toBe(400);
    expect(await orderStatus(orderId)).toBe('PLACED');
  });

  it('rejects a payment for the wrong amount', async () => {
    const { orderId, gatewayOrderId } = await startPayment();
    routes['GET /payments/pay_cheap'] = () => ({
      id: 'pay_cheap',
      order_id: gatewayOrderId,
      status: 'captured',
      amount: 1,
      currency: 'INR',
    });
    const done = await confirm(orderId, {
      razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: 'pay_cheap',
      razorpaySignature: sign(gatewayOrderId, 'pay_cheap'),
    });
    expect(done.status).toBe(400);
    expect(await orderStatus(orderId)).toBe('PLACED');
  });

  it('requires the Razorpay fields', async () => {
    const { orderId } = await startPayment();
    expect((await confirm(orderId, {})).status).toBe(400);
  });
});

describe('webhook', () => {
  function webhook(payload: unknown, secret = RAZORPAY_WEBHOOK_SECRET) {
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return request(fx.app)
      .post('/api/payments/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .send(body);
  }

  it('queues a paid order when the student never came back to confirm', async () => {
    const { orderId, gatewayOrderId, res } = await startPayment();
    const amount = res.body.data.payment.checkout.amount;
    routes['GET /payments/pay_hook'] = () => ({
      id: 'pay_hook',
      order_id: gatewayOrderId,
      status: 'captured',
      amount,
      currency: 'INR',
    });
    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_hook', order_id: gatewayOrderId } } },
    };

    const first = await webhook(payload);
    expect(first.status).toBe(200);
    expect(await orderStatus(orderId)).toBe('QUEUED');

    // Razorpay may send the same event again: nothing changes.
    const again = await webhook(payload);
    expect(again.status).toBe(200);
    expect(await prisma.payment.count({ where: { orderId, paymentStatus: 'SUCCESS' } })).toBe(1);
  });

  it('rejects a webhook with a bad signature', async () => {
    const { orderId, gatewayOrderId } = await startPayment();
    const res = await webhook(
      { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_bad', order_id: gatewayOrderId } } } },
      'wrong-secret',
    );
    expect(res.status).toBe(400);
    expect(await orderStatus(orderId)).toBe('PLACED');
  });

  it('acknowledges events it does not handle', async () => {
    const res = await webhook({ event: 'payment.failed', payload: {} });
    expect(res.status).toBe(200);
  });
});

describe('refunds', () => {
  it('sends the money back through Razorpay when an admin processes the refund', async () => {
    const { orderId, gatewayOrderId, res } = await startPayment();
    const amount = res.body.data.payment.checkout.amount;
    const paid = { id: 'pay_refund', order_id: gatewayOrderId, status: 'captured', amount, currency: 'INR' };
    routes['GET /payments/pay_refund'] = () => paid;
    expect(
      (
        await confirm(orderId, {
          razorpayOrderId: gatewayOrderId,
          razorpayPaymentId: 'pay_refund',
          razorpaySignature: sign(gatewayOrderId, 'pay_refund'),
        })
      ).status,
    ).toBe(200);

    expect((await fx.cancelRequest(student.token, orderId)).status).toBe(200);
    const requested = await request(fx.app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ reason: 'Changed my mind' });
    expect(requested.status).toBe(201);
    // Requesting does not move money yet.
    expect(calls.some((c) => c.path.endsWith('/refund'))).toBe(false);

    routes[`GET /orders/${gatewayOrderId}/payments`] = () => ({ items: [paid] });
    routes['GET /payments/pay_refund/refunds'] = () => ({ items: [] });
    routes['POST /payments/pay_refund/refund'] = () => ({ id: 'rfnd_1', status: 'processed' });

    const processed = await request(fx.app)
      .patch(`/api/orders/${orderId}/refund/process`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(processed.status).toBe(200);
    expect(processed.body.data.refund.refundStatus).toBe('PROCESSED');
    const refundCall = calls.find((c) => c.method === 'POST' && c.path === '/payments/pay_refund/refund');
    expect(refundCall?.body).toMatchObject({ amount, receipt: requested.body.data.refund.refundTransactionId });
  });
});

describe('configuration', () => {
  it('refuses to start Razorpay without keys, or in production without the webhook secret', async () => {
    const { createPaymentProvider } = await import('../src/services/payments');
    const saved = { ...process.env };
    try {
      process.env.RAZORPAY_KEY_SECRET = '';
      expect(() => createPaymentProvider('razorpay')).toThrow(/RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);

      process.env.RAZORPAY_KEY_SECRET = RAZORPAY_KEY_SECRET;
      process.env.RAZORPAY_WEBHOOK_SECRET = '';
      process.env.NODE_ENV = 'production';
      expect(() => createPaymentProvider('razorpay')).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    } finally {
      process.env = saved;
    }
  });
});
