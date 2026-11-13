import jwt from 'jsonwebtoken';

import { env } from '../config/env';
import { UserRole } from '../types/auth.types';

export interface JwtPayload {
  userId: string;
  role: UserRole;
}

// What verifyAccessToken returns: the signed payload plus the issued-at time
// (seconds since epoch) that jsonwebtoken adds automatically.
export interface VerifiedJwtPayload extends JwtPayload {
  iat: number;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

// Throws jwt.JsonWebTokenError / jwt.TokenExpiredError on invalid or expired
// tokens - the auth middleware is responsible for turning those into 401s.
export function verifyAccessToken(token: string): VerifiedJwtPayload {
  return jwt.verify(token, env.jwtSecret) as VerifiedJwtPayload;
}
