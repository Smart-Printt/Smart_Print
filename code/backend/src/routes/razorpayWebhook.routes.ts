import express, { Request, Response, Router } from 'express';

import { paymentProvider } from '../services/payments';
import { RazorpayPaymentProvider, verifyWebhookSignature } from '../services/payments/razorpayProvider';
import * as paymentService from '../services/payment.service';

// POST /api/payments/razorpay/webhook - called by Razorpay, not by a browser.
// Set it up in the Razorpay dashboard (Settings -> Webhooks) with the events
// payment.captured and order.paid, and the same secret as
// RAZORPAY_WEBHOOK_SECRET. The raw body is needed to check the signature, so
// this router is mounted BEFORE express.json() in app.ts.
export const razorpayWebhookRouter = Router();

const HANDLED_EVENTS = new Set(['payment.captured', 'order.paid']);

razorpayWebhookRouter.post(
  '/razorpay/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    if (!(paymentProvider instanceof RazorpayPaymentProvider) || !paymentProvider.webhookSecret) {
      res.status(404).json({ success: false, error: { message: 'Not found' } });
      return;
    }
    const signature = req.get('X-Razorpay-Signature');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!signature || !verifyWebhookSignature(paymentProvider.webhookSecret, raw, signature)) {
      res.status(400).json({ success: false, error: { message: 'Invalid signature' } });
      return;
    }

    let event: {
      event?: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
    };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      res.status(400).json({ success: false, error: { message: 'Invalid JSON' } });
      return;
    }

    const payment = event.payload?.payment?.entity;
    if (!event.event || !HANDLED_EVENTS.has(event.event) || !payment?.id || !payment.order_id) {
      // Acknowledge everything else so Razorpay does not keep retrying.
      res.status(200).json({ success: true });
      return;
    }

    try {
      const result = await paymentService.settleFromGatewayWebhook(payment.order_id, payment.id);
      if (result === 'not-payable') {
        // eslint-disable-next-line no-console
        console.warn(`Razorpay webhook: ${payment.order_id} was paid but the order can no longer be paid; refund it.`);
      }
      res.status(200).json({ success: true });
    } catch (err) {
      // 500 -> Razorpay retries later.
      // eslint-disable-next-line no-console
      console.error('Razorpay webhook failed:', (err as Error).message);
      res.status(500).json({ success: false });
    }
  },
);
