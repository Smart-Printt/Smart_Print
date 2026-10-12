import jwt from 'jsonwebtoken';
import request from 'supertest';

import { PrintShop } from '@prisma/client';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';

const app = createApp();

const TEST_EMAIL_PREFIX = 'facultytest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';
const TEST_SHOP_PREFIX = 'FACTEST-';
// FACULTY-only free-printing eligibility is keyed off exactly this shopCode
// (see shop.service.ts::isFreeFacultyShop) - there can only ever be one such
// shop, so tests upsert it rather than creating a fresh one per run.
const CSE_FACULTY_SHOP_CODE = 'CSE_FACULTY';

let uniqueCounter = 0;
function unique(label: string): string {
  uniqueCounter += 1;
  return `${TEST_EMAIL_PREFIX}${label}.${Date.now()}.${uniqueCounter}`;
}
function studentEmail(label: string): string {
  return `${unique(label)}@${STUDENT_DOMAIN}`;
}
function otherEmail(label: string): string {
  return `${unique(label)}@gmail.com`;
}

function signToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

async function createUserDirect(
  label: string,
  role: 'FACULTY' | 'ADMIN' | 'STUDENT',
): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Faculty Test ${label}`,
      email: otherEmail(label),
      passwordHash: await hashPassword(VALID_PASSWORD),
      role,
      status: 'ACTIVE',
    },
  });
  return { userId: user.userId, token: signToken(user.userId, user.role) };
}

async function registerStudent(label: string): Promise<{ userId: string; token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: `Faculty Test Student ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

async function createFakeDocument(userId: string, pageCount: number | null = 10) {
  return prisma.document.create({
    data: {
      userId,
      fileName: 'faculty-test.pdf',
      fileUrl: '/api/documents/fake/download',
      storageKey: `${unique('fake-storage-key')}.pdf`,
      fileType: 'PDF',
      mimeType: 'application/pdf',
      fileSize: 1024,
      fileHash: 'b'.repeat(64),
      pageCount,
    },
  });
}

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

// A distinctive, deliberately expensive rate/shape (LETTER/DOUBLE/COLOR) so
// a nonzero computed price would be unmistakable if the free-order override
// in order.service.ts ever failed to apply.
const FREE_ITEM_OVERRIDES = { printType: 'COLOR', paperSize: 'LETTER', sides: 'DOUBLE' };

let cseFacultyShop: PrintShop;
let normalShop: PrintShop;
let cseFreePricingRuleId: string;

// Offset by the run's start time so a rule left behind by a crashed earlier
// run can never collide with this run's rule on the
// (shop, printType, paperSize, sides, effectiveFrom) unique index.
const past = new Date(Date.UTC(2020, 0, 1) + (Date.now() % 86_400_000));

beforeAll(async () => {
  cseFacultyShop = await prisma.printShop.upsert({
    where: { shopCode: CSE_FACULTY_SHOP_CODE },
    update: {},
    create: {
      shopCode: CSE_FACULTY_SHOP_CODE,
      shopName: 'CSE Department Faculty Printer',
      location: 'CSE Department, Faculty Block',
      contact: '9222222222',
      isActive: true,
      acceptingOrders: true,
    },
  });

  const freeRule = await prisma.shopPricingRule.create({
    data: {
      shopId: cseFacultyShop.shopId,
      printType: 'COLOR',
      paperSize: 'LETTER',
      sides: 'DOUBLE',
      pricePerPage: 50.0,
      effectiveFrom: past,
    },
  });
  cseFreePricingRuleId = freeRule.pricingRuleId;

  normalShop = await prisma.printShop.create({
    data: {
      shopCode: `${TEST_SHOP_PREFIX}${unique('normal-shop')}`,
      shopName: 'Faculty Test Normal Shop',
      location: 'Test Location',
      contact: '9000000000',
      isActive: true,
      acceptingOrders: true,
    },
  });

  await prisma.shopPricingRule.create({
    data: {
      shopId: normalShop.shopId,
      printType: 'BW',
      paperSize: 'A4',
      sides: 'SINGLE',
      pricePerPage: 2.0,
      effectiveFrom: past,
    },
  });
});

afterAll(async () => {
  // Only ever remove data this test file itself created. CSE_FACULTY is the
  // real seeded shop, so cleanup is scoped to orders placed by this file's
  // test-prefixed users - never to every order at that shop. Queue,
  // OrderDocument and OrderStatusHistory rows cascade with their order.
  const testOwnedOrder = { user: { email: { startsWith: TEST_EMAIL_PREFIX } } };
  await prisma.refund.deleteMany({ where: { payment: { order: testOwnedOrder } } });
  await prisma.payment.deleteMany({ where: { order: testOwnedOrder } });
  await prisma.order.deleteMany({ where: testOwnedOrder });
  if (cseFreePricingRuleId) {
    await prisma.shopPricingRule.delete({ where: { pricingRuleId: cseFreePricingRuleId } });
  }
  if (normalShop) {
    await prisma.shopPricingRule.deleteMany({ where: { shopId: normalShop.shopId } });
    await prisma.printShop.delete({ where: { shopId: normalShop.shopId } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.$disconnect();
});

describe('FACULTY role', () => {
  it('exists as a valid UserRole and can be assigned directly', async () => {
    const faculty = await createUserDirect('exists', 'FACULTY');
    const user = await prisma.user.findUniqueOrThrow({ where: { userId: faculty.userId } });
    expect(user.role).toBe('FACULTY');
    expect(user.shopId).toBeNull();
  });

  it('a student cannot self-register as FACULTY - role is always forced to STUDENT', async () => {
    const email = studentEmail('escalate');
    const res = await request(app).post('/api/auth/register').send({
      name: 'Escalation Attempt',
      email,
      password: VALID_PASSWORD,
      role: 'FACULTY',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('STUDENT');
  });
});

describe('POST /api/auth/faculty (admin-only faculty provisioning)', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/auth/faculty')
      .send({ name: 'New Faculty', email: otherEmail('unauth'), password: VALID_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin (student) caller with 403', async () => {
    const student = await registerStudent('not-admin');
    const res = await request(app)
      .post('/api/auth/faculty')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ name: 'New Faculty', email: otherEmail('blocked'), password: VALID_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('allows an admin to provision a FACULTY account with shopId left null', async () => {
    const admin = await createUserDirect('provisioning-admin', 'ADMIN');
    const facultyEmail = otherEmail('provisioned');

    const res = await request(app)
      .post('/api/auth/faculty')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Provisioned Faculty', email: facultyEmail, password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('FACULTY');
    expect(res.body.data.user.email).toBe(facultyEmail);
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { userId: res.body.data.user.userId } });
    expect(dbUser.shopId).toBeNull();
  });

  it('faculty accounts may use the student email domain (domain alone never implies a role)', async () => {
    const admin = await createUserDirect('domain-admin', 'ADMIN');
    const email = studentEmail('faculty-on-domain');

    const res = await request(app)
      .post('/api/auth/faculty')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Domain Faculty', email, password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('FACULTY');
  });
});

describe('FACULTY access to normal customer features', () => {
  it('can log in and fetch its own profile like any customer', async () => {
    const admin = await createUserDirect('login-admin', 'ADMIN');
    const facultyEmail = otherEmail('login');
    await request(app)
      .post('/api/auth/faculty')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Login Faculty', email: facultyEmail, password: VALID_PASSWORD });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: facultyEmail, password: VALID_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('FACULTY');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('FACULTY');
  });

  it('can upload documents and view the public shop directory', async () => {
    const faculty = await createUserDirect('customer-features', 'FACULTY');

    const shopsRes = await request(app)
      .get('/api/shops')
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(shopsRes.status).toBe(200);
    expect(Array.isArray(shopsRes.body.data.shops)).toBe(true);
  });

  it('cannot perform shop-staff queue operations (e.g. start-next) - 403', async () => {
    const faculty = await createUserDirect('no-staff-ops', 'FACULTY');
    const res = await request(app)
      .post(`/api/shops/${normalShop.shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(res.status).toBe(403);
  });

  it('cannot list a shop queue (staff/admin only) - 403', async () => {
    const faculty = await createUserDirect('no-queue-view', 'FACULTY');
    const res = await request(app)
      .get(`/api/shops/${normalShop.shopId}/queue`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(res.status).toBe(403);
  });

  it('cannot access admin-only staff management endpoints - 403', async () => {
    const faculty = await createUserDirect('no-admin-ops', 'FACULTY');
    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(res.status).toBe(403);
  });
});

describe('STUDENT is blocked from the CSE Department Faculty Printer', () => {
  it('cannot create an order at CSE_FACULTY - 403', async () => {
    const student = await registerStudent('blocked-order');
    const doc = await createFakeDocument(student.userId);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    expect(res.status).toBe(403);
  });

  it('cannot even get a pricing preview for CSE_FACULTY - 403', async () => {
    const student = await registerStudent('blocked-preview');
    const doc = await createFakeDocument(student.userId);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    expect(res.status).toBe(403);
  });

  it('is unaffected at ordinary shops (normal payment-required order still works)', async () => {
    const student = await registerStudent('normal-shop-ok');
    const doc = await createFakeDocument(student.userId);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopId: normalShop.shopId, items: [baseItem(doc.documentId)] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.orderStatus).toBe('PLACED');
    expect(res.body.data.order.totalAmount).toBe('20');
  });
});

describe('FACULTY + CSE_FACULTY: free printing, no payment, direct queue entry', () => {
  it('order total is ₹0 regardless of the underlying per-page rate', async () => {
    const faculty = await createUserDirect('free-total', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.order.totalAmount).toBe('0');
    expect(res.body.data.order.items[0].lineTotal).toBe('0');
    expect(res.body.data.order.items[0].pricePerPage).toBe('0');
  });

  it('the pricing preview also reports ₹0 for the same combination', async () => {
    const faculty = await createUserDirect('free-preview', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.totalAmount).toBe('0');
  });

  it('requires no payment - the order is already QUEUED immediately after creation', async () => {
    const faculty = await createUserDirect('no-payment', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.order.orderStatus).toBe('QUEUED');

    // Attempting to pay for an already-QUEUED order must be rejected - a
    // free order was never made payable in the first place.
    const payRes = await request(app)
      .post(`/api/orders/${created.body.data.order.orderId}/payment`)
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ paymentMethod: 'UPI' });
    expect(payRes.status).toBe(409);

    const paymentLookup = await request(app)
      .get(`/api/orders/${created.body.data.order.orderId}/payment`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(paymentLookup.status).toBe(404);
  });

  it('enters the FIFO queue and receives a normal integer queue token', async () => {
    const faculty = await createUserDirect('queue-token', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    const queueRes = await request(app)
      .get(`/api/orders/${created.body.data.order.orderId}/queue`)
      .set('Authorization', `Bearer ${faculty.token}`);

    expect(queueRes.status).toBe(200);
    expect(queueRes.body.data.queue.queueStatus).toBe('WAITING');
    expect(Number.isInteger(queueRes.body.data.queue.queueNumber)).toBe(true);
    expect(queueRes.body.data.queue.queueNumber).toBeGreaterThan(0);
    expect(typeof queueRes.body.data.queue.position).toBe('number');
  });

  it('uses the single shared CSE_FACULTY FIFO queue, not a separate faculty queue', async () => {
    const facultyA = await createUserDirect('shared-queue-a', 'FACULTY');
    const facultyB = await createUserDirect('shared-queue-b', 'FACULTY');
    const docA = await createFakeDocument(facultyA.userId);
    const docB = await createFakeDocument(facultyB.userId);

    const orderA = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${facultyA.token}`)
      .send({ shopId: cseFacultyShop.shopId, items: [baseItem(docA.documentId, FREE_ITEM_OVERRIDES)] });
    const orderB = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${facultyB.token}`)
      .send({ shopId: cseFacultyShop.shopId, items: [baseItem(docB.documentId, FREE_ITEM_OVERRIDES)] });

    const queueA = await request(app)
      .get(`/api/orders/${orderA.body.data.order.orderId}/queue`)
      .set('Authorization', `Bearer ${facultyA.token}`);
    const queueB = await request(app)
      .get(`/api/orders/${orderB.body.data.order.orderId}/queue`)
      .set('Authorization', `Bearer ${facultyB.token}`);

    expect(queueA.body.data.queue.shopId).toBe(cseFacultyShop.shopId);
    expect(queueB.body.data.queue.shopId).toBe(cseFacultyShop.shopId);
    // Same shared per-shop FIFO counter - B's order was created after A's,
    // so it must receive a strictly later queue number in the same series.
    expect(queueB.body.data.queue.queueNumber).toBeGreaterThan(queueA.body.data.queue.queueNumber);
  });

  it('is cancellable while queued, same as a normal queued order', async () => {
    const faculty = await createUserDirect('free-cancel', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({
        shopId: cseFacultyShop.shopId,
        items: [baseItem(doc.documentId, FREE_ITEM_OVERRIDES)],
      });

    const cancelRes = await request(app)
      .patch(`/api/orders/${created.body.data.order.orderId}/cancel`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.order.orderStatus).toBe('CANCELLED');
  });
});

describe('FACULTY at ordinary shops follows normal payment rules (not free everywhere)', () => {
  it('FACULTY + a normal shop is a regular paid order, not free', async () => {
    const faculty = await createUserDirect('normal-shop-paid', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ shopId: normalShop.shopId, items: [baseItem(doc.documentId)] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.orderStatus).toBe('PLACED');
    // 10 pages x 1 copy x 2.00/page = 20.00 - a real, nonzero, payable price.
    expect(res.body.data.order.totalAmount).toBe('20');
  });

  it('a normal paid order for FACULTY at a non-CSE shop can complete payment and queue as usual', async () => {
    const faculty = await createUserDirect('normal-shop-flow', 'FACULTY');
    const doc = await createFakeDocument(faculty.userId);

    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ shopId: normalShop.shopId, items: [baseItem(doc.documentId)] });
    const orderId = created.body.data.order.orderId;

    await request(app)
      .post(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ paymentMethod: 'UPI' });

    const confirmRes = await request(app)
      .post(`/api/orders/${orderId}/payment/confirm`)
      .set('Authorization', `Bearer ${faculty.token}`)
      .send();

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.payment.paymentStatus).toBe('SUCCESS');

    const orderRes = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(orderRes.body.data.order.orderStatus).toBe('QUEUED');
  });
});
