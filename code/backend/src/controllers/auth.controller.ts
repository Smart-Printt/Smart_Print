import { Response } from 'express';

import * as authService from '../services/auth.service';
import * as sessionService from '../services/session.service';
import { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler';
import { UnauthorizedError } from '../utils/errors';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../utils/refreshCookie';

export const register = asyncHandler(async (req, res: Response) => {
  const { name, email, phone, password } = req.body ?? {};
  const { refresh, ...result } = await authService.registerStudent({ name, email, phone, password });
  setRefreshCookie(res, refresh.rawToken, refresh.expiresAt);
  res.status(201).json({ success: true, data: result });
});

export const login = asyncHandler(async (req, res: Response) => {
  const { email, password } = req.body ?? {};
  const { refresh, ...result } = await authService.login({ email, password });
  setRefreshCookie(res, refresh.rawToken, refresh.expiresAt);
  res.status(200).json({ success: true, data: result });
});

// Trades the httpOnly refresh cookie for a new short-lived access token and a
// rotated cookie. Any failure clears the cookie so the client stops retrying.
export const refresh = asyncHandler(async (req, res: Response) => {
  const rawToken = readRefreshCookie(req);
  if (!rawToken) {
    throw new UnauthorizedError('No active session');
  }
  try {
    const session = await sessionService.refreshSession(rawToken);
    const user = await authService.getSafeUserById(session.userId);
    if (!user) {
      throw new UnauthorizedError('User no longer exists');
    }
    setRefreshCookie(res, session.rawToken, session.expiresAt);
    res.status(200).json({ success: true, data: { user, token: session.accessToken } });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      clearRefreshCookie(res);
    }
    throw err;
  }
});

// Always returns the same generic message, whether or not the email
// belongs to an account - see authService.requestPasswordReset for the
// enumeration-safety reasoning. Never branches on what the service did.
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'If an account exists for this email, you will receive password reset instructions.';

export const forgotPassword = asyncHandler(async (req, res: Response) => {
  const { email } = req.body ?? {};
  await authService.requestPasswordReset({ email });
  res.status(200).json({ success: true, message: GENERIC_FORGOT_PASSWORD_MESSAGE });
});

export const resetPassword = asyncHandler(async (req, res: Response) => {
  const { token, password, confirmPassword } = req.body ?? {};
  await authService.resetPassword({ token, password, confirmPassword });
  res.status(200).json({ success: true, message: 'Your password has been reset successfully.' });
});

export const me = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const user = await authService.getSafeUserById(req.user.userId);
  if (!user) {
    throw new UnauthorizedError('User no longer exists');
  }
  res.status(200).json({ success: true, data: { user } });
});

// Revokes this browser's refresh token and clears the cookie. The short-lived
// access token the client still holds simply expires; the client discards it.
export const logout = asyncHandler(async (req, res: Response) => {
  const rawToken = readRefreshCookie(req);
  if (rawToken) {
    await sessionService.revokeRefreshToken(rawToken);
  }
  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out.' });
});

// ADMIN-only. Creates a SHOP_STAFF account. Not reachable without a valid
// ADMIN JWT (see requireRole('ADMIN') on the route) - this is the
// "authorized administrative workflow" referenced in the auth service, and
// is not part of public registration.
export const createShopStaff = asyncHandler(async (req, res: Response) => {
  const { name, email, phone, password } = req.body ?? {};
  const user = await authService.createShopStaff({ name, email, phone, password });
  res.status(201).json({ success: true, data: { user } });
});

// ADMIN-only. Provisions a FACULTY account - see authService.createFaculty
// for why this is a distinct role from SHOP_STAFF and is never reachable
// through public registration.
export const createFaculty = asyncHandler(async (req, res: Response) => {
  const { name, email, phone, password } = req.body ?? {};
  const user = await authService.createFaculty({ name, email, phone, password });
  res.status(201).json({ success: true, data: { user } });
});
