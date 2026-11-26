import { Router } from 'express';

import * as queueController from '../controllers/queue.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';

// Mounted at /api/orders (same base as order/payment/refund routers) -
// order-scoped queue reads (owner, or ADMIN/assigned SHOP_STAFF - see
// queueService.getQueueEntryForOrder), plus the collection endpoint that
// closes out the printing lifecycle (Phase 8: ADMIN or the SHOP_STAFF
// assigned to that order's shop - requireRole here is just the cheap
// STUDENT-exclusion first pass; shopService.assertShopAccess does the
// authoritative per-shop check inside queueService.collectOrder).
export const queueRouter = Router();

queueRouter.use(authenticate);

queueRouter.get('/:orderId/queue', queueController.getOne);
queueRouter.get('/:orderId/queue-position', queueController.getPosition);
// Server-Sent Events: pushes the order's queue entry whenever the shop's
// queue changes (see queue.controller.ts::stream).
queueRouter.get('/:orderId/queue/stream', queueController.stream);
queueRouter.patch(
  '/:orderId/collect',
  requireRole('ADMIN', 'SHOP_STAFF'),
  queueController.collect,
);
