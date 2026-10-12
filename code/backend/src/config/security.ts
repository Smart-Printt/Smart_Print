import { env } from './env';

// Production-safety configuration: payment provider selection, CORS
// allowlist, proxy trust and rate limits. Everything is read from
// process.env at call time (not cached at import), so tests can build apps
// with different settings. See SECURITY_CONFIGURATION.md for every variable.

export const VALID_NODE_ENVS = ['development', 'test', 'production'] as const;
export const KNOWN_PAYMENT_PROVIDERS = ['mock'] as const;

const DEV_DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:5175', 'http://127.0.0.1:5173'];

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export const RATE_LIMIT_NAMES = [
  'login',
  'authIp',
  'register',
  'forgotPassword',
  'resetPassword',
  'upload',
] as const;
export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number];

export type RateLimitConfig = { enabled: boolean } & Record<RateLimitName, RateLimitRule>;

const RATE_LIMIT_DEFAULTS: Record<RateLimitName, RateLimitRule & { envPrefix: string }> = {
  login: { envPrefix: 'LOGIN', max: 5, windowMs: 60_000 },
  authIp: { envPrefix: 'AUTH_IP', max: 100, windowMs: 15 * 60_000 },
  register: { envPrefix: 'REGISTER', max: 20, windowMs: 60 * 60_000 },
  forgotPassword: { envPrefix: 'FORGOT_PASSWORD', max: 3, windowMs: 15 * 60_000 },
  resetPassword: { envPrefix: 'RESET_PASSWORD', max: 10, windowMs: 15 * 60_000 },
  upload: { envPrefix: 'UPLOAD', max: 30, windowMs: 10 * 60_000 },
};

export interface SecurityConfig {
  // NODE_ENV exactly as provided (undefined when unset).
  rawNodeEnv: string | undefined;
  // Effective value, matching src/config/env.ts (unset -> 'development').
  nodeEnv: string;
  paymentProvider: string;
  corsAllowedOrigins: string[];
  trustProxy: number | false;
  rateLimit: RateLimitConfig;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be "true" or "false" (got "${raw}").`);
}

export function readPaymentProviderName(): string {
  const name = (process.env.PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase();
  if (!KNOWN_PAYMENT_PROVIDERS.includes(name as never)) {
    throw new Error(
      `PAYMENT_PROVIDER="${name}" is not a known payment provider. Known: ${KNOWN_PAYMENT_PROVIDERS.join(', ')}.`,
    );
  }
  return name;
}

// Accepts only exact browser origins (scheme://host[:port]). Wildcards are
// rejected in every environment - never only in production - so a wildcard
// can't sit unnoticed in a config that is later promoted.
export function parseAllowedOrigins(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const origins: string[] = [];
  for (const entry of entries) {
    if (entry.includes('*')) {
      throw new Error(`CORS_ALLOWED_ORIGINS must not contain wildcards (got "${entry}").`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" must use http or https.`);
    }
    if (entry.replace(/\/$/, '') !== url.origin) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS entry "${entry}" must be a bare origin (scheme://host[:port]) with no path, query or credentials.`,
      );
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}

function resolveAllowedOrigins(nodeEnv: string): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (raw !== undefined && raw.trim() !== '') {
    return parseAllowedOrigins(raw);
  }
  if (nodeEnv === 'production') {
    // Left empty on purpose: assertStartupSafety refuses to start without it.
    return [];
  }
  const defaults = [...DEV_DEFAULT_ORIGINS];
  try {
    defaults.unshift(new URL(env.frontendUrl).origin);
  } catch {
    // An invalid FRONTEND_URL just means it isn't added to the dev defaults.
  }
  return parseAllowedOrigins(defaults.join(','));
}

// TRUST_PROXY is the number of reverse-proxy hops in front of the app.
// "true" (trust everything) is rejected: it lets any client spoof its IP
// through X-Forwarded-For and defeat the per-IP rate limits.
function resolveTrustProxy(): number | false {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'false' || raw.trim() === '0') {
    return false;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops <= 0) {
    throw new Error(`TRUST_PROXY must be "false" or a positive number of proxy hops (got "${raw}").`);
  }
  return hops;
}

function resolveRateLimits(): RateLimitConfig {
  const config = { enabled: booleanFromEnv('RATE_LIMIT_ENABLED', true) } as RateLimitConfig;
  for (const name of RATE_LIMIT_NAMES) {
    const defaults = RATE_LIMIT_DEFAULTS[name];
    config[name] = {
      max: positiveIntFromEnv(`RATE_LIMIT_${defaults.envPrefix}_MAX`, defaults.max),
      windowMs: positiveIntFromEnv(`RATE_LIMIT_${defaults.envPrefix}_WINDOW_MS`, defaults.windowMs),
    };
  }
  return config;
}

export function loadSecurityConfig(): SecurityConfig {
  const rawNodeEnv = process.env.NODE_ENV;
  const nodeEnv = rawNodeEnv ?? 'development';
  return {
    rawNodeEnv,
    nodeEnv,
    paymentProvider: readPaymentProviderName(),
    corsAllowedOrigins: resolveAllowedOrigins(nodeEnv),
    trustProxy: resolveTrustProxy(),
    rateLimit: resolveRateLimits(),
  };
}

// True when running the compiled JavaScript build (dist/), false under
// ts-node / ts-node-dev / ts-jest, which execute the .ts sources directly.
export function isCompiledBuild(): boolean {
  return __filename.endsWith('.js');
}

// Called by server.ts before anything else is loaded. There is deliberately
// no override variable: a deployment that fails these checks must be fixed,
// not exempted.
export function assertStartupSafety(config: SecurityConfig, compiled: boolean = isCompiledBuild()): void {
  const problems: string[] = [];

  if (config.rawNodeEnv === undefined) {
    if (compiled) {
      problems.push(
        'NODE_ENV is not set. The compiled build requires NODE_ENV to be set explicitly ' +
          '("production" for any deployed environment).',
      );
    }
  } else if (!VALID_NODE_ENVS.includes(config.rawNodeEnv as never)) {
    problems.push(
      `NODE_ENV="${config.rawNodeEnv}" is not valid. Use exactly one of: ${VALID_NODE_ENVS.join(', ')}. ` +
        'Every deployed environment, including staging, must use "production" (use APP_ENV to label it).',
    );
  }

  if (config.nodeEnv === 'production') {
    if (config.paymentProvider === 'mock') {
      problems.push(
        'PAYMENT_PROVIDER is "mock" (simulated payments). The mock provider is never allowed in production.',
      );
    }
    if (config.corsAllowedOrigins.length === 0) {
      problems.push('CORS_ALLOWED_ORIGINS must list the production frontend origin(s).');
    }
    const insecure = config.corsAllowedOrigins.filter((origin) => !origin.startsWith('https://'));
    if (insecure.length > 0) {
      problems.push(`CORS_ALLOWED_ORIGINS must use https in production (not allowed: ${insecure.join(', ')}).`);
    }
    if (!config.rateLimit.enabled) {
      problems.push('RATE_LIMIT_ENABLED=false is not allowed in production.');
    }
  }

  if (problems.length > 0) {
    throw new Error(`[startup] Refusing to start SmartPrint backend:\n  - ${problems.join('\n  - ')}`);
  }
}
