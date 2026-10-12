import request from 'supertest';

import { createApp } from '../src/app';

const ALLOWED_ORIGIN = 'https://app.example.edu';
const app = createApp({ corsAllowedOrigins: [ALLOWED_ORIGIN] });

describe('CORS allowlist', () => {
  it('rejects a request from an unlisted browser origin with 403', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, message: 'Origin not allowed' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a preflight from an unlisted origin', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects the "null" origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'null');
    expect(res.status).toBe(403);
  });

  it('rejects an origin that differs only by scheme or port', async () => {
    const http = await request(app).get('/health').set('Origin', 'http://app.example.edu');
    const port = await request(app).get('/health').set('Origin', 'https://app.example.edu:8443');
    expect(http.status).toBe(403);
    expect(port.status).toBe(403);
  });

  it('echoes an allowed origin exactly', async () => {
    const res = await request(app).get('/health').set('Origin', ALLOWED_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a preflight from an allowed origin', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/i);
  });

  it('allows requests without an Origin header (curl, health checks, server-to-server)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('security headers', () => {
  it.each(['/health', '/api/does-not-exist'])('are set on %s', async (path) => {
    const res = await request(app).get(path);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('are also set on a rejected-origin response', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
