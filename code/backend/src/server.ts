import { assertStartupSafety, loadSecurityConfig } from './config/security';

async function main(): Promise<void> {
  // Production-safety checks run first, before the app modules are loaded:
  // some of them initialise services at import time, and the database is
  // never contacted by a process that is about to be refused.
  assertStartupSafety(loadSecurityConfig());

  const { createApp } = await import('./app');
  const { env } = await import('./config/env');
  const { prisma } = await import('./config/prisma');

  // Startup database connectivity check.
  await prisma.$connect();
  // eslint-disable-next-line no-console
  console.log('Database connection established.');

  const app = createApp();
  const label = process.env.APP_ENV ? `${env.nodeEnv}, ${process.env.APP_ENV}` : env.nodeEnv;

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`SmartPrint backend listening on port ${env.port} (${label})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start SmartPrint backend:', err);
  process.exit(1);
});
