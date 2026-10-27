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
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
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
