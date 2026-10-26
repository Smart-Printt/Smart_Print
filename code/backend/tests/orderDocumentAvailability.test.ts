import crypto from 'node:crypto';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { storageService } from '../src/services/storage';
import { hashPassword } from '../src/utils/password';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// An order must never be created for a document whose stored file is gone:
// staff would be handed an order they cannot print. These tests pin down that
// the check (a) rejects with a clear 409, (b) writes NOTHING (no order, line
// item, history, payment or queue row), (c) leaves documents and existing
// orders alone, (d) never reveals anything about other users' documents, and
// (e) reports a storage FAULT as 503 rather than blaming the document.

jest.setTimeout(90_000);

const fx = createRaceFixtures('docavail.');

let student: TestUser;
let other: TestUser;
let shop: PrintShop;

beforeAll(async () => {
  student = await fx.registerStudent('student');
  other = await fx.registerStudent('other');
  shop = await fx.createShop('shop');
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

function body(documentIds: string[], shopId = shop.shopId) {
  return {
    shopId,
    items: documentIds.map((documentId) => ({ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' })),
  };
}

function post(token: string, payload: unknown, key?: string) {
  const req = request(fx.app).post('/api/orders').set('Authorization', `Bearer ${token}`);
  if (key) req.set('Idempotency-Key', key);
  return req.send(payload as object);
}

async function storageKeyOf(documentId: string): Promise<string> {
  return (await prisma.document.findUniqueOrThrow({ where: { documentId } })).storageKey;
}

// Everything an order creation could write, for one user.
async function footprint(userId: string) {
  return {
    orders: await prisma.order.count({ where: { userId } }),
    items: await prisma.orderDocument.count({ where: { order: { userId } } }),
    history: await prisma.orderStatusHistory.count({ where: { order: { userId } } }),
    payments: await prisma.payment.count({ where: { order: { userId } } }),
    queue: await prisma.queue.count({ where: { order: { userId } } }),
  };
}

describe('order creation checks that document files exist', () => {
  it('creates the order when the file is available (control)', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const res = await post(student.token, body([documentId]));
    expect(res.status).toBe(201);
    expect(res.body.data.order.items).toHaveLength(1);
  });

  it('rejects with 409 and a clear message when the file is missing, creating nothing', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const doc = await prisma.document.findUniqueOrThrow({ where: { documentId } });
    await storageService.delete(doc.storageKey);
    const before = await footprint(student.userId);

    const res = await post(student.token, body([documentId]));

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain(`"${doc.fileName}"`);
    expect(res.body.message).toMatch(/no longer available/i);
    expect(await footprint(student.userId)).toEqual(before);
  });

  it('does not delete or alter the document row of the missing file', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const key = await storageKeyOf(documentId);
    await storageService.delete(key);
    const rowBefore = await prisma.document.findUniqueOrThrow({ where: { documentId } });

    expect((await post(student.token, body([documentId]))).status).toBe(409);

    expect(await prisma.document.findUniqueOrThrow({ where: { documentId } })).toEqual(rowBefore);
  });

  it('rejects the whole order when only ONE of several documents is missing, naming only that one', async () => {
    const good1 = await fx.uploadDocument(student.token);
    const bad = await fx.uploadDocument(student.token);
    const good2 = await fx.uploadDocument(student.token);
    const badDoc = await prisma.document.findUniqueOrThrow({ where: { documentId: bad } });
    await storageService.delete(badDoc.storageKey);
    const before = await footprint(student.userId);

    const res = await post(student.token, body([good1, bad, good2]));

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/^The file for "[^"]+" is no longer available/);
    expect(await footprint(student.userId)).toEqual(before);
  });

  it('lists every missing file when several are missing', async () => {
    const a = await fx.uploadDocument(student.token);
    const b = await fx.uploadDocument(student.token);
    await storageService.delete(await storageKeyOf(a));
    await storageService.delete(await storageKeyOf(b));
    const res = await post(student.token, body([a, b]));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/^The files for .* are no longer available/);
  });

  it('accepts a multi-document order when every file is available', async () => {
    const ids = [await fx.uploadDocument(student.token), await fx.uploadDocument(student.token), await fx.uploadDocument(student.token)];
    const res = await post(student.token, body(ids));
    expect(res.status).toBe(201);
    expect(res.body.data.order.items).toHaveLength(3);
  });

  it('works again once the user re-uploads: a new document is accepted', async () => {
    const gone = await fx.uploadDocument(student.token);
    await storageService.delete(await storageKeyOf(gone));
    expect((await post(student.token, body([gone]))).status).toBe(409);
    const fresh = await fx.uploadDocument(student.token);
    expect((await post(student.token, body([fresh]))).status).toBe(201);
  });
});

describe('storage faults are not blamed on the document', () => {
  it('returns 503 (not 409) when storage cannot be checked, and creates nothing', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const before = await footprint(student.userId);
    jest.spyOn(storageService, 'checkAvailability').mockRejectedValue(Object.assign(new Error('boom /secret/path'), { code: 'EIO' }));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post(student.token, body([documentId]));

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/temporarily unavailable/i);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|EIO|boom/); // no internals leak to the client
    expect(await footprint(student.userId)).toEqual(before);
    // only the error CODE is logged (messages can contain paths)
    expect(errorLog).toHaveBeenCalledWith(expect.any(String), 'EIO');
  });

  it('a transient storage fault does not poison the next attempt (retry succeeds)', async () => {
    const documentId = await fx.uploadDocument(student.token);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = jest.spyOn(storageService, 'checkAvailability').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EMFILE' }));
    expect((await post(student.token, body([documentId]))).status).toBe(503);
    spy.mockRestore();
    expect((await post(student.token, body([documentId]))).status).toBe(201);
  });

  it('a fault while checking one of several documents fails the whole order, creating nothing', async () => {
    const ids = [await fx.uploadDocument(student.token), await fx.uploadDocument(student.token)];
    const keys = await Promise.all(ids.map(storageKeyOf));
    const before = await footprint(student.userId);
    const real = storageService.checkAvailability.bind(storageService);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(storageService, 'checkAvailability').mockImplementation(async (k) => {
      if (k === keys[1]) throw Object.assign(new Error('x'), { code: 'EACCES' });
      return real(k);
    });
    expect((await post(student.token, body(ids))).status).toBe(503);
    expect(await footprint(student.userId)).toEqual(before);
  });
});

describe('authorization and information leaks', () => {
  it("answers 404 'Document not found' for ANOTHER user's document - identical whether or not its file is missing", async () => {
    const theirs = await fx.uploadDocument(other.token);
    const withFile = await post(student.token, body([theirs]));
    await storageService.delete(await storageKeyOf(theirs));
    const withoutFile = await post(student.token, body([theirs]));
    const unknown = await post(student.token, body([crypto.randomUUID()]));

    for (const res of [withFile, withoutFile, unknown]) {
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Document not found');
    }
    expect(withFile.body).toEqual(withoutFile.body);
  });

  it("a missing file in someone else's document is never named in my error", async () => {
    const mine = await fx.uploadDocument(student.token);
    const theirs = await fx.uploadDocument(other.token);
    await storageService.delete(await storageKeyOf(theirs));
    const res = await post(student.token, body([mine, theirs]));
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Document not found');
  });
});

describe('existing orders and idempotency are unaffected', () => {
  it('an existing order stays intact and readable after its file disappears; new orders for that file are refused', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const created = await post(student.token, body([documentId]));
    expect(created.status).toBe(201);
    const orderId = created.body.data.order.orderId;

    await storageService.delete(await storageKeyOf(documentId));

    const read = await request(fx.app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${student.token}`);
    expect(read.status).toBe(200);
    expect(read.body.data.order.items[0].documentId).toBe(documentId);
    expect(await prisma.document.count({ where: { documentId } })).toBe(1);
    expect((await post(student.token, body([documentId]))).status).toBe(409);
  });

  it('an idempotent retry of an order created while the file existed still replays it, even if the file is gone now', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const key = crypto.randomUUID();
    const first = await post(student.token, body([documentId]), key);
    expect(first.status).toBe(201);

    await storageService.delete(await storageKeyOf(documentId));

    const retry = await post(student.token, body([documentId]), key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.order.orderId).toBe(first.body.data.order.orderId);
    // a genuinely NEW order (new key) for the same missing file is refused
    expect((await post(student.token, body([documentId]), crypto.randomUUID())).status).toBe(409);
  });

  it('a rejected request does not consume its idempotency key', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const doc = await prisma.document.findUniqueOrThrow({ where: { documentId } });
    const key = crypto.randomUUID();
    const bytes = await (async () => { const s = await storageService.openReadStream(doc.storageKey); const c: Buffer[] = []; for await (const x of s) c.push(Buffer.from(x)); return Buffer.concat(c); })();
    await storageService.delete(doc.storageKey);

    expect((await post(student.token, body([documentId]), key)).status).toBe(409);
    expect(await prisma.order.count({ where: { userId: student.userId, idempotencyKey: key } })).toBe(0);

    await storageService.save(doc.storageKey, bytes); // the file comes back
    expect((await post(student.token, body([documentId]), key)).status).toBe(201);
  });
});

describe('ordering under the document lock', () => {
  it('the check happens while the document rows are share-locked, so a concurrent deleteDocument cannot slip between check and commit', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const real = storageService.checkAvailability.bind(storageService);
    let lockedDuringCheck: boolean | null = null;
    jest.spyOn(storageService, 'checkAvailability').mockImplementation(async (k) => {
      // From a SEPARATE connection: can the document row be taken FOR UPDATE right now?
      // If the order transaction holds FOR SHARE on it, NOWAIT must fail.
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM documents WHERE document_id = $1 FOR UPDATE NOWAIT`, documentId);
        });
        lockedDuringCheck = false;
      } catch (err) {
        lockedDuringCheck = /could not obtain lock|55P03/i.test(String((err as Error).message));
      }
      return real(k);
    });

    expect((await post(student.token, body([documentId]))).status).toBe(201);
    expect(lockedDuringCheck).toBe(true);
  });
});

describe('free faculty orders (which would enqueue immediately)', () => {
  const CSE = 'CSE_FACULTY';
  let faculty: TestUser;
  let facultyShop: PrintShop;
  let ruleId: string;
  let createdShop = false;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: 'Doc Avail Faculty', email: `docavail.faculty.${Date.now()}@gmail.com`, passwordHash: await hashPassword('CorrectHorse123'), role: 'FACULTY', status: 'ACTIVE' },
    });
    faculty = { userId: user.userId, token: jwt.sign({ userId: user.userId, role: 'FACULTY' }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions) };
    const existing = await prisma.printShop.findUnique({ where: { shopCode: CSE } });
    createdShop = !existing;
    facultyShop =
      existing ??
      (await prisma.printShop.create({ data: { shopCode: CSE, shopName: 'CSE Department Faculty Printer', location: 'CSE Department, Faculty Block', contact: '9222222222', isActive: true, acceptingOrders: true } }));
    ruleId = (
      await prisma.shopPricingRule.create({
        data: { shopId: facultyShop.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 50, effectiveFrom: new Date(Date.UTC(2020, 0, 1) + (Date.now() % 86_400_000)) },
      })
    ).pricingRuleId;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: faculty.userId } });
    await prisma.shopPricingRule.delete({ where: { pricingRuleId: ruleId } });
    if (createdShop) await prisma.printShop.delete({ where: { shopId: facultyShop.shopId } });
  });

  it('a missing file creates no order AND no queue entry (no phantom token)', async () => {
    const documentId = await fx.uploadDocument(faculty.token);
    await storageService.delete(await storageKeyOf(documentId));
    const queueBefore = await prisma.queue.count({ where: { shopId: facultyShop.shopId } });
    const before = await footprint(faculty.userId);

    const res = await post(faculty.token, body([documentId], facultyShop.shopId));

    expect(res.status).toBe(409);
    expect(await footprint(faculty.userId)).toEqual(before);
    expect(await prisma.queue.count({ where: { shopId: facultyShop.shopId } })).toBe(queueBefore);
  });

  it('an available file still produces a free, immediately queued order', async () => {
    const documentId = await fx.uploadDocument(faculty.token);
    const res = await post(faculty.token, body([documentId], facultyShop.shopId));
    expect(res.status).toBe(201);
    expect(res.body.data.order.orderStatus).toBe('QUEUED');
    expect(res.body.data.order.totalAmount).toBe('0');
  });
});
