import { NextFunction, Response } from 'express';
import { TokenExpiredError } from 'jsonwebtoken';

import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { UnauthorizedError } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';

const BEARER_PREFIX = 'Bearer ';

// Verifies the JWT on the Authorization header, then looks the user up so a
// valid-looking token stops working as soon as the account is deactivated
// or deleted, or the password changes after the token was issued. Attaches
// { userId, role } to req.user, with the role taken from the database rather
// than the token so a role change also applies immediately.
export async function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    next(new UnauthorizedError('Missing or malformed Authorization header'));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    next(new UnauthorizedError(err instanceof TokenExpiredError ? 'Token has expired' : 'Invalid token'));
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { userId: payload.userId },
      select: { userId: true, role: true, status: true, passwordChangedAt: true },
    });

    if (!user) {
      next(new UnauthorizedError('Invalid token'));
      return;
    }
    if (user.status !== 'ACTIVE') {
      next(new UnauthorizedError('Account is inactive'));
      return;
    }
    // iat has one-second resolution, so compare in whole seconds. A token
    // issued in the same second as the password change is still accepted;
    // that is what lets change-password hand back a fresh token.
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      next(new UnauthorizedError('Session expired, please sign in again'));
      return;
    }

    req.user = { userId: user.userId, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}
