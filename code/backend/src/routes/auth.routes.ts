import { Router } from 'express';

import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireClientHeader } from '../middleware/clientHeader.middleware';
import { requireRole } from '../middleware/role.middleware';

export const authRouter = Router();

// Public - always creates role=STUDENT, status=ACTIVE. See auth.service.ts.
authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
// Cookie-based, so both need the custom client header (see
// clientHeader.middleware.ts).
authRouter.post('/refresh', requireClientHeader, authController.refresh);
authRouter.post('/logout', requireClientHeader, authController.logout);

// Public. Always responds with the same generic message - see
// auth.controller.ts/auth.service.ts for the email-enumeration defense.
authRouter.post('/forgot-password', authController.forgotPassword);
// Public - the reset token itself (not a session/JWT) is the authorization
// mechanism here, matching how a real "click the emailed link" flow works.
authRouter.post('/reset-password', authController.resetPassword);

// Requires a valid JWT.
authRouter.get('/me', authenticate, authController.me);
authRouter.patch('/me', authenticate, authController.updateMe);
// The per-user attempt limit is applied in app.ts, ahead of this router.
authRouter.post('/change-password', authenticate, authController.changePassword);

// ADMIN-only administrative workflow for creating SHOP_STAFF accounts.
// Deliberately not public - see createShopStaff in auth.controller.ts.
authRouter.post('/staff', authenticate, requireRole('ADMIN'), authController.createShopStaff);

// ADMIN-only administrative workflow for provisioning FACULTY accounts.
// Deliberately not public - see createFaculty in auth.controller.ts. A
// student can never self-select this role (registerStudent always creates
// role=STUDENT and ignores any role field in its input).
authRouter.post('/faculty', authenticate, requireRole('ADMIN'), authController.createFaculty);
