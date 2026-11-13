import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { env } from '../config/env';
import { RateLimitConfig, RateLimitName, RateLimitRule } from '../config/security';
import { AuthenticatedRequest } from '../types/auth.types';
import { TooManyRequestsError } from '../utils/errors';

export type RateLimiters = Record<RateLimitName, RequestHandler>;

const MESSAGES: Record<RateLimitName, string> = {
  login: 'Too many failed login attempts. Please try again later.',
  authIp: 'Too many requests from this network. Please try again later.',
  register: 'Too many registration attempts. Please try again later.',
  forgotPassword: 'Too many password reset requests. Please try again later.',
  resetPassword: 'Too many password reset attempts. Please try again later.',
  changePassword: 'Too many password change attempts. Please try again later.',
  upload: 'Too many uploads. Please try again later.',
};

function clientIpKey(req: Request): string {
  // ipKeyGenerator groups IPv6 clients by network prefix, so a client can't
  // dodge the limit by rotating through addresses in its own /56.
  return ipKeyGenerator(req.ip ?? '');
}

function emailFromBody(req: Request): string {
  const email: unknown = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 320) : '';
}

// Per account (client IP + submitted email): one attacker can't lock out
// every student behind a shared campus IP, and one account can't be
// brute-forced from a single client.
function ipAndEmailKey(req: Request): string {
  return `${clientIpKey(req)}|${emailFromBody(req)}`;
}

// Uploads are limited per authenticated user. Mounted after `authenticate`
// and before multer, so a rejected request is never buffered into memory.
function userKey(req: Request): string {
  const userId = (req as AuthenticatedRequest).user?.userId;
  return userId ? `user:${userId}` : `ip:${clientIpKey(req)}`;
}

const passThrough: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => next();

// Largest unread body (e.g. a rejected upload) that is drained so the client
// receives the 429; beyond this the connection is closed instead.
const MAX_DRAIN_BYTES = env.maxFileSizeBytes + 1024 * 1024;

// A rejected upload's body is still unread when the limiter responds.
// Closing the socket with unread data makes the client see a connection
// reset instead of the 429, so the body is read and discarded first - never
// buffered - up to MAX_DRAIN_BYTES.
function respondAfterDraining(req: Request, res: Response, next: NextFunction, error: Error): void {
  if (req.complete) {
    next(error);
    return;
  }

  let finished = false;
  let received = 0;
  const finish = (closeConnection: boolean): void => {
    if (finished) return;
    finished = true;
    if (closeConnection) {
      res.setHeader('Connection', 'close');
    }
    next(error);
  };

  if (Number(req.headers['content-length'] ?? 0) > MAX_DRAIN_BYTES) {
    finish(true);
    return;
  }

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_DRAIN_BYTES) {
      finish(true);
    }
  });
  req.on('end', () => finish(false));
  req.on('error', () => finish(true));
  req.resume();
}

function buildLimiter(
  name: RateLimitName,
  rule: RateLimitRule,
  keyGenerator: (req: Request) => string,
  options: { skipSuccessfulRequests?: boolean } = {},
): RequestHandler {
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    // Routed through the centralized error handler so a 429 has the same
    // { success: false, message } shape as every other error response.
    handler: (req, res, next) => respondAfterDraining(req, res, next, new TooManyRequestsError(MESSAGES[name])),
  });
}

// Built fresh for every createApp() call: each app gets its own in-memory
// counters, which keeps test apps isolated from one another.
export function createRateLimiters(config: RateLimitConfig): RateLimiters {
  if (!config.enabled) {
    return {
      login: passThrough,
      authIp: passThrough,
      register: passThrough,
      forgotPassword: passThrough,
      resetPassword: passThrough,
      changePassword: passThrough,
      upload: passThrough,
    };
  }

  return {
    // Only failed attempts count, so legitimate sign-ins never use up the limit.
    login: buildLimiter('login', config.login, ipAndEmailKey, { skipSuccessfulRequests: true }),
    authIp: buildLimiter('authIp', config.authIp, clientIpKey),
    register: buildLimiter('register', config.register, clientIpKey),
    forgotPassword: buildLimiter('forgotPassword', config.forgotPassword, ipAndEmailKey),
    resetPassword: buildLimiter('resetPassword', config.resetPassword, clientIpKey),
    // Per user, failed and successful attempts alike: the current password is
    // checked here, so a stolen access token must not allow guessing it.
    changePassword: buildLimiter('changePassword', config.changePassword, userKey),
    upload: buildLimiter('upload', config.upload, userKey),
  };
}
