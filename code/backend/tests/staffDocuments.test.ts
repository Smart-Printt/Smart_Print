import fsSync from 'node:fs';
import path from 'node:path';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'staffdocs.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_SHOP_PREFIX = 'STAFFDOC-';

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
    .send({ name: `Staff Docs ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

function signToken(userId: string, role: 'ADMIN' | 'SHOP_STAFF'): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

async function createUserWithRole(
  label: string,
  role: 'ADMIN' | 'SHOP_STAFF',
  shopId?: string | null,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Staff Docs ${label}`,
      email: `${TEST_EMAIL_PREFIX}${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role,
      status,
      shopId: shopId ?? null,
    },
  });
  return { userId: user.userId, token: signToken(user.userId, role) };
}

async function uploadDocument(token: string): Promise<{ documentId: string }> {
  const buffer = fsSync.readFileSync(path.join(FIXTURES_DIR, 'valid.pdf'));
  const res = await request(app)
    .post('/api/documents')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, { filename: 'valid.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  return { documentId: res.body.data.document.documentId };
}

const createdShopIds: string[] = [];

async function createTestShop(label: string): Promise<PrintShop> {
  const shop = await prisma.printShop.create({
    data: {
      shopCode: `${TEST_SHOP_PREFIX}${unique(label)}`,
      shopName: `Staff Docs Test Print Shop ${label}`,
      location: 'Test Location',
      contact: '9000000000',
      isActive: true,
      acceptingOrders: true,
    },
  });
  createdShopIds.push(shop.shopId);
  await prisma.shopPricingRule.create({
    data: {
      shopId: shop.shopId,
      printType: 'BW',
      paperSize: 'A4',
      sides: 'SINGLE',
      pricePerPage: 2.0,
      effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });
  return shop;
}

async function createOrderWithDocument(
  studentToken: string,
  shop: PrintShop,
): Promise<{ orderId: string; documentId: string }> {
  const { documentId } = await uploadDocument(studentToken);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({
      shopId: shop.shopId,
      items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
    });
  expect(res.status).toBe(201);
  return { orderId: res.body.data.order.orderId, documentId };
}

let admin: { userId: string; token: string };

beforeAll(async () => {
  admin = await createUserWithRole('admin', 'ADMIN');
});

afterAll(async () => {
  await prisma.queue.deleteMany({ where: { order: { shopId: { in: createdShopIds } } } });
  await prisma.orderDocument.deleteMany({ where: { order: { shopId: { in: createdShopIds } } } });
  await prisma.order.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.shopPricingRule.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.document.deleteMany({ where: { user: { email: { startsWith: TEST_EMAIL_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe('secure staff/admin document access', () => {
  it('1. student can access own document', async () => {
    const student = await registerStudent('own-1');
    const { documentId } = await uploadDocument(student.token);

    const res = await request(app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(200);
  });

  it('2. student cannot access another student document', async () => {
    const studentA = await registerStudent('idor-a');
    const studentB = await registerStudent('idor-b');
    const { documentId } = await uploadDocument(studentA.token);

    const res = await request(app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${studentB.token}`);
    expect(res.status).toBe(404);
  });

  describe('cross-shop isolation (G_BLOCK / CSE / COS)', () => {
    let gBlock: PrintShop;
    let cse: PrintShop;
    let cos: PrintShop;
    let gBlockStaff: { userId: string; token: string };
    let cseStaff: { userId: string; token: string };
    let cosStaff: { userId: string; token: string };
    let gBlockOrder: { orderId: string; documentId: string };
    let cseOrder: { orderId: string; documentId: string };
    let cosOrder: { orderId: string; documentId: string };

    beforeAll(async () => {
      gBlock = await createTestShop('g-block');
      cse = await createTestShop('cse-faculty');
      cos = await createTestShop('cos');

      gBlockStaff = await createUserWithRole('g-block-staff', 'SHOP_STAFF', gBlock.shopId);
      cseStaff = await createUserWithRole('cse-staff', 'SHOP_STAFF', cse.shopId);
      cosStaff = await createUserWithRole('cos-staff', 'SHOP_STAFF', cos.shopId);

      const gStudent = await registerStudent('g-student');
      const cseStudent = await registerStudent('cse-student');
      const cosStudent = await registerStudent('cos-student');

      gBlockOrder = await createOrderWithDocument(gStudent.token, gBlock);
      cseOrder = await createOrderWithDocument(cseStudent.token, cse);
      cosOrder = await createOrderWithDocument(cosStudent.token, cos);
    });

    it('3. G_BLOCK staff can access document from G_BLOCK order', async () => {
      const res = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(200);
    });

    it('4. G_BLOCK staff cannot access document from CSE order', async () => {
      const res = await request(app)
        .get(`/api/documents/${cseOrder.documentId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('5. G_BLOCK staff cannot access document from COS order', async () => {
      const res = await request(app)
        .get(`/api/documents/${cosOrder.documentId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('6. CSE staff can access CSE documents', async () => {
      const res = await request(app)
        .get(`/api/documents/${cseOrder.documentId}/download`)
        .set('Authorization', `Bearer ${cseStaff.token}`);
      expect(res.status).toBe(200);
    });

    it('7. CSE staff cannot access G_BLOCK documents', async () => {
      const res = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/download`)
        .set('Authorization', `Bearer ${cseStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('8. COS staff can access COS documents', async () => {
      const res = await request(app)
        .get(`/api/documents/${cosOrder.documentId}/download`)
        .set('Authorization', `Bearer ${cosStaff.token}`);
      expect(res.status).toBe(200);
    });

    it('9. COS staff cannot access G_BLOCK documents', async () => {
      const res = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/download`)
        .set('Authorization', `Bearer ${cosStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('10. inactive staff cannot access documents', async () => {
      const inactiveStaff = await createUserWithRole(
        'g-block-inactive',
        'SHOP_STAFF',
        gBlock.shopId,
        'INACTIVE',
      );
      const res = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/download`)
        .set('Authorization', `Bearer ${inactiveStaff.token}`);
      // authenticate() rejects a deactivated account before any shop check.
      expect(res.status).toBe(401);
    });

    it('11. admin can access documents from all shops', async () => {
      const gRes = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/download`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(gRes.status).toBe(200);

      const cseRes = await request(app)
        .get(`/api/documents/${cseOrder.documentId}/download`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(cseRes.status).toBe(200);

      const cosRes = await request(app)
        .get(`/api/documents/${cosOrder.documentId}/download`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(cosRes.status).toBe(200);
    });

    it('12. random/missing document returns 404 for staff and admin', async () => {
      const missingId = '00000000-0000-0000-0000-000000000000';
      const staffRes = await request(app)
        .get(`/api/documents/${missingId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(staffRes.status).toBe(404);

      const adminRes = await request(app)
        .get(`/api/documents/${missingId}/download`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(adminRes.status).toBe(404);
    });

    it('13. manipulating the document ID cannot bypass authorization', async () => {
      // A G_BLOCK staff member who knows a valid-looking but wrong document
      // id (belonging to another shop) still gets 404, not the file.
      const res = await request(app)
        .get(`/api/documents/${cseOrder.documentId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).not.toMatch(/pdf/);
    });

    it('14. manipulating the order ID cannot expose another shop\'s order/document', async () => {
      const res = await request(app)
        .get(`/api/orders/${cseOrder.orderId}`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(403);
    });

    it("15. a staff member cannot access another shop's document even knowing the exact document ID", async () => {
      const res = await request(app)
        .get(`/api/documents/${cosOrder.documentId}/view`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('staff view endpoint returns the file inline for an authorized document', async () => {
      const res = await request(app)
        .get(`/api/documents/${gBlockOrder.documentId}/view`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/inline/);
    });

    it('staff order detail exposes every document belonging to a multi-document order', async () => {
      const gStudent2 = await registerStudent('g-student-multi');
      const docA = await uploadDocument(gStudent2.token);
      const docB = await uploadDocument(gStudent2.token);
      const docC = await uploadDocument(gStudent2.token);

      const orderRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${gStudent2.token}`)
        .send({
          shopId: gBlock.shopId,
          items: [
            { documentId: docA.documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
            { documentId: docB.documentId, copies: 2, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
            { documentId: docC.documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
          ],
        });
      expect(orderRes.status).toBe(201);
      const orderId = orderRes.body.data.order.orderId;

      const staffRes = await request(app)
        .get(`/api/orders/${orderId}`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(staffRes.status).toBe(200);
      expect(staffRes.body.data.order.items).toHaveLength(3);

      const documentIds = staffRes.body.data.order.items.map((item: { documentId: string }) => item.documentId);
      for (const documentId of documentIds) {
        const downloadRes = await request(app)
          .get(`/api/documents/${documentId}/download`)
          .set('Authorization', `Bearer ${gBlockStaff.token}`);
        expect(downloadRes.status).toBe(200);
      }
    });

    it('a document never ordered at any shop remains inaccessible to any staff member', async () => {
      const lonelyStudent = await registerStudent('unordered');
      const { documentId } = await uploadDocument(lonelyStudent.token);

      const res = await request(app)
        .get(`/api/documents/${documentId}/download`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(404);
    });

    it('response never leaks storageKey or filesystem paths to staff', async () => {
      const res = await request(app)
        .get(`/api/orders/${gBlockOrder.orderId}`)
        .set('Authorization', `Bearer ${gBlockStaff.token}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/storageKey/i);
      expect(JSON.stringify(res.body)).not.toContain(path.resolve(env.uploadDir));
    });
  });
});
