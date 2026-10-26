import { loadTestEnv } from '../scripts/testDbGuard';

// Must run before any test file imports app/env/prisma modules: loads
// backend/.env.test and refuses to continue unless it points at the
// dedicated smartprint_test database (see scripts/testDbGuard.ts).
loadTestEnv();

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
if (process.env.NODE_ENV === 'production') {
  throw new Error('[test-db-guard] Refusing to run the test suite with NODE_ENV=production.');
}

// Always isolated from the real dev uploads directory (UPLOAD_DIR default is
// uploads/documents) - forced rather than defaulted, because some test files
// recursively delete env.uploadDir in afterAll. src/config/env.ts reads this
// once at import time, so it must be set before any test file imports
// app/env/storage modules.
process.env.UPLOAD_DIR = 'tests/tmp-uploads';

// Rate limits are off for the general suite (many tests log in and upload
// in quick succession from one client). tests/rateLimit.test.ts turns them
// on explicitly through createApp() options.
process.env.RATE_LIMIT_ENABLED = 'false';

// Tests never send real email, even if SMTP credentials happen to be present in
// the environment: the in-memory mock provider is forced (see
// src/services/email/index.ts). tests/passwordReset.test.ts covers the
// production configuration checks separately.
process.env.EMAIL_PROVIDER = 'mock';
