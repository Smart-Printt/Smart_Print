import express, { Application } from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { RateLimitConfig, RateLimitName, RateLimitRule, loadSecurityConfig } from './config/security';
import { authenticate } from './middleware/auth.middleware';
import { createCorsMiddleware } from './middleware/cors.middleware';
import { errorHandler } from './middleware/errorHandler';
import { notFoundHandler } from './middleware/notFound';
import { createRateLimiters } from './middleware/rateLimit.middleware';
import { adminStaffRouter } from './routes/adminStaff.routes';
import { authRouter } from './routes/auth.routes';
import { documentRouter } from './routes/document.routes';
import { healthRouter } from './routes/health.route';
import { orderRouter } from './routes/order.routes';
import { paymentRouter } from './routes/payment.routes';
import { pricingRouter } from './routes/pricing.routes';
import { queueRouter } from './routes/queue.routes';
import { refundRouter } from './routes/refund.routes';
import { shopRouter } from './routes/shop.routes';
import { shopPricingRouter } from './routes/shopPricing.routes';
import { shopQueueRouter } from './routes/shopQueue.routes';
import { testRouter } from './routes/test.routes';

// Optional overrides of the environment-derived security settings, used by
// tests to exercise CORS and rate limiting without changing process.env.
export interface CreateAppOptions {
  corsAllowedOrigins?: string[];
  trustProxy?: number | false;
  rateLimit?: { enabled?: boolean } & Partial<Record<RateLimitName, RateLimitRule>>;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const security = loadSecurityConfig();
  const corsAllowedOrigins = options.corsAllowedOrigins ?? security.corsAllowedOrigins;
  const trustProxy = options.trustProxy ?? security.trustProxy;
  const rateLimitConfig: RateLimitConfig = { ...security.rateLimit, ...options.rateLimit };

  const app = express();

  // Needed for correct client IPs (and so per-IP rate limits) behind a
  // reverse proxy; off unless TRUST_PROXY sets the number of proxy hops.
  app.set('trust proxy', trustProxy);

  // Security headers, including X-Content-Type-Options: nosniff, and
  // removal of X-Powered-By.
  app.use(helmet());
  app.use(createCorsMiddleware(corsAllowedOrigins));
  app.use(express.json());

  // Rate limits run before the routers that own these paths. Each handler
  // calls next() when under the limit, so the request continues to the
  // matching router unchanged.
  const limiters = createRateLimiters(rateLimitConfig);
  app.post('/api/auth/login', limiters.authIp, limiters.login);
  app.post('/api/auth/register', limiters.authIp, limiters.register);
  app.post('/api/auth/forgot-password', limiters.authIp, limiters.forgotPassword);
  app.post('/api/auth/reset-password', limiters.authIp, limiters.resetPassword);
  app.post('/api/auth/change-password', authenticate, limiters.changePassword);
  // Authenticated so the limit is per user; ahead of multer in
  // documentRouter so a rejected upload is never read into memory.
  app.post('/api/documents', authenticate, limiters.upload);

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/documents', documentRouter);
  app.use('/api/orders', orderRouter);
  app.use('/api/orders', paymentRouter);
  app.use('/api/orders', refundRouter);
  app.use('/api/orders', queueRouter);
  app.use('/api/shops', shopRouter);
  app.use('/api/shops', shopPricingRouter);
  app.use('/api/shops', shopQueueRouter);
  app.use('/api/pricing', pricingRouter);
  app.use('/api/admin/staff', adminStaffRouter);

  // Development/testing-only role-middleware exercise routes - see
  // routes/test.routes.ts. Never mounted in production.
  if (env.nodeEnv !== 'production') {
    app.use('/api/test', testRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
