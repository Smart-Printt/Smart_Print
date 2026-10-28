import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { UnauthorizedError } from '../utils/errors';
import { signAccessToken } from '../utils/jwt';
import { generateRawResetToken, hashResetToken } from '../utils/passwordResetToken';

// Refresh tokens are random 256-bit values; only their SHA-256 is stored.
// Every refresh rotates the token: the old one is revoked and a new one in
// the same "family" is issued. Presenting a token that was already rotated
// means a copy leaked, so the whole family is revoked - except within a
// short grace window, where it is just two browser tabs refreshing at once.
const REUSE_GRACE_MS = 10_000;

type Db = Prisma.TransactionClient | typeof prisma;

export interface IssuedRefreshToken {
  rawToken: string;
  expiresAt: Date;
}

export interface RefreshedSession extends IssuedRefreshToken {
  accessToken: string;
  userId: string;
}

function newExpiry(): Date {
  return new Date(Date.now() + env.refreshToken.ttlDays * 24 * 60 * 60 * 1000);
}

export async function issueRefreshToken(userId: string, familyId: string = randomUUID(), db: Db = prisma): Promise<IssuedRefreshToken> {
  const rawToken = generateRawResetToken();
  const expiresAt = newExpiry();
  await db.refreshToken.create({
    data: { userId, tokenHash: hashResetToken(rawToken), familyId, expiresAt },
  });
  return { rawToken, expiresAt };
}

// Revokes every active refresh token of a user, so none of their sessions can
// get a new access token. Called on password change; the admin "deactivate
// user" action can call it too (an inactive account is refused on refresh
// either way). Access tokens already issued stop working through the checks
// in the auth middleware or expire within minutes.
export async function revokeUserSessions(userId: string, db: Db = prisma): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

// Logout: revokes just the session the token belongs to. Unknown or already
// revoked tokens are ignored - logging out twice is not an error.
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashResetToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function refreshSession(rawToken: string): Promise<RefreshedSession> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashResetToken(rawToken) },
    include: { user: true },
  });
  if (!stored) {
    throw new UnauthorizedError('Invalid session');
  }

  const now = Date.now();

  if (stored.revokedAt) {
    if (now - stored.revokedAt.getTime() > REUSE_GRACE_MS) {
      await prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    throw new UnauthorizedError('Session expired, please sign in again');
  }
  if (stored.expiresAt.getTime() <= now) {
    throw new UnauthorizedError('Session expired, please sign in again');
  }
  if (stored.user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Account is inactive');
  }
  if (stored.user.passwordChangedAt && stored.createdAt < stored.user.passwordChangedAt) {
    throw new UnauthorizedError('Session expired, please sign in again');
  }

  // Revoke-then-issue in one transaction. The conditional update means two
  // simultaneous refreshes with the same token cannot both succeed.
  const issued = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { tokenId: stored.tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) {
      return null;
    }
    return issueRefreshToken(stored.userId, stored.familyId, tx);
  });
  if (!issued) {
    throw new UnauthorizedError('Session expired, please sign in again');
  }

  return {
    ...issued,
    userId: stored.userId,
    accessToken: signAccessToken({ userId: stored.userId, role: stored.user.role }),
  };
}
