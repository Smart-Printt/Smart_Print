import { Response } from 'express';

import * as paymentService from '../services/payment.service';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { UnauthorizedError } from '../utils/errors';

function requireUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return req.user.userId;
}

// Ownership always comes from the JWT (req.user.userId), never the
// request body or URL - order.paid ownership is re-verified server-side
// regardless of what the client sends. The charged amount is never read
// from the request at all - see payment.service.ts.
export const initiate = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  const { paymentMethod } = req.body ?? {};
  const payment = await paymentService.initiatePayment(userId, req.params.orderId, {
    paymentMethod,
  });
  res.status(201).json({ success: true, data: { payment } });
});

export const confirm = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  const { simulateOutcome, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {};
  const payment = await paymentService.confirmPayment(userId, req.params.orderId, {
    simulateOutcome,
    gatewayResponse: { razorpayOrderId, razorpayPaymentId, razorpaySignature },
  });
  res.status(200).json({ success: true, data: { payment } });
});

export const getOne = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = requireUserId(req);
  const role = req.user!.role;
  const payment = await paymentService.getLatestPaymentForOrder(userId, role, req.params.orderId);
  res.status(200).json({ success: true, data: { payment } });
});
