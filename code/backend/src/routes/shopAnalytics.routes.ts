import { Router } from 'express';

import * as analyticsController from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';

// Mounted at /api/shops. A shop's own analytics: ADMIN (any shop) or the
// SHOP_STAFF assigned to that exact shop. requireRole is the cheap first
// pass; shopService.assertShopAccess is the authoritative per-shop check.
export const shopAnalyticsRouter = Router();

shopAnalyticsRouter.use(authenticate, requireRole('ADMIN', 'SHOP_STAFF'));

shopAnalyticsRouter.get('/:shopId/analytics', analyticsController.getForShop);
