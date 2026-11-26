import { Router } from 'express';

import * as analyticsController from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';

// Mounted at /api/admin/analytics. ADMIN-only, read-only business insights
// (orders, revenue, busy hours, per-shop load, wait/print times).
export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.use(authenticate, requireRole('ADMIN'));

adminAnalyticsRouter.get('/', analyticsController.get);
