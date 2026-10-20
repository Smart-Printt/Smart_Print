# Security configuration

This document covers the production-safety settings of the SmartPrint backend:
the startup guard, payment provider selection, CORS, security headers, rate
limiting and the production Docker image. The code lives in
`src/config/security.ts`, `src/middleware/cors.middleware.ts`,
`src/middleware/rateLimit.middleware.ts` and `Dockerfile.prod`.

All values below are placeholders. Never commit real secrets.

## Environment variables

| Variable | Default | Valid values | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` (only when running from TypeScript sources) | exactly `development`, `test` or `production` | Selects behaviour. Any other value refuses to start. |
| `APP_ENV` | unset | free text, e.g. `staging` | Label shown in the startup log. Never changes any check. |
| `PAYMENT_PROVIDER` | `mock` | `mock` | Payment provider. `mock` is simulated and is refused in production. |
| `CORS_ALLOWED_ORIGINS` | development/test: `FRONTEND_URL`, `http://localhost:5173`, `http://localhost:5175`, `http://127.0.0.1:5173`; production: none | comma-separated exact origins (`scheme://host[:port]`) | Browser origins allowed to call the API. |
| `TRUST_PROXY` | `false` | `false`, `0`, or a positive number of proxy hops | Needed behind a reverse proxy or load balancer so client IPs (and per-IP limits) are correct. `true` is rejected because it lets clients spoof their IP. |
| `RATE_LIMIT_ENABLED` | `true` | `true`, `false` | Turns rate limiting on or off. `false` is refused in production. |
| `RATE_LIMIT_<NAME>_MAX` | see the table below | positive integer | Requests allowed per window. |
| `RATE_LIMIT_<NAME>_WINDOW_MS` | see the table below | positive integer (milliseconds) | Length of the window. |

## NODE_ENV rules

- Only `development`, `test` and `production` are accepted, compared exactly.
  `staging`, `prod`, `Production` or an empty value refuse to start.
- **Every deployed environment, including staging, must use
  `NODE_ENV=production`.** Use `APP_ENV` to tell deployments apart.
- The compiled build (`node dist/server.js`) refuses to start if `NODE_ENV`
  is not set at all. A `NODE_ENV` line in a `.env` file counts as set.
- `Dockerfile.prod` sets `NODE_ENV=production`.

## Production startup requirements

With `NODE_ENV=production`, the server refuses to start, before connecting to
the database, unless all of the following hold:

1. `PAYMENT_PROVIDER` is not `mock`. There is no override. Until a real
   provider is integrated, a production deployment cannot start; this is
   intentional.
2. `CORS_ALLOWED_ORIGINS` lists at least one origin, and every origin uses
   `https://`.
3. `RATE_LIMIT_ENABLED` is not `false`.

All problems are reported together. In addition, the existing email check
requires `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER` and `EMAIL_PASSWORD` in
production.

As a second safety net, the mock payment provider itself refuses every
operation unless `NODE_ENV` is `development` or `test`.

## CORS

- Origins must match exactly, including scheme and port. Wildcards (`*`) and
  entries with a path, query or credentials are rejected in every environment.
- A browser request from an unlisted origin is refused with
  `403 { "success": false, "message": "Origin not allowed" }`, preflights
  included. The literal origin `null` is always refused.
- Requests without an `Origin` header (curl, health checks, server-to-server
  calls) are allowed. Browsers always send `Origin` on cross-origin requests,
  and protected routes still require a bearer token.
- No cookies are used, so credentials are not enabled.

Example:

```
CORS_ALLOWED_ORIGINS=https://smartprint.example.edu,https://admin.smartprint.example.edu
```

## Security headers

Helmet is applied to every response with its defaults, including
`X-Content-Type-Options: nosniff`, `Content-Security-Policy`,
`X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security`,
`Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy`, and
`X-Powered-By` is removed.

## Rate limits

| Name (`<NAME>`) | Route | Counted per | Default |
|---|---|---|---|
| `LOGIN` | `POST /api/auth/login` | client IP + email; failed attempts only | 5 per 60 s |
| `AUTH_IP` | login, register, forgot-password, reset-password combined | client IP | 100 per 15 min |
| `REGISTER` | `POST /api/auth/register` | client IP | 20 per hour |
| `FORGOT_PASSWORD` | `POST /api/auth/forgot-password` | client IP + email | 3 per 15 min |
| `RESET_PASSWORD` | `POST /api/auth/reset-password` | client IP | 10 per 15 min |
| `UPLOAD` | `POST /api/documents` | authenticated user | 30 per 10 min |

- A blocked request receives
  `429 { "success": false, "message": "Too many ... Please try again later." }`
  with `Retry-After`, `RateLimit` and `RateLimit-Policy` headers.
- The upload limit runs after authentication and before the file is parsed,
  so a rejected upload is never buffered in memory.
- Strict limits are per account, and per-IP limits are generous, because many
  students may share one campus IP address.
- Counters are kept in memory per process. Running several instances behind
  a load balancer would need a shared store (e.g. Redis).
- Behind a reverse proxy, set `TRUST_PROXY`, otherwise every user appears to
  come from the proxy's address and is limited together.

Example (`RATE_LIMIT_` + name + `_MAX` / `_WINDOW_MS`):

```
RATE_LIMIT_LOGIN_MAX=5
RATE_LIMIT_LOGIN_WINDOW_MS=60000
RATE_LIMIT_UPLOAD_MAX=30
RATE_LIMIT_UPLOAD_WINDOW_MS=600000
```

## Tests

`tests/jest.setup.ts` sets `RATE_LIMIT_ENABLED=false` for the general suite.
`tests/rateLimit.test.ts` enables limits explicitly with
`createApp({ rateLimit: { enabled: true, login: { max: 5, windowMs: 60000 } } })`,
so no test has to wait for a window to expire. `createApp()` also accepts
`corsAllowedOrigins` and `trustProxy` overrides.

## Production image

```
docker build -f Dockerfile.prod -t smartprint-backend .
```

- Based on `node:24-bookworm-slim`; compiles TypeScript and runs
  `node dist/server.js` as the non-root `node` user.
- Sets `NODE_ENV=production` and `PORT=4321`.
- Uploads need a writable volume mounted at `/app/uploads`.
- Database migrations are never run on startup. Apply them as a separate,
  deliberate step from the `build` stage (see the comment in
  `Dockerfile.prod`).
- `.dockerignore` keeps `.env` and every `.env.*` file (except the example
  templates) out of the build context.

Example runtime configuration (placeholders):

```
NODE_ENV=production
APP_ENV=staging
DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE
JWT_SECRET=<long random value>
PAYMENT_PROVIDER=<real provider, once integrated>
CORS_ALLOWED_ORIGINS=https://smartprint.example.edu
TRUST_PROXY=1
FRONTEND_URL=https://smartprint.example.edu
EMAIL_HOST=<smtp host>
EMAIL_PORT=587
EMAIL_USER=<smtp user>
EMAIL_PASSWORD=<smtp password>
```
