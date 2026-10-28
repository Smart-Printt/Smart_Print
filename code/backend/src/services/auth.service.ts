import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { emailService } from './email';
import { IssuedRefreshToken, issueRefreshToken, revokeUserSessions } from './session.service';
import { buildPasswordResetEmail } from './email/passwordResetEmail';
import { SafeUser } from '../types/auth.types';
import { ConflictError, UnauthorizedError, ValidationError } from '../utils/errors';
import { signAccessToken } from '../utils/jwt';
import { comparePassword, hashPassword, validatePasswordPolicy } from '../utils/password';
import { generateRawResetToken, hashResetToken } from '../utils/passwordResetToken';
import { toSafeUser } from '../utils/safeUser';
import {
  assertStudentEmailDomain,
  assertValidEmailFormat,
  assertValidEmailInput,
  assertValidName,
  assertValidPasswordInput,
  assertValidPhone,
  normalizeEmail,
} from '../utils/validation';

export interface RegisterStudentInput {
  name: unknown;
  email: unknown;
  phone: unknown;
  password: unknown;
}

export interface LoginInput {
  email: unknown;
  password: unknown;
}

export interface AuthResult {
  user: SafeUser;
  token: string;
}

// What register/login return internally. The controller sends `user` and
// `token` in the JSON body and puts `refresh` in an httpOnly cookie - the
// refresh token never appears in a response body.
export interface AuthSession extends AuthResult {
  refresh: IssuedRefreshToken;
}

// Public registration always creates a STUDENT with ACTIVE status. Any
// role/status/password_hash/user_id fields submitted by the client are
// ignored entirely - they are never read from the input object.
export async function registerStudent(input: RegisterStudentInput): Promise<AuthSession> {
  assertValidName(input.name);
  assertValidEmailInput(input.email);
  assertValidPhone(input.phone);
  assertValidPasswordInput(input.password);

  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  const phone = input.phone ? input.phone.trim() : null;
  const password = input.password;

  assertValidEmailFormat(email);
  assertStudentEmailDomain(email);
  validatePasswordPolicy(password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash,
      role: 'STUDENT',
      status: 'ACTIVE',
    },
  });

  const token = signAccessToken({ userId: user.userId, role: user.role });
  const refresh = await issueRefreshToken(user.userId);

  return { user: toSafeUser(user), token, refresh };
}

// Deliberately vague on failure ("Invalid email or password") to avoid
// leaking which part of the credential was wrong or whether the account
// exists at all.
export async function login(input: LoginInput): Promise<AuthSession> {
  assertValidEmailInput(input.email);
  assertValidPasswordInput(input.password);

  const email = normalizeEmail(input.email);
  const password = input.password;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const passwordMatches = await comparePassword(password, user.passwordHash);
  if (!passwordMatches) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Account is inactive');
  }

  const token = signAccessToken({ userId: user.userId, role: user.role });
  const refresh = await issueRefreshToken(user.userId);

  return { user: toSafeUser(user), token, refresh };
}

export async function getSafeUserById(userId: string): Promise<SafeUser | null> {
  const user = await prisma.user.findUnique({ where: { userId } });
  return user ? toSafeUser(user) : null;
}

export interface CreateShopStaffInput {
  name: unknown;
  email: unknown;
  phone: unknown;
  password: unknown;
}

// Creates a SHOP_STAFF account. Unlike student registration, the email does
// not need to belong to the student domain. This is only ever called from
// an ADMIN-authenticated route (see auth.routes.ts) - it is not, and must
// never become, a publicly reachable registration path. Full shop-staff
// management (linking staff to a specific shop, etc.) is a later phase.
export async function createShopStaff(input: CreateShopStaffInput): Promise<SafeUser> {
  assertValidName(input.name);
  assertValidEmailInput(input.email);
  assertValidPhone(input.phone);
  assertValidPasswordInput(input.password);

  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  const phone = input.phone ? input.phone.trim() : null;
  const password = input.password;

  assertValidEmailFormat(email);
  validatePasswordPolicy(password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash,
      role: 'SHOP_STAFF',
      status: 'ACTIVE',
    },
  });

  return toSafeUser(user);
}

export interface CreateFacultyInput {
  name: unknown;
  email: unknown;
  phone: unknown;
  password: unknown;
}

// ADMIN-only. Creates a FACULTY account - a customer role like STUDENT
// (same printing/ordering access), but eligible for free printing at the
// CSE Department Faculty Printer (see shop.service.ts::isFreeFacultyShop).
// Faculty may share the student email domain, so - unlike registerStudent -
// no domain check is applied here; the only thing that makes an account
// FACULTY is an admin explicitly provisioning it through this endpoint.
// shopId is never accepted: shopId assignment exists solely for
// SHOP_STAFF (see the users_shop_id_only_for_staff DB constraint).
export async function createFaculty(input: CreateFacultyInput): Promise<SafeUser> {
  assertValidName(input.name);
  assertValidEmailInput(input.email);
  assertValidPhone(input.phone);
  assertValidPasswordInput(input.password);

  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  const phone = input.phone ? input.phone.trim() : null;
  const password = input.password;

  assertValidEmailFormat(email);
  validatePasswordPolicy(password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash,
      role: 'FACULTY',
      status: 'ACTIVE',
    },
  });

  return toSafeUser(user);
}

// ─────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ForgotPasswordInput {
  email: unknown;
}

// Deliberately returns void, not a boolean/user - the caller (controller)
// always sends the exact same generic response regardless of what happened
// here, so there is nothing for it to branch on. This is the core of the
// email-enumeration defense: every code path below - unknown email,
// inactive account, email delivery failure - is externally indistinguishable
// from a real, successful reset request.
export async function requestPasswordReset(input: ForgotPasswordInput): Promise<void> {
  assertValidEmailInput(input.email);
  const email = normalizeEmail(input.email);
  assertValidEmailFormat(email);

  const user = await prisma.user.findUnique({ where: { email } });

  // Nonexistent account and inactive account both take this same silent
  // early return - no token is created, no email is sent, and (critically)
  // no error is thrown, so the controller's response is identical either way.
  if (!user || user.status !== 'ACTIVE') {
    return;
  }

  const rawToken = generateRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.$transaction([
    // "Latest link wins" - any reset link from an earlier request for this
    // user stops working the moment a new one is requested.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { userId: user.userId, tokenHash, expiresAt },
    }),
  ]);

  const resetUrl = `${env.frontendUrl.replace(/\/+$/, '')}/reset-password?token=${rawToken}`;

  // Delivery is deliberately NOT awaited. Sending mail takes orders of
  // magnitude longer than the early return for an unknown address, so waiting
  // for it would let anyone tell "account exists" from "no such account" by
  // timing the response - undoing the identical-response defense above. The
  // message is handed to the provider immediately; its outcome is only ever
  // logged server-side (never to the caller), whether it succeeds or fails.
  void deliverPasswordResetEmail(user.email, resetUrl);
}

async function deliverPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  try {
    await emailService.send(buildPasswordResetEmail(to, resetUrl));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'Failed to send password reset email:',
      err instanceof Error ? err.message : err,
    );
  }
}

export interface ResetPasswordInput {
  token: unknown;
  password: unknown;
  confirmPassword?: unknown;
}

const INVALID_TOKEN_MESSAGE = 'This password reset link is invalid or has expired';

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  if (typeof input.token !== 'string' || input.token.trim().length === 0) {
    throw new ValidationError('Reset token is required');
  }
  assertValidPasswordInput(input.password);
  if (input.confirmPassword !== undefined && input.confirmPassword !== input.password) {
    throw new ValidationError('Passwords do not match');
  }
  validatePasswordPolicy(input.password);

  const tokenHash = hashResetToken(input.token.trim());
  const passwordHash = await hashPassword(input.password);

  const accepted = await prisma.$transaction(async (tx) => {
    // A single conditional UPDATE is the atomic "claim" of this token: if
    // two requests race on the same token, only the first can ever match
    // `usedAt: null` (Postgres re-checks the WHERE clause against the
    // committed row once it acquires the row lock) - the second gets
    // count 0 and is rejected, regardless of statement ordering.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      return false;
    }

    const resetToken = await tx.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash },
      include: { user: { select: { status: true } } },
    });

    // A link issued while the account was active must not work once it has
    // been deactivated: recovery never reactivates or edits an account. The
    // token stays consumed (the claim above commits), so the link cannot come
    // back to life if the account is later reactivated.
    if (resetToken.user.status !== 'ACTIVE') {
      return false;
    }

    // Only the password changes - never the role, status, email or shop.
    await tx.user.update({
      where: { userId: resetToken.userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    // Anyone holding the old password (or a stolen session) is signed out.
    await revokeUserSessions(resetToken.userId, tx);

    // Defensive cleanup: any other still-unused token for this user (e.g.
    // one left over from a request that failed to invalidate correctly) is
    // now moot too.
    await tx.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return true;
  });

  // One message for every way a link can be unusable (unknown, expired, used,
  // or belonging to a deactivated account) so the response reveals nothing.
  if (!accepted) {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }
}
