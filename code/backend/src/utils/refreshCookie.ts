import { Request, Response } from 'express';

import { env } from '../config/env';

export const REFRESH_COOKIE_NAME = 'smartprint_refresh';
// The cookie is only sent to the auth endpoints, never with other API calls.
const REFRESH_COOKIE_PATH = '/api/auth';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.nodeEnv === 'production' || env.refreshToken.cookieSameSite === 'none',
    sameSite: env.refreshToken.cookieSameSite,
    path: REFRESH_COOKIE_PATH,
  } as const;
}

export function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, { ...cookieOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
}

// Reads one cookie from the Cookie header; the app has no other use for
// cookies, so a full cookie parser would be an unnecessary dependency.
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === REFRESH_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}
