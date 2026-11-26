import { Response } from 'express';

import * as analyticsService from '../services/analytics.service';
import * as shopService from '../services/shop.service';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { UnauthorizedError } from '../utils/errors';

// All shops - ADMIN-only (enforced by the router). Read-only.
export const get = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const days = analyticsService.parseRangeDays(req.query.days);
  const analytics = await analyticsService.getAnalytics(days);
  res.status(200).json({ success: true, data: { analytics } });
});

// One shop's own numbers - for that shop's staff (and ADMIN). The shop is
// authorized from the database on every call (the staff account must be
// ACTIVE and assigned to exactly this shop), never trusted from the URL.
export const getForShop = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const { shopId } = req.params;
  await shopService.assertShopAccess(req.user.userId, req.user.role, shopId);
  const days = analyticsService.parseRangeDays(req.query.days);
  const analytics = await analyticsService.getAnalytics(days, shopId);
  res.status(200).json({ success: true, data: { analytics } });
});
