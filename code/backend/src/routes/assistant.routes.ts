import { Response, Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { authenticate } from '../middleware/auth.middleware';
import * as assistantService from '../services/assistant/printAssistant.service';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { TooManyRequestsError, UnauthorizedError } from '../utils/errors';

// Mounted at /api/assistant. Each call may cost an LLM request, so it is
// limited per user (not per IP, which would be shared across a campus).
const assistantLimiter = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req as AuthenticatedRequest).user?.userId
      ? `user:${(req as AuthenticatedRequest).user!.userId}`
      : ipKeyGenerator(req.ip ?? ''),
  handler: (_req, _res, next) => next(new TooManyRequestsError()),
});

export const assistantRouter = Router();

assistantRouter.use(authenticate);

assistantRouter.post(
  '/print-request',
  assistantLimiter,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const { message, documentIds } = req.body ?? {};
    const result = await assistantService.interpretPrintRequest(req.user.userId, req.user.role, {
      message,
      documentIds,
    });
    res.status(200).json({ success: true, data: result });
  }),
);
