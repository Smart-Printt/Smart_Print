import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB ?? 25);

// Email is optional - only wired up if all four SMTP variables are present
// (see services/email/index.ts). Never required() here, so local dev and
// the test suite keep working without any mail credentials configured.
const emailPort = process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : undefined;

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4321),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  // Access tokens are short-lived; a long-lived refresh token (below) gets a
  // new one without asking for the password again.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  refreshToken: {
    ttlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
    // Lax is right when the frontend and API share a site (the Vite proxy in
    // development, or one domain in production). Use "none" only for a
    // frontend on a different site; it requires HTTPS.
    cookieSameSite: (process.env.REFRESH_COOKIE_SAMESITE ?? 'lax').toLowerCase() as 'lax' | 'strict' | 'none',
  },
  allowedStudentEmailDomain: (
    process.env.ALLOWED_STUDENT_EMAIL_DOMAIN ?? 'thapar.edu'
  ).toLowerCase(),
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads/documents',
  maxFileSizeMb,
  maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
  // Used to build the password-reset link (`${frontendUrl}/reset-password?token=...`)
  // - never hardcode localhost in a service. Defaults to the Vite dev
  // server port for local development.
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  // Where uploaded files live: "local" (UPLOAD_DIR on this server's disk) or
  // "s3" (an S3-compatible bucket such as Cloudflare R2 or AWS S3). See
  // services/storage/index.ts and README.md "File storage".
  storage: {
    provider: (process.env.STORAGE_PROVIDER ?? 'local').trim().toLowerCase(),
    s3: {
      bucket: process.env.S3_BUCKET ?? '',
      // R2 uses the region "auto".
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      keyPrefix: process.env.S3_KEY_PREFIX ?? 'documents/',
    },
  },
  // Word/Excel/PowerPoint -> PDF with LibreOffice (services/documents/
  // officeConverter.ts). Skipped automatically when LibreOffice is missing.
  officeConversion: {
    enabled: (process.env.OFFICE_CONVERSION_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    command: [process.env.SOFFICE_PATH?.trim() || 'soffice'],
    timeoutMs: Number(process.env.OFFICE_CONVERSION_TIMEOUT_SECONDS ?? 60) * 1000,
    maxParallel: Number(process.env.OFFICE_CONVERSION_MAX_PARALLEL ?? 2),
  },
  // Automatic file clean-up (services/fileCleanup.service.ts). Hours are how
  // long a file is kept AFTER it stops being needed. 0 interval = job off.
  fileCleanup: {
    intervalMinutes: Number(process.env.FILE_CLEANUP_INTERVAL_MINUTES ?? 60),
    finishedOrderRetentionHours: Number(process.env.FINISHED_ORDER_FILE_RETENTION_HOURS ?? 24),
    unusedDocumentRetentionHours: Number(process.env.UNUSED_DOCUMENT_RETENTION_HOURS ?? 24),
  },
  // Optional. Without a key the print assistant uses its rule-based parser.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  assistantModel: process.env.ASSISTANT_MODEL ?? 'claude-haiku-5-5',
  email: {
    // Optional explicit provider: smtp | console | mock (see services/email/index.ts).
    // Unset = automatic: SMTP when fully configured, otherwise the dev console.
    provider: process.env.EMAIL_PROVIDER?.trim().toLowerCase() || undefined,
    from: process.env.EMAIL_FROM ?? 'SmartPrint <no-reply@smartprint.dev>',
    host: process.env.EMAIL_HOST,
    port: emailPort,
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
  },
};
