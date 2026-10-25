import jwt from 'jsonwebtoken';
import request from 'supertest';

import { PrintShop } from '@prisma/client';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';
import { removeFakeDocumentFiles, writeFakeDocumentFile } from './helpers/fakeDocumentFile';

const app = createApp();

const TEST_EMAIL_PREFIX = 'orderaccesstest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';

let uniqueCounter = 0;
function unique(label: string): string {
  uniqueCounter += 1;
  return `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${uniqueCounter}`;
}
function studentEmail(label: string): string {
  return `${unique(label)}@${STUDENT_DOMAIN}`;
}

function signToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

async function createStaff(label: string, shopId: string | null): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Order Access Staff ${label}`,
      email: `${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role: 'SHOP_STAFF',
      status: 'ACTIVE',
      shopId,
    },
  });
  return { userId: user.userId, token: signToken(user.userId, 'SHOP_STAFF') };
}

async function createAdmin(label: string): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Order Access Admin ${label}`,
      email: `${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  return { userId: user.userId, token: signToken(user.userId, 'ADMIN') };
}

async function registerStudent(label: string): Promise<{ userId: string; token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: `Order Access Student ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

async function createFakeDocument(userId: string) {
  const document = await prisma.document.create({
    data: {
      userId,
      fileName: 'order-access-test.pdf',
      fileUrl: '/api/documents/fake/download',
      storageKey: `${unique('storage-key')}.pdf`,
      fileType: 'PDF',
      mimeType: 'application/pdf',
      fileSize: 1024,
      fileHash: 'c'.repeat(64),
      pageCount: 5,
    },
  });
  await writeFakeDocumentFile(document.storageKey);
  return document;
}

function baseItem(documentId: string) {
  return { documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' };
}

let shopA: PrintShop;
let shopB: PrintShop;
const past = new Date('2020-01-01T00:00:00.000Z');

beforeAll(async () => {
  shopA = await prisma.printShop.create({
    data: { shopCode: unique('shop-a'), shopName: 'Order Access Shop A', location: 'A', contact: '9000000000' },
  });
  shopB = await prisma.printShop.create({
    data: { shopCode: unique('shop-b'), shopName: 'Order Access Shop B', location: 'B', contact: '9000000000' },
  });
  await prisma.shopPricingRule.createMany({
    data: [
      { shopId: shopA.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 2.0, effectiveFrom: past },
      { shopId: shopB.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 2.0, effectiveFrom: past },
    ],
  });
});

afterAll(async () => {
  await removeFakeDocumentFiles();
  await prisma.order.deleteMany({ where: { shopId: { in: [shopA.shopId, shopB.shopId] } } });
  // Staff users reference these shops via a RESTRICT foreign key - they must
  // be removed before the shops themselves can be deleted.
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: [shopA.shopId, shopB.shopId] } } });
  await prisma.$disconnect();
});

describe('role-scoped order visibility (GET /api/orders, GET /api/orders/:id)', () => {
  it('a student still only ever sees and can fetch their own orders (regression)', async () => {
    const studentA = await registerStudent('list-a');
    const studentB = await registerStudent('list-b');
    const docA = await createFakeDocument(studentA.userId);
    const docB = await createFakeDocument(studentB.userId);

    const orderA = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${studentA.token}`)
      .send({ shopId: shopA.shopId, items: [baseItem(docA.documentId)] });
    const orderB = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${studentB.token}`)
      .send({ shopId: shopA.shopId, items: [baseItem(docB.documentId)] });

    const listA = await request(app).get('/api/orders').set('Authorization', `Bearer ${studentA.token}`);
    const ids = listA.body.data.orders.map((o: { orderId: string }) => o.orderId);
    expect(ids).toContain(orderA.body.data.order.orderId);
    expect(ids).not.toContain(orderB.body.data.order.orderId);

    const getOther = await request(app)
      .get(`/api/orders/${orderB.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${studentA.token}`);
    expect(getOther.status).toBe(404);
  });

  it('ADMIN can list every order across all shops', async () => {
    const admin = await createAdmin('list');
    const student = await registerStudent('for-admin-list');
    const doc = await createFakeDocument(student.userId);
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopB.shopId, items: [baseItem(doc.documentId)] });

    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.orders.map((o: { orderId: string }) => o.orderId);
    expect(ids).toContain(order.body.data.order.orderId);
  });

  it('ADMIN can fetch any single order by id', async () => {
    const admin = await createAdmin('get-one');
    const student = await registerStudent('for-admin-get');
    const doc = await createFakeDocument(student.userId);
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopA.shopId, items: [baseItem(doc.documentId)] });

    const res = await request(app)
      .get(`/api/orders/${order.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.orderId).toBe(order.body.data.order.orderId);
  });

  it('SHOP_STAFF only lists orders belonging to their own assigned shop', async () => {
    const staff = await createStaff('scoped-list', shopA.shopId);
    const student = await registerStudent('scoped-list-student');
    const docInA = await createFakeDocument(student.userId);
    const docInB = await createFakeDocument(student.userId);

    const orderInA = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopA.shopId, items: [baseItem(docInA.documentId)] });
    const orderInB = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopB.shopId, items: [baseItem(docInB.documentId)] });

    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${staff.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.orders.map((o: { orderId: string }) => o.orderId);
    expect(ids).toContain(orderInA.body.data.order.orderId);
    expect(ids).not.toContain(orderInB.body.data.order.orderId);
  });

  it('SHOP_STAFF can fetch an order at their own shop, but not at another shop', async () => {
    const staff = await createStaff('scoped-get', shopA.shopId);
    const student = await registerStudent('scoped-get-student');
    const docInA = await createFakeDocument(student.userId);
    const docInB = await createFakeDocument(student.userId);

    const orderInA = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopA.shopId, items: [baseItem(docInA.documentId)] });
    const orderInB = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: shopB.shopId, items: [baseItem(docInB.documentId)] });

    const ownShopRes = await request(app)
      .get(`/api/orders/${orderInA.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(ownShopRes.status).toBe(200);

    const otherShopRes = await request(app)
      .get(`/api/orders/${orderInB.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(otherShopRes.status).toBe(403);
  });

  it('an unassigned or inactive SHOP_STAFF sees an empty order list, not an error', async () => {
    const staff = await createStaff('unassigned', null);
    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${staff.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
  });
});
