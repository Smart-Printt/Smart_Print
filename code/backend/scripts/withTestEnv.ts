import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { loadTestEnv } from './testDbGuard';

// Runs a command (e.g. `prisma migrate deploy`) against the test database
// only: loads .env.test, verifies it with the test-db guard, and only then
// spawns the command with that environment. Used by the test:db:* npm
// scripts - see package.json.
const args = process.argv.slice(2);
if (args.length === 0) {
  // eslint-disable-next-line no-console
  console.error('Usage: ts-node scripts/withTestEnv.ts <command> [args...]');
  process.exit(1);
}

const target = loadTestEnv();
// eslint-disable-next-line no-console
console.log(
  `[test-db-guard] OK - running "${args.join(' ')}" against database "${target.database}" on ${target.host}:${target.port}`,
);

const result = spawnSync('npx', args, {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
  // npx is a .cmd shim on Windows, which needs a shell to launch.
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
