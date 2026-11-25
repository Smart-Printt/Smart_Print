import { UserRole } from '@prisma/client';
import { Response } from 'express';

import * as queueService from '../services/queue.service';
import { subscribeToShopQueue } from '../services/queueEvents';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { TooManyRequestsError, UnauthorizedError } from '../utils/errors';

function requireUser(req: AuthenticatedRequest): { userId: string; role: UserRole } {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  return { userId: req.user.userId, role: req.user.role };
}

// Owner-or-admin, same pattern as refund.controller.ts.
export const getOne = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { userId, role } = requireUser(req);
  const queue = await queueService.getQueueEntryForOrder(userId, role, req.params.orderId);
  res.status(200).json({ success: true, data: { queue } });
});

export const getPosition = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { userId, role } = requireUser(req);
  const position = await queueService.getQueuePositionForOrder(userId, role, req.params.orderId);
  res.status(200).json({ success: true, data: position });
});

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_STREAMS_PER_USER = 5;
const openStreamsByUser = new Map<string, number>();

// Server-Sent Events. The client opens this once; every time the order's
// shop queue changes (payment confirmed, printing started/completed, an
// order cancelled or collected) the entry is re-read - through the same
// owner/staff access checks as GET /:orderId/queue - and pushed down.
// Authentication happens once, when the stream opens (the bearer token goes
// in the Authorization header, so the browser client uses fetch, not
// EventSource). The stream closes itself once the entry leaves the
// WAITING/PRINTING states, and a heartbeat comment keeps proxies from
// dropping an idle connection.
export const stream = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { userId, role } = requireUser(req);
  const { orderId } = req.params;

  // Throws 404/403 before any streaming headers are sent.
  const initial = await queueService.getQueueEntryForOrder(userId, role, orderId);

  const open = openStreamsByUser.get(userId) ?? 0;
  if (open >= MAX_STREAMS_PER_USER) {
    throw new TooManyRequestsError('Too many live connections open. Close another tab and try again.');
  }
  openStreamsByUser.set(userId, open + 1);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  let closed = false;
  let refreshing = false;
  let refreshAgain = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    const remaining = (openStreamsByUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      openStreamsByUser.delete(userId);
    } else {
      openStreamsByUser.set(userId, remaining);
    }
    res.end();
  };

  const send = (entry: Awaited<ReturnType<typeof queueService.getQueueEntryForOrder>>): void => {
    res.write(`event: queue\ndata: ${JSON.stringify(entry)}\n\n`);
    if (entry.queueStatus !== 'WAITING' && entry.queueStatus !== 'PRINTING') {
      res.write('event: end\ndata: {}\n\n');
      cleanup();
    }
  };

  // Coalesces bursts: if several changes arrive while a read is in flight,
  // exactly one more read runs afterwards.
  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        send(await queueService.getQueueEntryForOrder(userId, role, orderId));
      } while (refreshAgain && !closed);
    } catch {
      // Access revoked, order gone, or a transient DB error: end the stream;
      // the client falls back to its normal polling and reconnects.
      cleanup();
    } finally {
      refreshing = false;
    }
  };

  const unsubscribe = subscribeToShopQueue(initial.shopId, () => void refresh());
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', cleanup);
  send(initial);
});

// ADMIN or SHOP_STAFF assigned to the order's shop - see
// queueService.collectOrder/shopService.assertShopAccess.
export const collect = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { userId, role } = requireUser(req);
  await queueService.collectOrder(userId, role, req.params.orderId);
  res.status(200).json({ success: true, data: { orderId: req.params.orderId, orderStatus: 'COLLECTED' } });
});
