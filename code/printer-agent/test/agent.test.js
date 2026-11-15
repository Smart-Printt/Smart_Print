'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { processNextJob, readConfig } = require('../src/agent');
const { createApi } = require('../src/api');
const { createPrinter, lpArgs, resolveMethod, sumatraArgs } = require('../src/printer');

const ITEM = {
  documentId: 'd1',
  fileName: 'notes.docx',
  copies: 2,
  printType: 'BW',
  paperSize: 'A4',
  sides: 'DOUBLE',
  pageRange: '1-3',
};
const QUEUE = { queueId: 'q1', orderId: 'o1', orderCode: 'SP-1', queueNumber: 7 };
const quiet = () => undefined;

function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    startNext: async () => {
      calls.push('startNext');
      return QUEUE;
    },
    getOrder: async () => ({ orderCode: 'SP-1', items: [ITEM] }),
    downloadDocument: async () => ({ contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') }),
    complete: async (shopId, queueId) => {
      calls.push(`complete:${shopId}:${queueId}`);
      return {};
    },
    ...overrides,
  };
}

function fakePrinter(fail = 0) {
  const printed = [];
  return {
    printed,
    print: async (file, item, label) => {
      if (fail > 0) {
        fail -= 1;
        throw new Error('printer offline');
      }
      printed.push({ file, item, label, content: await fs.readFile(file, 'utf8') });
      return null;
    },
  };
}

describe('processNextJob', () => {
  it('prints every item with its settings, then marks the order ready', async () => {
    const api = fakeApi();
    const printer = fakePrinter();
    assert.equal(await processNextJob({ api, printer, shopId: 's1', logger: quiet }), 'printed');
    assert.equal(printer.printed.length, 1);
    assert.equal(printer.printed[0].content, '%PDF-1.4');
    assert.deepEqual(printer.printed[0].item, ITEM);
    assert.ok(api.calls.includes('complete:s1:q1'));
  });

  it('does nothing when no order is waiting', async () => {
    const api = fakeApi({ startNext: async () => null });
    assert.equal(await processNextJob({ api, printer: fakePrinter(), shopId: 's1', logger: quiet }), 'idle');
  });

  it('retries a failing printer', async () => {
    const result = await processNextJob({
      api: fakeApi(),
      printer: fakePrinter(2),
      shopId: 's1',
      retryDelayMs: 1,
      logger: quiet,
    });
    assert.equal(result, 'printed');
  });

  it('leaves the order for staff (not READY) when printing keeps failing', async () => {
    const api = fakeApi();
    const result = await processNextJob({ api, printer: fakePrinter(5), shopId: 's1', retryDelayMs: 1, logger: quiet });
    assert.equal(result, 'failed');
    assert.ok(!api.calls.some((c) => c.startsWith('complete')));
  });

  it('never sends a Word file to the printer', async () => {
    const api = fakeApi({
      downloadDocument: async () => ({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: Buffer.from('PK'),
      }),
    });
    const printer = fakePrinter();
    assert.equal(await processNextJob({ api, printer, shopId: 's1', logger: quiet }), 'failed');
    assert.equal(printer.printed.length, 0);
  });
});

describe('printer commands', () => {
  it('builds lp options from the order settings', () => {
    assert.deepEqual(lpArgs(ITEM, 'f.pdf', 'Office'), [
      '-d',
      'Office',
      '-n',
      '2',
      '-o',
      'media=A4',
      '-o',
      'sides=two-sided-long-edge',
      '-o',
      'print-color-mode=monochrome',
      '-o',
      'page-ranges=1-3',
      'f.pdf',
    ]);
  });

  it('builds SumatraPDF settings from the order settings', () => {
    const item = { ...ITEM, pageRange: null, printType: 'COLOR', sides: 'SINGLE' };
    assert.deepEqual(sumatraArgs(item, 'f.pdf', ''), [
      '-print-to-default',
      '-silent',
      '-print-settings',
      '2x,simplex,color,paper=A4',
      'f.pdf',
    ]);
  });

  it('picks lp or SumatraPDF from the operating system', () => {
    assert.equal(resolveMethod('auto', 'win32'), 'sumatra');
    assert.equal(resolveMethod('auto', 'linux'), 'lp');
    assert.equal(resolveMethod('folder', 'win32'), 'folder');
  });

  it('runs the print command and reports its error', async () => {
    const seen = [];
    const printer = createPrinter({
      method: 'lp',
      execFileImpl: (cmd, args, _opts, cb) => {
        seen.push([cmd, args]);
        cb(new Error('x'), '', 'no such printer');
      },
    });
    await assert.rejects(printer.print('f.pdf', ITEM, 'SP-1_1'), /no such printer/);
    assert.equal(seen[0][0], 'lp');
  });

  it('folder mode saves a copy named after the order and settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
    const src = path.join(dir, 'in.pdf');
    await fs.writeFile(src, '%PDF');
    const printer = createPrinter({ method: 'folder', outputDir: path.join(dir, 'out') });
    const saved = await printer.print(src, ITEM, 'SP-1_1');
    assert.equal(path.basename(saved), 'SP-1_1_2x_BW_A4_DOUBLE_pages-1-3.pdf');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects an unknown method', () => {
    assert.throws(() => createPrinter({ method: 'fax' }), /Unknown PRINT_METHOD/);
  });
});

describe('api', () => {
  function json(status, body) {
    return { ok: status < 400, status, json: async () => body, headers: new Map() };
  }

  function loginResponse(token, user = { role: 'SHOP_STAFF', shopId: 's1' }) {
    return json(200, { data: { token, user } });
  }

  it('logs in again when the access token has expired', async () => {
    let logins = 0;
    let queueCalls = 0;
    const api = createApi({
      baseUrl: 'http://x',
      email: 'e',
      password: 'p',
      fetchImpl: async (url) => {
        if (url.endsWith('/api/auth/login')) {
          logins += 1;
          return loginResponse(`t${logins}`);
        }
        queueCalls += 1;
        return queueCalls === 1 ? json(401, {}) : json(200, { data: { current: null } });
      },
    });
    assert.equal(await api.currentJob('s1'), null);
    assert.equal(logins, 2);
  });

  it('treats "nothing waiting" and "already printing" as no job', async () => {
    for (const status of [404, 409]) {
      const api = createApi({
        baseUrl: 'http://x',
        email: 'e',
        password: 'p',
        fetchImpl: async (url) => (url.endsWith('/login') ? loginResponse('t') : json(status, { message: 'none' })),
      });
      assert.equal(await api.startNext('s1'), null);
    }
  });

  it('refuses an account that is not shop staff', async () => {
    const api = createApi({
      baseUrl: 'http://x',
      email: 'e',
      password: 'p',
      fetchImpl: async () => loginResponse('t', { role: 'STUDENT', shopId: null }),
    });
    await assert.rejects(api.login(), /shop staff/);
  });
});

describe('readConfig', () => {
  it('names missing settings', () => {
    assert.throws(() => readConfig({}), /SMARTPRINT_URL, AGENT_EMAIL, AGENT_PASSWORD/);
  });

  it('reads settings with defaults', () => {
    const c = readConfig({ SMARTPRINT_URL: 'https://x/', AGENT_EMAIL: 'e', AGENT_PASSWORD: 'p' });
    assert.equal(c.baseUrl, 'https://x');
    assert.equal(c.method, 'auto');
    assert.equal(c.pollMs, 10_000);
  });
});
