import cors from 'cors';
import { NextFunction, Request, RequestHandler, Response } from 'express';

import { ForbiddenError } from '../utils/errors';

// Exact-origin CORS allowlist (see config/security.ts for how the list is
// built and validated).
//
// The gate runs before `cors()` because the cors package on its own only
// omits the response headers for a disallowed origin - the request itself
// would still be processed, so a cross-site form POST would go through.
// Here an unlisted Origin is refused outright with 403, preflights included.
//
// Requests with no Origin header (curl, health checks, server-to-server
// calls, future payment-gateway webhooks) are allowed: browsers always send
// Origin on cross-origin requests, so unlisted browser origins are still
// caught, and authentication on protected routes is unaffected. The literal
// origin "null" (sandboxed iframes, file:// pages) is never on the list.
export function createCorsMiddleware(allowedOrigins: string[]): RequestHandler[] {
  const allowed = new Set(allowedOrigins);

  const originGate = (req: Request, _res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined || allowed.has(origin)) {
      next();
      return;
    }
    next(new ForbiddenError('Origin not allowed'));
  };

  const corsHandler = cors({
    origin: [...allowed],
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: [
      'Content-Disposition',
      'Idempotent-Replayed',
      'RateLimit',
      'RateLimit-Policy',
      'Retry-After',
    ],
    maxAge: 600,
  });

  return [originGate, corsHandler];
}
