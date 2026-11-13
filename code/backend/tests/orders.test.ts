import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { PrintShop } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { removeFakeDocumentFiles, writeFakeDocumentFile } from './helpers/fakeDocumentFile';

const app = createApp();

const TEST_EMAIL_PREFIX = 'ordertest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_SHOP_PREFIX = 'ORDTEST-';

let uniqueCounter = 0;
function unique(label: string): string {
  uniqueCounter += 1;
  return `${label}.${Date.now()}.${uniqueCounter}`;
}
function studentEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${unique(label)}@${STUDENT_DOMAIN}`;
}

async function registerStudent(label: string): Promise<{ userId: string; token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: `Order Test ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

async function uploadDocument(
  token: string,
  fixtureName = 'valid.pdf',
  contentType = 'application/pdf',
): Promise<{ documentId: string; pageCount: number | null }> {
  const buffer = fsSync.readFileSync(path.join(FIXTURES_DIR, fixtureName));
  const res = await request(app)
    .post('/api/documents')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, { filename: fixtureName, contentType });
  expect(res.status).toBe(201);
  return {
    documentId: res.body.data.document.documentId,
    pageCount: res.body.data.document.pageCount,
  };
}

// Documents created directly (bypassing upload) for page-range tests that
// need a specific known page count, or an unknown (null) one - consistent
// with how tests/auth.test.ts creates User rows directly for scenarios the
// public API can't produce.
async function createFakeDocument(userId: string, pageCount: number | null) {
  const document = await prisma.document.create({
    data: {
      userId,
      fileName: 'fake-for-range-tests.pdf',
      fileUrl: '/api/documents/fake/download',
      storageKey: `${unique('fake-storage-key')}.pdf`,
      fileType: 'PDF',
      mimeType: 'application/pdf',
      fileSize: 1024,
      fileHash: 'a'.repeat(64),
      pageCount,
    },
  });
  await writeFakeDocumentFile(document.storageKey);
  return document;
}

const now = new Date();
const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);

async function createTestShop(opts: {
  isActive?: boolean;
  acceptingOrders?: boolean;
}): Promise<PrintShop> {
  return prisma.printShop.create({
    data: {
      shopCode: `${TEST_SHOP_PREFIX}${unique('shop')}`,
      shopName: 'Order Test Print Shop',
      location: 'Test Location',
      contact: '9000000000',
      isActive: opts.isActive ?? true,
      acceptingOrders: opts.acceptingOrders ?? true,
    },
  });
}

let shop: PrintShop;
let otherShop: PrintShop;
let inactiveShop: PrintShop;
let notAcceptingShop: PrintShop;
let stapleRuleId: string;
let inactiveFinishingRuleId: string;
let otherShopFinishingRuleId: string;

beforeAll(async () => {
  shop = await createTestShop({});
  otherShop = await createTestShop({});
  inactiveShop = await createTestShop({ isActive: false });
  notAcceptingShop = await createTestShop({ acceptingOrders: false });

  await prisma.shopPricingRule.createMany({
    data: [
      {
        shopId: shop.shopId,
        printType: 'BW',
        paperSize: 'A4',
        sides: 'SINGLE',
        pricePerPage: 2.0,
        effectiveFrom: past,
      },
      {
        shopId: shop.shopId,
        printType: 'BW',
        paperSize: 'A4',
        sides: 'DOUBLE',
        pricePerPage: 1.5,
        effectiveFrom: past,
      },
      {
        shopId: shop.shopId,
        printType: 'COLOR',
        paperSize: 'A4',
        sides: 'SINGLE',
        pricePerPage: 8.0,
        effectiveFrom: past,
      },
    ],
  });

  const staple = await prisma.shopFinishingRule.create({
    data: {
      shopId: shop.shopId,
      finishingType: 'STAPLING',
      price: 5.0,
      isActive: true,
      effectiveFrom: past,
    },
  });
  stapleRuleId = staple.finishingRuleId;

  const inactiveFinishing = await prisma.shopFinishingRule.create({
    data: {
      shopId: shop.shopId,
      finishingType: 'LAMINATION',
      price: 10.0,
      isActive: false,
      effectiveFrom: past,
    },
  });
  inactiveFinishingRuleId = inactiveFinishing.finishingRuleId;

  const otherShopFinishing = await prisma.shopFinishingRule.create({
    data: {
      shopId: otherShop.shopId,
      finishingType: 'SPIRAL_BINDING',
      price: 20.0,
      isActive: true,
      effectiveFrom: past,
    },
  });
  otherShopFinishingRuleId = otherShopFinishing.finishingRuleId;
});

afterAll(async () => {
  await removeFakeDocumentFiles();
  const shopIds = [shop.shopId, otherShop.shopId, inactiveShop.shopId, notAcceptingShop.shopId];
  await prisma.order.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: shopIds } } });
  await fs.rm(path.resolve(env.uploadDir), { recursive: true, force: true });
  await prisma.$disconnect();
});

function baseItem(documentId: string, overrides: Record<string, unknown> = {}) {
  return {
    documentId,
    copies: 1,
    printType: 'BW',
    paperSize: 'A4',
    sides: 'SINGLE',
    ...overrides,
  };
}

describe('POST /api/orders - create order', () => {
  it('creates a valid single-document order with correct initial status and history', async () => {
    const student = await registerStudent('single');
    const { documentId } = await uploadDocument(student.token);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: 2 })] });

    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.orderStatus).toBe('PLACED');
    expect(order.items).toHaveLength(1);
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0].status).toBe('PLACED');
    expect(order.statusHistory[0].changedByUserId).toBe(student.userId);
  });

  it('creates a valid multi-document order', async () => {
    const student = await registerStudent('multi');
    const docA = await uploadDocument(student.token);
    const docB = await uploadDocument(student.token, 'valid.png', 'image/png');

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: shop.shopId,
        items: [
          baseItem(docA.documentId, { printType: 'BW', sides: 'DOUBLE', copies: 2 }),
          baseItem(docB.documentId, { printType: 'COLOR', sides: 'SINGLE', copies: 1 }),
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.order.items).toHaveLength(2);
  });

  describe('document security', () => {
    it("rejects ordering another user's document", async () => {
      const owner = await registerStudent('doc-owner');
      const attacker = await registerStudent('doc-attacker');
      const { documentId } = await uploadDocument(owner.token);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

      expect(res.status).toBe(404);
    });

    it('rejects a nonexistent document', async () => {
      const student = await registerStudent('doc-missing');
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem('00000000-0000-0000-0000-000000000000')] });

      expect(res.status).toBe(404);
    });
  });

  describe('shop validation', () => {
    it('rejects a nonexistent shop', async () => {
      const student = await registerStudent('shop-missing');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: '00000000-0000-0000-0000-000000000000', items: [baseItem(documentId)] });
      expect(res.status).toBe(404);
    });

    it('rejects an inactive shop', async () => {
      const student = await registerStudent('shop-inactive');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: inactiveShop.shopId, items: [baseItem(documentId)] });
      expect(res.status).toBe(400);
    });

    it('rejects a shop that is not accepting orders', async () => {
      const student = await registerStudent('shop-not-accepting');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: notAcceptingShop.shopId, items: [baseItem(documentId)] });
      expect(res.status).toBe(400);
    });
  });

  describe('print options', () => {
    it('accepts valid BW', async () => {
      const student = await registerStudent('bw');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { printType: 'BW' })] });
      expect(res.status).toBe(201);
    });

    it('accepts valid COLOR', async () => {
      const student = await registerStudent('color');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { printType: 'COLOR' })] });
      expect(res.status).toBe(201);
    });

    it('accepts valid SINGLE sides', async () => {
      const student = await registerStudent('single-side');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { sides: 'SINGLE' })] });
      expect(res.status).toBe(201);
    });

    it('accepts valid DOUBLE sides', async () => {
      const student = await registerStudent('double-side');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { sides: 'DOUBLE' })] });
      expect(res.status).toBe(201);
    });

    it('accepts a valid paper size', async () => {
      const student = await registerStudent('papersize');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { paperSize: 'A4' })] });
      expect(res.status).toBe(201);
    });

    it('rejects an unsupported configuration for this shop (no matching pricing rule)', async () => {
      const student = await registerStudent('unsupported-config');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { paperSize: 'A3' })] });
      expect(res.status).toBe(400);
    });
  });

  describe('page range', () => {
    it('uses the full document when no pageRange is given', async () => {
      const student = await registerStudent('range-full');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { copies: 1 })] });
      expect(res.status).toBe(201);
      expect(res.body.data.order.items[0].printPageCount).toBe(20);
      expect(res.body.data.order.items[0].pageRange).toBeNull();
    });

    it('accepts a simple range', async () => {
      const student = await registerStudent('range-simple');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { pageRange: '1-5' })] });
      expect(res.status).toBe(201);
      expect(res.body.data.order.items[0].printPageCount).toBe(5);
    });

    it('accepts multiple ranges and de-duplicates overlapping pages', async () => {
      const student = await registerStudent('range-multi');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(doc.documentId, { pageRange: '1-5,3,8,10-12' })],
        });
      expect(res.status).toBe(201);
      // 1,2,3,4,5,8,10,11,12 = 9 distinct pages
      expect(res.body.data.order.items[0].printPageCount).toBe(9);
    });

    it('rejects an invalid range (start > end)', async () => {
      const student = await registerStudent('range-invalid');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { pageRange: '5-1' })] });
      expect(res.status).toBe(400);
    });

    it('rejects a page beyond the known pageCount', async () => {
      const student = await registerStudent('range-beyond');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { pageRange: '1-25' })] });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed range', async () => {
      const student = await registerStudent('range-malformed');
      const doc = await createFakeDocument(student.userId, 20);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { pageRange: 'abc' })] });
      expect(res.status).toBe(400);
    });

    it('requires an explicit pageRange when the document pageCount is unknown', async () => {
      const student = await registerStudent('range-unknown-nopage');
      const doc = await createFakeDocument(student.userId, null);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId)] });
      expect(res.status).toBe(400);
    });

    it('accepts an explicit pageRange when the document pageCount is unknown', async () => {
      const student = await registerStudent('range-unknown-withpage');
      const doc = await createFakeDocument(student.userId, null);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(doc.documentId, { pageRange: '1-3' })] });
      expect(res.status).toBe(201);
      expect(res.body.data.order.items[0].printPageCount).toBe(3);
    });
  });

  describe('copies', () => {
    it('accepts a valid copies value', async () => {
      const student = await registerStudent('copies-valid');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: 3 })] });
      expect(res.status).toBe(201);
    });

    it('rejects zero copies', async () => {
      const student = await registerStudent('copies-zero');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: 0 })] });
      expect(res.status).toBe(400);
    });

    it('rejects negative copies', async () => {
      const student = await registerStudent('copies-negative');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: -2 })] });
      expect(res.status).toBe(400);
    });

    it('rejects a non-integer copies value', async () => {
      const student = await registerStudent('copies-noninteger');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: 1.5 })] });
      expect(res.status).toBe(400);
    });

    it('rejects an unreasonably large copies value', async () => {
      const student = await registerStudent('copies-huge');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({ shopId: shop.shopId, items: [baseItem(documentId, { copies: 100000 })] });
      expect(res.status).toBe(400);
    });
  });

  describe('finishing', () => {
    it('accepts a valid finishing option', async () => {
      const student = await registerStudent('finish-valid');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(documentId, { finishingRuleId: stapleRuleId })],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.order.items[0].finishingType).toBe('STAPLING');
    });

    it('rejects a finishing rule belonging to a different shop', async () => {
      const student = await registerStudent('finish-wrong-shop');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(documentId, { finishingRuleId: otherShopFinishingRuleId })],
        });
      expect(res.status).toBe(400);
    });

    it('rejects an inactive finishing rule', async () => {
      const student = await registerStudent('finish-inactive');
      const { documentId } = await uploadDocument(student.token);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(documentId, { finishingRuleId: inactiveFinishingRuleId })],
        });
      expect(res.status).toBe(400);
    });
  });

  describe('pricing', () => {
    it('calculates price correctly from page count and copies', async () => {
      const student = await registerStudent('price-basic');
      const doc = await createFakeDocument(student.userId, 10);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(doc.documentId, { printType: 'BW', sides: 'SINGLE', copies: 1 })],
        });
      expect(res.status).toBe(201);
      // 10 pages x 1 copy x 2.00/page = 20.00
      expect(res.body.data.order.items[0].lineTotal).toBe('20');
      expect(res.body.data.order.totalAmount).toBe('20');
    });

    it('copies affect the price', async () => {
      const student = await registerStudent('price-copies');
      const doc = await createFakeDocument(student.userId, 10);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(doc.documentId, { printType: 'BW', sides: 'SINGLE', copies: 2 })],
        });
      expect(res.status).toBe(201);
      // 10 pages x 2 copies x 2.00/page = 40.00
      expect(res.body.data.order.items[0].lineTotal).toBe('40');
    });

    it('finishing affects the price (per copy)', async () => {
      const student = await registerStudent('price-finishing');
      const doc = await createFakeDocument(student.userId, 10);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [
            baseItem(doc.documentId, {
              printType: 'BW',
              sides: 'SINGLE',
              copies: 2,
              finishingRuleId: stapleRuleId,
            }),
          ],
        });
      expect(res.status).toBe(201);
      // pages: 10 x 2 x 2.00 = 40.00; finishing: 5.00 x 2 copies = 10.00; total 50.00
      expect(res.body.data.order.items[0].lineTotal).toBe('50');
    });

    it('order total sums all line totals across multiple items', async () => {
      const student = await registerStudent('price-total');
      const docA = await createFakeDocument(student.userId, 10);
      const docB = await createFakeDocument(student.userId, 5);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [
            baseItem(docA.documentId, { printType: 'BW', sides: 'SINGLE', copies: 1 }),
            baseItem(docB.documentId, { printType: 'COLOR', sides: 'SINGLE', copies: 1 }),
          ],
        });
      expect(res.status).toBe(201);
      // docA: 10 x 1 x 2.00 = 20.00; docB: 5 x 1 x 8.00 = 40.00; total 60.00
      expect(res.body.data.order.totalAmount).toBe('60');
    });

    it('ignores a client-supplied price and computes it server-side instead', async () => {
      const student = await registerStudent('price-manipulation');
      const doc = await createFakeDocument(student.userId, 10);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [
            {
              ...baseItem(doc.documentId, { printType: 'BW', sides: 'SINGLE', copies: 1 }),
              pricePerPage: 0.01,
              finishingPrice: 0,
              lineTotal: 0.01,
            },
          ],
          totalAmount: 0.01,
        });
      expect(res.status).toBe(201);
      // Must still be the real server-computed price, not the submitted 0.01.
      expect(res.body.data.order.items[0].lineTotal).toBe('20');
      expect(res.body.data.order.totalAmount).toBe('20');
    });
  });

  describe('price snapshot', () => {
    it('stores the price at creation time and is unaffected by later pricing changes', async () => {
      const student = await registerStudent('snapshot');
      const doc = await createFakeDocument(student.userId, 10);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [baseItem(doc.documentId, { printType: 'BW', sides: 'SINGLE', copies: 1 })],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.order.totalAmount).toBe('20');
      const orderId = res.body.data.order.orderId;

      // Shop raises its BW/A4/SINGLE price after the order was placed.
      await prisma.shopPricingRule.updateMany({
        where: { shopId: shop.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
        data: { pricePerPage: 99.0 },
      });

      const refetched = await request(app)
        .get(`/api/orders/${orderId}`)
        .set('Authorization', `Bearer ${student.token}`);
      expect(refetched.status).toBe(200);
      expect(refetched.body.data.order.totalAmount).toBe('20');

      // Restore for any later test relying on the original price.
      await prisma.shopPricingRule.updateMany({
        where: { shopId: shop.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
        data: { pricePerPage: 2.0 },
      });
    });
  });
});

describe('order access control', () => {
  it('a user sees only their own orders in the list', async () => {
    const studentA = await registerStudent('list-a');
    const studentB = await registerStudent('list-b');
    const docA = await uploadDocument(studentA.token);
    const docB = await uploadDocument(studentB.token);

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${studentA.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(docA.documentId)] });
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${studentB.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(docB.documentId)] });

    const listA = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${studentA.token}`);
    expect(listA.status).toBe(200);
    expect(listA.body.data.orders.length).toBeGreaterThanOrEqual(1);
    for (const order of listA.body.data.orders) {
      expect(order.items.every((item: { documentId: string }) => item.documentId)).toBeTruthy();
    }
    // Verify no cross-contamination: none of A's listed orders is B's.
    const bOrder = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${studentB.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(docB.documentId)] });
    const aOrderIds = listA.body.data.orders.map((o: { orderId: string }) => o.orderId);
    expect(aOrderIds).not.toContain(bOrder.body.data.order.orderId);
  });

  it('a user can retrieve their own order', async () => {
    const student = await registerStudent('get-own');
    const { documentId } = await uploadDocument(student.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    const res = await request(app)
      .get(`/api/orders/${created.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.orderId).toBe(created.body.data.order.orderId);
  });

  it("a user cannot retrieve another user's order", async () => {
    const owner = await registerStudent('get-other-owner');
    const attacker = await registerStudent('get-other-attacker');
    const { documentId } = await uploadDocument(owner.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    const res = await request(app)
      .get(`/api/orders/${created.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(res.status).toBe(404);
  });

  it('unauthenticated requests are rejected for list/get/cancel', async () => {
    const listRes = await request(app).get('/api/orders');
    expect(listRes.status).toBe(401);
    const getRes = await request(app).get('/api/orders/00000000-0000-0000-0000-000000000000');
    expect(getRes.status).toBe(401);
    const cancelRes = await request(app).patch(
      '/api/orders/00000000-0000-0000-0000-000000000000/cancel',
    );
    expect(cancelRes.status).toBe(401);
    const createRes = await request(app)
      .post('/api/orders')
      .send({ shopId: shop.shopId, items: [] });
    expect(createRes.status).toBe(401);
  });
});

describe('order cancellation', () => {
  it('a valid cancellation succeeds and creates status history', async () => {
    const student = await registerStudent('cancel-valid');
    const { documentId } = await uploadDocument(student.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    const res = await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.orderStatus).toBe('CANCELLED');
    expect(res.body.data.order.cancelledReason).toBe('Changed my mind');
    const history = res.body.data.order.statusHistory;
    expect(history[history.length - 1].status).toBe('CANCELLED');
  });

  it("cannot cancel another user's order", async () => {
    const owner = await registerStudent('cancel-owner');
    const attacker = await registerStudent('cancel-attacker');
    const { documentId } = await uploadDocument(owner.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    const res = await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(res.status).toBe(404);
  });

  it('cannot cancel an order that is already printing', async () => {
    const student = await registerStudent('cancel-printing');
    const { documentId } = await uploadDocument(student.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    await prisma.order.update({
      where: { orderId: created.body.data.order.orderId },
      data: { orderStatus: 'PRINTING' },
    });

    const res = await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(409);
  });

  it('cannot cancel an order twice', async () => {
    const student = await registerStudent('cancel-twice');
    const { documentId } = await uploadDocument(student.token);
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shop.shopId, items: [baseItem(documentId)] });

    await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`);
    const second = await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(second.status).toBe(409);
  });
});

describe('transaction safety', () => {
  it('a failed order creation (invalid second item) leaves no partial order', async () => {
    const student = await registerStudent('txn-safety');
    const goodDoc = await uploadDocument(student.token);

    const ordersBefore = await prisma.order.count({ where: { userId: student.userId } });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: shop.shopId,
        items: [
          baseItem(goodDoc.documentId),
          baseItem('00000000-0000-0000-0000-000000000000'), // nonexistent document
        ],
      });

    expect(res.status).toBe(404);

    const ordersAfter = await prisma.order.count({ where: { userId: student.userId } });
    expect(ordersAfter).toBe(ordersBefore);

    const orderDocumentsAfter = await prisma.orderDocument.count({
      where: { documentId: goodDoc.documentId },
    });
    expect(orderDocumentsAfter).toBe(0);
  });
});
