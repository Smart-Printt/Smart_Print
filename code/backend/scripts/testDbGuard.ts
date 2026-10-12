import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

// Hard safety guard for everything that touches the automated-test database
// (the Jest/Supertest suite and the test:db:* scripts). Several test files
// create and delete rows directly, so they must never run against the
// development database. The expected target is deliberately hardcoded here
// rather than read from the environment - otherwise the same .env.test that
// is being checked could also redefine what "safe" means.
//
// Never prints a connection string or password - only the database name,
// host and port, which are not secrets.
const EXPECTED_DATABASE = 'smartprint_test';
const EXPECTED_HOSTS = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5432';

const BACKEND_ROOT = path.resolve(__dirname, '..');
const TEST_ENV_FILE = path.join(BACKEND_ROOT, '.env.test');
const DEV_ENV_FILE = path.join(BACKEND_ROOT, '.env');

interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
}

function parseTarget(databaseUrl: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('[test-db-guard] DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`[test-db-guard] DATABASE_URL must be a PostgreSQL URL (got "${url.protocol}").`);
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

function formatTarget(target: DatabaseTarget): string {
  return `database "${target.database}" on ${target.host}:${target.port}`;
}

export function assertTestDatabase(databaseUrl: string | undefined): DatabaseTarget {
  if (!databaseUrl) {
    throw new Error('[test-db-guard] DATABASE_URL is not set in .env.test.');
  }

  const target = parseTarget(databaseUrl);

  if (target.database !== EXPECTED_DATABASE) {
    throw new Error(
      `[test-db-guard] Refusing to run: expected database "${EXPECTED_DATABASE}", but DATABASE_URL points at ${formatTarget(target)}.`,
    );
  }
  if (!EXPECTED_HOSTS.includes(target.host) || target.port !== EXPECTED_PORT) {
    throw new Error(
      `[test-db-guard] Refusing to run: expected the local server (localhost:${EXPECTED_PORT}), but DATABASE_URL points at ${formatTarget(target)}.`,
    );
  }

  // Belt and braces: even a correctly named test URL must never be the same
  // database the development .env uses.
  if (fs.existsSync(DEV_ENV_FILE)) {
    const devUrl = dotenv.parse(fs.readFileSync(DEV_ENV_FILE)).DATABASE_URL;
    if (devUrl) {
      const dev = parseTarget(devUrl);
      if (
        dev.database === target.database &&
        dev.port === target.port &&
        EXPECTED_HOSTS.includes(dev.host)
      ) {
        throw new Error(
          `[test-db-guard] Refusing to run: .env and .env.test both point at ${formatTarget(target)}.`,
        );
      }
    }
  }

  return target;
}

// Loads .env.test over anything already in process.env (shell variables
// included), then verifies the result. Must run before src/config/env.ts is
// imported - that module's dotenv.config() never overrides variables that
// are already set, so the test values loaded here win.
export function loadTestEnv(): DatabaseTarget {
  if (!fs.existsSync(TEST_ENV_FILE)) {
    throw new Error(
      '[test-db-guard] Missing backend/.env.test - copy .env.test.example and point it at the smartprint_test database.',
    );
  }
  dotenv.config({ path: TEST_ENV_FILE, override: true });
  return assertTestDatabase(process.env.DATABASE_URL);
}
