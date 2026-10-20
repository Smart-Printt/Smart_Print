import fsSync from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';

import request from 'supertest';

import { prisma } from '../src/config/prisma';
import { storageService } from '../src/services/storage';
import { eventually, withTimeout } from './helpers/concurrency';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// Download/view stream handling: errors BEFORE streaming must be ordinary
// JSON errors; a failure DURING streaming must close the incomplete response
// without crashing the process; a client that disconnects must release the
// underlying file handle.

jest.setTimeout(60_000);

const fx = createRaceFixtures('streamtest.');
const PDF = fsSync.readFileSync(path.join(__dirname, 'fixtures', 'valid.pdf'));

let server: http.Server;
let port: number;
let student: TestUser;
let documentId: string;
let storageKey: string;

beforeAll(async () => {
  server = http.createServer(fx.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  student = await fx.registerStudent('owner');
});

beforeEach(async () => {
  documentId = await fx.uploadDocument(student.token);
  storageKey = (await prisma.document.findUniqueOrThrow({ where: { documentId } })).storageKey;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fx.cleanup();
});

interface RawResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  complete: boolean;
  error?: Error;
}

// Plain http client (no keep-alive) so aborted responses are observable.
function rawGet(urlPath: string, options: { destroyAfterFirstChunk?: boolean } = {}): Promise<RawResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    let settled = false;
    const finish = (extra: Partial<RawResult>): void => {
      if (settled) return;
      settled = true;
      resolve({ status, headers, body: Buffer.concat(chunks), complete: false, ...extra });
    };

    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, agent: false, headers: { Authorization: `Bearer ${student.token}` } },
      (res) => {
        status = res.statusCode ?? 0;
        headers = res.headers;
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (options.destroyAfterFirstChunk) {
            req.destroy();
          }
        });
        res.on('end', () => finish({ complete: res.complete }));
        res.on('aborted', () => finish({ complete: false }));
        res.on('error', (error) => finish({ error }));
        res.on('close', () => finish({ complete: res.complete }));
      },
    );
    req.on('error', (error) => finish({ error }));
  });
}

describe('successful streaming', () => {
  it('download sends the exact bytes with a Content-Length and attachment disposition', async () => {
    const res = await rawGet(`/api/documents/${documentId}/download`);
    expect(res.status).toBe(200);
    expect(res.complete).toBe(true);
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
    expect(res.body.equals(PDF)).toBe(true);
  });

  it('view sends the same bytes inline', async () => {
    const res = await rawGet(`/api/documents/${documentId}/view`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/^inline/);
    expect(res.body.equals(PDF)).toBe(true);
  });
});

describe('errors before streaming starts are ordinary JSON errors', () => {
  it('a missing file is a JSON 404 with no download headers', async () => {
    await storageService.delete(storageKey);

    const res = await request(fx.app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${student.token}`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.success).toBe(false);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('a file that cannot be opened (EACCES) is a JSON 500, never a half-sent download', async () => {
    jest
      .spyOn(storageService, 'openReadStream')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    const res = await request(fx.app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${student.token}`);

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: false, message: 'Internal server error' });
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it("another user's document is still a plain 404", async () => {
    const other = await fx.registerStudent('intruder');
    const res = await request(fx.app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
  });
});

describe('failure while streaming', () => {
  it('closes the incomplete response, destroys the source and keeps the process alive', async () => {
    const uncaught = jest.fn();
    process.on('uncaughtException', uncaught);
    // The failure is expected to be logged; keep the test output clean.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const source = new Readable({ read() {} });
      source.push(Buffer.alloc(100, 'x')); // fewer bytes than Content-Length
      jest.spyOn(storageService, 'openReadStream').mockResolvedValue(source);
      setTimeout(() => source.destroy(new Error('simulated disk failure')), 50);

      const res = await withTimeout(rawGet(`/api/documents/${documentId}/download`), 10_000, 'aborted download');

      // The client must be able to tell the body is incomplete.
      expect(res.complete).toBe(false);
      expect(res.body.length).toBeLessThan(PDF.length);
      expect(source.destroyed).toBe(true);

      // No uncaught exception, and the server still answers.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith('Document stream failed mid-response:', expect.any(Error));
      const health = await request(fx.app).get('/health');
      expect(health.status).toBe(200);
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });
});

describe('client disconnect', () => {
  it('releases the underlying stream when the client goes away mid-download', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(100, 'x')); // never ends: the client must be the one to leave
    jest.spyOn(storageService, 'openReadStream').mockResolvedValue(source);

    const res = await withTimeout(
      rawGet(`/api/documents/${documentId}/download`, { destroyAfterFirstChunk: true }),
      10_000,
      'client disconnect',
    );
    expect(res.complete).toBe(false);

    await eventually(async () => source.destroyed, 'source stream to be destroyed after disconnect', 5_000);
  });
});
