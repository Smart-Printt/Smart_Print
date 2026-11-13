import { NextFunction, Request, Response } from 'express';

import { ForbiddenError } from '../utils/errors';

export const CLIENT_HEADER = 'X-SmartPrint-Client';

// Guards the cookie-based endpoints (refresh, logout). A browser cannot add a
// custom header to a cross-site form post or image request, and a cross-origin
// fetch with one triggers a CORS preflight that only allowed origins pass. So
// a page on another site cannot use the visitor's refresh cookie.
export function requireClientHeader(req: Request, _res: Response, next: NextFunction): void {
  if (req.get(CLIENT_HEADER) !== 'web') {
    next(new ForbiddenError('Missing client header'));
    return;
  }
  next();
}
