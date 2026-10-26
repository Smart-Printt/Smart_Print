import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  SecurityConfig,
  assertStartupSafety,
  loadSecurityConfig,
  parseAllowedOrigins,
} from '../src/config/security';
import { mockPaymentProvider } from '../src/services/payments/mockPaymentProvider';

const BACKEND_ROOT = path.resolve(__dirname, '..');

function productionConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  const base = loadSecurityConfig();
  return {
    ...base,
    rawNodeEnv: 'production',
    nodeEnv: 'production',
    paymentProvider: 'live-provider-placeholder',
    corsAllowedOrigins: ['https://app.example.edu'],
    frontendUrl: 'https://app.example.edu',
    rateLimit: { ...base.rateLimit, enabled: true },
    ...overrides,
  };
}

// Restores any process.env keys a test changed.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('assertStartupSafety - payment provider', () => {
  it('refuses PAYMENT_PROVIDER=mock when NODE_ENV=production', () => {
    expect(() => assertStartupSafety(productionConfig({ paymentProvider: 'mock' }), false)).toThrow(
      /PAYMENT_PROVIDER is "mock"/,
    );
  });

  it('allows the mock provider in development and test', () => {
    for (const nodeEnv of ['development', 'test']) {
      const config = productionConfig({ rawNodeEnv: nodeEnv, nodeEnv, paymentProvider: 'mock' });
      expect(() => assertStartupSafety(config, false)).not.toThrow();
    }
  });

  it('passes a fully configured production setup with a non-mock provider', () => {
    expect(() => assertStartupSafety(productionConfig(), true)).not.toThrow();
  });
});

describe('assertStartupSafety - NODE_ENV', () => {
  it.each(['staging', 'prod', 'Production', 'PRODUCTION', '', ' production'])(
    'refuses NODE_ENV=%j',
    (value) => {
      const config = productionConfig({ rawNodeEnv: value, nodeEnv: value, paymentProvider: 'mock' });
      expect(() => assertStartupSafety(config, false)).toThrow(/is not valid/);
    },
  );

  it('refuses the compiled build when NODE_ENV is unset', () => {
    const config = productionConfig({ rawNodeEnv: undefined, nodeEnv: 'development', paymentProvider: 'mock' });
    expect(() => assertStartupSafety(config, true)).toThrow(/NODE_ENV is not set/);
  });

  it('keeps the development default when running from TypeScript sources', () => {
    const config = productionConfig({ rawNodeEnv: undefined, nodeEnv: 'development', paymentProvider: 'mock' });
    expect(() => assertStartupSafety(config, false)).not.toThrow();
  });
});

describe('assertStartupSafety - CORS and rate limits in production', () => {
  it('requires at least one allowed origin', () => {
    expect(() => assertStartupSafety(productionConfig({ corsAllowedOrigins: [] }), false)).toThrow(
      /CORS_ALLOWED_ORIGINS must list/,
    );
  });

  it('requires https origins', () => {
    const config = productionConfig({ corsAllowedOrigins: ['http://app.example.edu'] });
    expect(() => assertStartupSafety(config, false)).toThrow(/must use https/);
  });

  it('refuses disabled rate limiting', () => {
    const base = productionConfig();
    const config = { ...base, rateLimit: { ...base.rateLimit, enabled: false } };
    expect(() => assertStartupSafety(config, false)).toThrow(/RATE_LIMIT_ENABLED=false/);
  });

  it('reports every problem at once', () => {
    const base = productionConfig({ paymentProvider: 'mock', corsAllowedOrigins: [] });
    const config = { ...base, rateLimit: { ...base.rateLimit, enabled: false } };
    try {
      assertStartupSafety(config, false);
      throw new Error('expected assertStartupSafety to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/PAYMENT_PROVIDER/);
      expect(message).toMatch(/CORS_ALLOWED_ORIGINS/);
      expect(message).toMatch(/RATE_LIMIT_ENABLED/);
    }
  });
});

describe('security configuration parsing', () => {
  it('rejects wildcard origins', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/wildcards/);
    expect(() => parseAllowedOrigins('https://*.example.edu')).toThrow(/wildcards/);
  });

  it('rejects origins with a path, query or credentials', () => {
    expect(() => parseAllowedOrigins('https://app.example.edu/login')).toThrow(/bare origin/);
    expect(() => parseAllowedOrigins('https://app.example.edu?x=1')).toThrow(/bare origin/);
    expect(() => parseAllowedOrigins('https://user@app.example.edu')).toThrow(/bare origin/);
  });

  it('accepts exact origins, ignoring a trailing slash and duplicates', () => {
    expect(parseAllowedOrigins('https://app.example.edu/, https://app.example.edu,http://localhost:5173')).toEqual([
      'https://app.example.edu',
      'http://localhost:5173',
    ]);
  });

  it('rejects TRUST_PROXY=true and unknown payment providers', () => {
    withEnv({ TRUST_PROXY: 'true' }, () => {
      expect(() => loadSecurityConfig()).toThrow(/TRUST_PROXY/);
    });
    withEnv({ PAYMENT_PROVIDER: 'something-else' }, () => {
      expect(() => loadSecurityConfig()).toThrow(/not a known payment provider/);
    });
  });

  it('leaves the production origin list empty when CORS_ALLOWED_ORIGINS is unset', () => {
    withEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: undefined }, () => {
      expect(loadSecurityConfig().corsAllowedOrigins).toEqual([]);
    });
  });
});

describe('mock payment provider second safety net', () => {
  it('works in the test environment', async () => {
    await expect(mockPaymentProvider.confirmPayment({ providerReference: 'TXN-1' })).resolves.toEqual({
      outcome: 'SUCCESS',
    });
  });

  it.each(['production', 'staging'])('refuses every operation when NODE_ENV=%s', async (nodeEnv) => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    try {
      await expect(mockPaymentProvider.initiatePayment({} as never)).rejects.toThrow(/mock payment provider is disabled/);
      await expect(mockPaymentProvider.confirmPayment({ providerReference: 'x' })).rejects.toThrow(/disabled/);
      await expect(mockPaymentProvider.initiateRefund({} as never)).rejects.toThrow(/disabled/);
      await expect(mockPaymentProvider.confirmRefund({ providerReference: 'x' })).rejects.toThrow(/disabled/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

// Starts the real server entry point in a child process. DATABASE_URL points
// at a closed local port with placeholder credentials, so if the guard ever
// failed to stop startup, the process could not reach any real database.
function startServer(env: Record<string, string>) {
  return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/server.ts'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://placeholder:placeholder@127.0.0.1:1/unreachable',
      JWT_SECRET: 'startup-guard-test-only',
      CORS_ALLOWED_ORIGINS: 'https://app.example.edu',
      RATE_LIMIT_ENABLED: 'true',
      PAYMENT_PROVIDER: 'mock',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('server startup (child process)', () => {
  jest.setTimeout(120_000);

  it('exits with an error before touching the database when NODE_ENV=production and PAYMENT_PROVIDER=mock', () => {
    const result = startServer({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to start SmartPrint backend/);
    expect(result.stderr).toMatch(/PAYMENT_PROVIDER is "mock"/);
    expect(result.stdout).not.toMatch(/Database connection established/);
  });

  it('exits with an error when NODE_ENV=staging', () => {
    const result = startServer({ NODE_ENV: 'staging' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/NODE_ENV="staging" is not valid/);
    expect(result.stdout).not.toMatch(/Database connection established/);
  });
});

describe('assertStartupSafety - FRONTEND_URL (password reset links)', () => {
  it('passes with a public https URL (a trailing slash is fine)', () => {
    for (const frontendUrl of ['https://print.example.edu', 'https://print.example.edu/', 'https://print.example.edu/app']) {
      expect(() => assertStartupSafety(productionConfig({ frontendUrl }), true)).not.toThrow();
    }
  });

  it('refuses a production start with FRONTEND_URL unset or blank (links would point at localhost)', () => {
    for (const frontendUrl of [undefined, '', '   ']) {
      expect(() => assertStartupSafety(productionConfig({ frontendUrl }), true)).toThrow(/FRONTEND_URL must be set/);
    }
  });

  it.each(['http://print.example.edu', 'ftp://print.example.edu'])('refuses a non-https FRONTEND_URL: %s', (frontendUrl) => {
    expect(() => assertStartupSafety(productionConfig({ frontendUrl }), true)).toThrow(/must use https/);
  });

  it.each(['https://localhost', 'https://127.0.0.1:5173', 'https://[::1]'])('refuses a loopback FRONTEND_URL: %s', (frontendUrl) => {
    expect(() => assertStartupSafety(productionConfig({ frontendUrl }), true)).toThrow(/must not point at/);
  });

  it('refuses an unparseable FRONTEND_URL and one carrying credentials / a query string', () => {
    expect(() => assertStartupSafety(productionConfig({ frontendUrl: 'not a url' }), true)).toThrow(/not a valid URL/);
    expect(() => assertStartupSafety(productionConfig({ frontendUrl: 'https://user:pw@print.example.edu' }), true)).toThrow(/credentials/);
    expect(() => assertStartupSafety(productionConfig({ frontendUrl: 'https://print.example.edu/?x=1' }), true)).toThrow(/query string/);
  });

  it('is not enforced in development or test (the localhost default is intended there)', () => {
    for (const nodeEnv of ['development', 'test']) {
      const config = productionConfig({ rawNodeEnv: nodeEnv, nodeEnv, paymentProvider: 'mock', frontendUrl: undefined });
      expect(() => assertStartupSafety(config, false)).not.toThrow();
    }
  });
});
