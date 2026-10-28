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

const TEST_EMAIL_PREFIX = 'shopstafftest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_SHOP_PREFIX = 'STAFFTEST-';

let uniqueCounter = 0;
function unique(label: string): string {
  uniqueCounter += 1;
  return `${label}.${Date.now()}.${uniqueCounter}`;
}
function studentEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${unique(label)}@${STUDENT_DOMAIN}`;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerStudent(label: string): Promise<{ userId: string; token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: `Staff Test ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
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
): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Staff Test ${label}`,
      email: `${TEST_EMAIL_PREFIX}${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role,
      status: 'ACTIVE',
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

async function createTestShop(
  label: string,
  opts: { isActive?: boolean } = {},
): Promise<PrintShop> {
  const shop = await prisma.printShop.create({
    data: {
      shopCode: `${TEST_SHOP_PREFIX}${unique(label)}`,
      shopName: `Staff Test Print Shop ${label}`,
      location: 'Test Location',
      contact: '9000000000',
      isActive: opts.isActive ?? true,
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

let admin: { userId: string; token: string };

beforeAll(async () => {
  admin = await createUserWithRole('admin', 'ADMIN');
});

afterAll(async () => {
  await prisma.queue.deleteMany({ where: { order: { shopId: { in: createdShopIds } } } });
  await prisma.refund.deleteMany({ where: { payment: { order: { shopId: { in: createdShopIds } } } } });
  await prisma.payment.deleteMany({ where: { order: { shopId: { in: createdShopIds } } } });
  await prisma.order.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.shopPricingRule.deleteMany({ where: { shopId: { in: createdShopIds } } });
  // User rows referencing a test shop must go before the shops themselves
  // (User.shopId -> PrintShop is RESTRICT, not CASCADE).
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.$disconnect();
});

async function createOrder(
  token: string,
  shop: PrintShop,
): Promise<{ orderId: string; totalAmount: string }> {
  const { documentId } = await uploadDocument(token);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      shopId: shop.shopId,
      items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
    });
  expect(res.status).toBe(201);
  return { orderId: res.body.data.order.orderId, totalAmount: res.body.data.order.totalAmount };
}

async function createQueuedOrder(
  token: string,
  shop: PrintShop,
): Promise<{ orderId: string }> {
  const { orderId } = await createOrder(token, shop);
  await request(app)
    .post(`/api/orders/${orderId}/payment`)
    .set('Authorization', `Bearer ${token}`)
    .send({ paymentMethod: 'UPI' });
  const confirmRes = await request(app)
    .post(`/api/orders/${orderId}/payment/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  expect(confirmRes.status).toBe(200);
  return { orderId };
}

// ───────────────────────────────────────────────────────────────────────
// Database / relationship
// ───────────────────────────────────────────────────────────────────────

describe('User <-> PrintShop relationship', () => {
  it('a SHOP_STAFF user can be assigned a shopId', async () => {
    const shop = await createTestShop('db-staff');
    const staff = await prisma.user.create({
      data: {
        name: 'DB Test Staff',
        email: `${TEST_EMAIL_PREFIX}${unique('db-staff')}@gmail.com`,
        passwordHash: await hashPassword(VALID_PASSWORD),
        role: 'SHOP_STAFF',
        status: 'ACTIVE',
        shopId: shop.shopId,
      },
    });
    expect(staff.shopId).toBe(shop.shopId);
  });

  it('a STUDENT registered via the public API keeps shopId null', async () => {
    const student = await registerStudent('db-student');
    const row = await prisma.user.findUnique({ where: { userId: student.userId } });
    expect(row?.shopId).toBeNull();
  });

  it('an ADMIN user keeps shopId null', async () => {
    const row = await prisma.user.findUnique({ where: { userId: admin.userId } });
    expect(row?.shopId).toBeNull();
  });

  it('the foreign key rejects a shopId that does not reference a real shop', async () => {
    await expect(
      prisma.user.create({
        data: {
          name: 'Bad FK Staff',
          email: `${TEST_EMAIL_PREFIX}${unique('bad-fk')}@gmail.com`,
          passwordHash: await hashPassword(VALID_PASSWORD),
          role: 'SHOP_STAFF',
          status: 'ACTIVE',
          shopId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    ).rejects.toThrow();
  });

  it('the CHECK constraint rejects a shopId on a non-SHOP_STAFF row', async () => {
    const shop = await createTestShop('db-check');
    await expect(
      prisma.user.create({
        data: {
          name: 'Bad Role Assignment',
          email: `${TEST_EMAIL_PREFIX}${unique('bad-role')}@gmail.com`,
          passwordHash: await hashPassword(VALID_PASSWORD),
          role: 'STUDENT',
          status: 'ACTIVE',
          shopId: shop.shopId,
        },
      }),
    ).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Staff creation
// ───────────────────────────────────────────────────────────────────────

describe('POST /api/admin/staff - staff creation', () => {
  it('allows an admin to create staff assigned to an active shop', async () => {
    const shop = await createTestShop('create-basic');
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'G Block Staff',
        email: `${TEST_EMAIL_PREFIX}${unique('create-basic')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: shop.shopId,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.staff.role).toBe('SHOP_STAFF');
    expect(res.body.data.staff.shop).toMatchObject({ shopId: shop.shopId });
    expect(res.body.data.staff).not.toHaveProperty('passwordHash');
    expect(res.body.data.staff).not.toHaveProperty('password');
  });

  it('always forces role=SHOP_STAFF, ignoring any client-supplied role', async () => {
    const shop = await createTestShop('create-force-role');
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Sneaky',
        email: `${TEST_EMAIL_PREFIX}${unique('force-role')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: shop.shopId,
        role: 'ADMIN',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.staff.role).toBe('SHOP_STAFF');
  });

  it('hashes the password and never returns it', async () => {
    const shop = await createTestShop('create-hash');
    const password = 'StrongPassword123!';
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Hash Check',
        email: `${TEST_EMAIL_PREFIX}${unique('create-hash')}@gmail.com`,
        password,
        shopId: shop.shopId,
      });
    expect(res.status).toBe(201);

    const row = await prisma.user.findUnique({ where: { userId: res.body.data.staff.userId } });
    expect(row?.passwordHash).not.toBe(password);
    expect(row?.passwordHash.length).toBeGreaterThan(20);
    expect(JSON.stringify(res.body)).not.toContain(row?.passwordHash);
  });

  it('rejects a non-admin caller', async () => {
    const shop = await createTestShop('create-forbidden');
    const student = await registerStudent('create-forbidden');
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        name: 'Blocked',
        email: `${TEST_EMAIL_PREFIX}${unique('blocked')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: shop.shopId,
      });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    const shop = await createTestShop('create-unauth');
    const res = await request(app).post('/api/admin/staff').send({
      name: 'Blocked',
      email: `${TEST_EMAIL_PREFIX}${unique('unauth')}@gmail.com`,
      password: 'StrongPassword123!',
      shopId: shop.shopId,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a nonexistent shop', async () => {
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'No Shop',
        email: `${TEST_EMAIL_PREFIX}${unique('no-shop')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(404);
  });

  it('rejects an inactive shop', async () => {
    const inactiveShop = await createTestShop('create-inactive', { isActive: false });
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Inactive Shop Staff',
        email: `${TEST_EMAIL_PREFIX}${unique('inactive-shop')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: inactiveShop.shopId,
      });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    const shop = await createTestShop('create-dup');
    const email = `${TEST_EMAIL_PREFIX}${unique('dup')}@gmail.com`;
    const first = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'First', email, password: 'StrongPassword123!', shopId: shop.shopId });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Second', email, password: 'StrongPassword123!', shopId: shop.shopId });
    expect(second.status).toBe(409);
  });

  it('rejects a missing shopId', async () => {
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'No Shop Id',
        email: `${TEST_EMAIL_PREFIX}${unique('missing-shop')}@gmail.com`,
        password: 'StrongPassword123!',
      });
    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Staff listing
// ───────────────────────────────────────────────────────────────────────

describe('GET /api/admin/staff - staff listing', () => {
  it('allows an admin to list staff with safe shop info and no password hashes', async () => {
    const shop = await createTestShop('list-basic');
    const created = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Listed Staff',
        email: `${TEST_EMAIL_PREFIX}${unique('list-basic')}@gmail.com`,
        password: 'StrongPassword123!',
        shopId: shop.shopId,
      });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.staff)).toBe(true);
    const entry = (res.body.data.staff as { userId: string }[]).find(
      (s) => s.userId === created.body.data.staff.userId,
    );
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects a non-admin caller', async () => {
    const student = await registerStudent('list-forbidden');
    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Staff update
// ───────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff/:id - staff update', () => {
  async function createStaffViaApi(label: string, shopId: string) {
    const res = await request(app)
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: `Update Test ${label}`,
        email: `${TEST_EMAIL_PREFIX}${unique(label)}@gmail.com`,
        password: 'StrongPassword123!',
        shopId,
      });
    expect(res.status).toBe(201);
    return res.body.data.staff as { userId: string };
  }

  it('allows an admin to reassign staff to a different active shop', async () => {
    const shopOne = await createTestShop('update-reassign-1');
    const shopTwo = await createTestShop('update-reassign-2');
    const staff = await createStaffViaApi('reassign', shopOne.shopId);

    const res = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ shopId: shopTwo.shopId });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.shop.shopId).toBe(shopTwo.shopId);
  });

  it('allows an admin to deactivate staff', async () => {
    const shop = await createTestShop('update-deactivate');
    const staff = await createStaffViaApi('deactivate', shop.shopId);

    const res = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.status).toBe('INACTIVE');
  });

  it('rejects reassignment to an inactive shop', async () => {
    const shop = await createTestShop('update-bad-shop');
    const inactiveShop = await createTestShop('update-inactive-target', { isActive: false });
    const staff = await createStaffViaApi('bad-shop', shop.shopId);

    const res = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ shopId: inactiveShop.shopId });
    expect(res.status).toBe(400);
  });

  it('rejects a non-admin caller', async () => {
    const shop = await createTestShop('update-forbidden');
    const staff = await createStaffViaApi('forbidden', shop.shopId);
    const student = await registerStudent('update-forbidden');

    const res = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(403);
  });

  it('ignores an attempted role change (role is not a supported field)', async () => {
    const shop = await createTestShop('update-role');
    const staff = await createStaffViaApi('role-change', shop.shopId);

    const res = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'ADMIN', name: 'Still Staff' });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.role).toBe('SHOP_STAFF');
  });

  it('returns 404 for a nonexistent staff id or a non-staff user id', async () => {
    const unknown = await request(app)
      .patch('/api/admin/staff/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'INACTIVE' });
    expect(unknown.status).toBe(404);

    const student = await registerStudent('update-not-staff');
    const wrongType = await request(app)
      .patch(`/api/admin/staff/${student.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'INACTIVE' });
    expect(wrongType.status).toBe(404);
  });

  it('an inactive staff member cannot operate their assigned shop queue', async () => {
    const shop = await createTestShop('update-inactive-ops');
    const staff = await createStaffViaApi('inactive-ops', shop.shopId);
    const staffToken = signToken(staff.userId, 'SHOP_STAFF');

    const deactivate = await request(app)
      .patch(`/api/admin/staff/${staff.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'INACTIVE' });
    expect(deactivate.status).toBe(200);

    const res = await request(app)
      .get(`/api/shops/${shop.shopId}/queue`)
      .set('Authorization', `Bearer ${staffToken}`);
    // authenticate() rejects a deactivated account before any shop check.
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Shop management
// ───────────────────────────────────────────────────────────────────────

describe('shop management', () => {
  it('allows an admin to create a shop', async () => {
    const res = await request(app)
      .post('/api/shops')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        shopCode: `${TEST_SHOP_PREFIX}${unique('mgmt-create')}`,
        shopName: 'Management Test Shop',
        location: 'Somewhere',
        contact: '9999999999',
      });
    expect(res.status).toBe(201);
    createdShopIds.push(res.body.data.shop.shopId);
    expect(res.body.data.shop.isActive).toBe(true);
    expect(res.body.data.shop.acceptingOrders).toBe(true);
  });

  it('rejects a duplicate shopCode', async () => {
    const shopCode = `${TEST_SHOP_PREFIX}${unique('mgmt-dup')}`;
    const first = await request(app)
      .post('/api/shops')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ shopCode, shopName: 'First', location: 'A', contact: '1111111111' });
    expect(first.status).toBe(201);
    createdShopIds.push(first.body.data.shop.shopId);

    const second = await request(app)
      .post('/api/shops')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ shopCode, shopName: 'Second', location: 'B', contact: '2222222222' });
    expect(second.status).toBe(409);
  });

  it('allows an admin to update a shop', async () => {
    const shop = await createTestShop('mgmt-update');
    const res = await request(app)
      .patch(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ shopName: 'Renamed Shop', acceptingOrders: false });
    expect(res.status).toBe(200);
    expect(res.body.data.shop.shopName).toBe('Renamed Shop');
    expect(res.body.data.shop.acceptingOrders).toBe(false);
  });

  it('rejects shop creation/update from a non-admin', async () => {
    const student = await registerStudent('mgmt-forbidden');
    const createRes = await request(app)
      .post('/api/shops')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopCode: `${TEST_SHOP_PREFIX}${unique('mgmt-forbidden')}`,
        shopName: 'Nope',
        location: 'Nowhere',
        contact: '0000000000',
      });
    expect(createRes.status).toBe(403);

    const shop = await createTestShop('mgmt-update-forbidden');
    const updateRes = await request(app)
      .patch(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ shopName: 'Nope' });
    expect(updateRes.status).toBe(403);
  });

  it('allows any authenticated user to read the shop list and a single shop', async () => {
    const shop = await createTestShop('mgmt-read');
    const student = await registerStudent('mgmt-read');

    const listRes = await request(app)
      .get('/api/shops')
      .set('Authorization', `Bearer ${student.token}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data.shops)).toBe(true);

    const oneRes = await request(app)
      .get(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(oneRes.status).toBe(200);
    expect(oneRes.body.data.shop.shopId).toBe(shop.shopId);
  });

  it('an inactive shop cannot accept new orders', async () => {
    const shop = await createTestShop('mgmt-inactive-orders');
    const deactivate = await request(app)
      .patch(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false });
    expect(deactivate.status).toBe(200);

    const student = await registerStudent('mgmt-inactive-orders');
    const { documentId } = await uploadDocument(student.token);
    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: shop.shopId,
        items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(orderRes.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Shop-scoped staff authorization
// ───────────────────────────────────────────────────────────────────────

describe('shop-scoped staff authorization', () => {
  it('staff can operate their own assigned shop but not a different one, while admin can operate any', async () => {
    const shopG = await createTestShop('authz-g');
    const shopC = await createTestShop('authz-c');
    const staffG = await createUserWithRole('authz-staff-g', 'SHOP_STAFF', shopG.shopId);

    const okOwn = await request(app)
      .get(`/api/shops/${shopG.shopId}/queue`)
      .set('Authorization', `Bearer ${staffG.token}`);
    expect(okOwn.status).toBe(200);

    const forbiddenOther = await request(app)
      .get(`/api/shops/${shopC.shopId}/queue`)
      .set('Authorization', `Bearer ${staffG.token}`);
    expect(forbiddenOther.status).toBe(403);

    const adminOwn = await request(app)
      .get(`/api/shops/${shopG.shopId}/queue`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminOwn.status).toBe(200);
    const adminOther = await request(app)
      .get(`/api/shops/${shopC.shopId}/queue`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminOther.status).toBe(200);
  });

  it('a student can no longer read a shop operational queue directly', async () => {
    const shop = await createTestShop('authz-student-blocked');
    const student = await registerStudent('authz-student-blocked');

    const res = await request(app)
      .get(`/api/shops/${shop.shopId}/queue`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(403);
  });

  it('an unassigned SHOP_STAFF (no shopId) is rejected from any shop', async () => {
    const shop = await createTestShop('authz-unassigned');
    const unassignedStaff = await createUserWithRole('authz-unassigned-staff', 'SHOP_STAFF', null);

    const res = await request(app)
      .get(`/api/shops/${shop.shopId}/queue`)
      .set('Authorization', `Bearer ${unassignedStaff.token}`);
    expect(res.status).toBe(403);
  });

  it('staff remain forbidden from refund processing and admin staff management', async () => {
    const shop = await createTestShop('authz-staff-limits');
    const staff = await createUserWithRole('authz-staff-limits-staff', 'SHOP_STAFF', shop.shopId);

    const refundRes = await request(app)
      .patch('/api/orders/00000000-0000-0000-0000-000000000000/refund/process')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(refundRes.status).toBe(403);

    const staffMgmtRes = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${staff.token}`);
    expect(staffMgmtRes.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Shop-scoped staff pricing management
// ───────────────────────────────────────────────────────────────────────

describe('shop-scoped staff pricing management', () => {
  it('allows staff to create and deactivate pricing rules for their own shop', async () => {
    const shop = await createTestShop('pricing-staff-own');
    const staff = await createUserWithRole('pricing-staff-own-staff', 'SHOP_STAFF', shop.shopId);

    const createRes = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ printType: 'COLOR', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 9 });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.data.pricingRule.pricingRuleId;

    const deactivateRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.data.pricingRule.isCurrentlyEffective).toBe(false);
  });

  it('allows staff to create and update finishing rules for their own shop', async () => {
    const shop = await createTestShop('finishing-staff-own');
    const staff = await createUserWithRole('finishing-staff-own-staff', 'SHOP_STAFF', shop.shopId);

    const createRes = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ finishingType: 'STAPLING', price: 5 });
    expect(createRes.status).toBe(201);
    const ruleId = createRes.body.data.finishingRule.finishingRuleId;

    const updateRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/finishing-rules/${ruleId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ isActive: false });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.finishingRule.isActive).toBe(false);
  });

  it("rejects staff from creating, deactivating, or listing another shop's pricing/finishing rules", async () => {
    const ownShop = await createTestShop('pricing-staff-cross-own');
    const otherShop = await createTestShop('pricing-staff-cross-other');
    const staff = await createUserWithRole('pricing-staff-cross-staff', 'SHOP_STAFF', ownShop.shopId);

    const createRes = await request(app)
      .post(`/api/shops/${otherShop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ printType: 'COLOR', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 9 });
    expect(createRes.status).toBe(403);

    const finishingCreateRes = await request(app)
      .post(`/api/shops/${otherShop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ finishingType: 'STAPLING', price: 5 });
    expect(finishingCreateRes.status).toBe(403);

    // Attempting to deactivate an existing rule belonging to the other shop.
    const otherShopRule = await prisma.shopPricingRule.findFirstOrThrow({
      where: { shopId: otherShop.shopId },
    });
    const deactivateRes = await request(app)
      .patch(`/api/shops/${otherShop.shopId}/pricing-rules/${otherShopRule.pricingRuleId}/deactivate`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(deactivateRes.status).toBe(403);

    // The administrative "all rules" (?status=all) view is also shop-scoped.
    const listAllRes = await request(app)
      .get(`/api/shops/${otherShop.shopId}/pricing-rules?status=all`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(listAllRes.status).toBe(403);
  });

  it('an inactive staff member loses pricing management access to their own shop', async () => {
    const shop = await createTestShop('pricing-inactive-staff');
    const staff = await createUserWithRole('pricing-inactive-staff-staff', 'SHOP_STAFF', shop.shopId);
    await prisma.user.update({ where: { userId: staff.userId }, data: { status: 'INACTIVE' } });

    const createRes = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ printType: 'COLOR', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 9 });
    // authenticate() rejects a deactivated account before any shop check.
    expect(createRes.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Shop-scoped staff operational status (acceptingOrders)
// ───────────────────────────────────────────────────────────────────────

describe('shop-scoped staff operational status', () => {
  it("allows staff to toggle their own shop's acceptingOrders but not other fields", async () => {
    const shop = await createTestShop('status-staff-own');
    const staff = await createUserWithRole('status-staff-own-staff', 'SHOP_STAFF', shop.shopId);

    const toggleRes = await request(app)
      .patch(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ acceptingOrders: false });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.data.shop.acceptingOrders).toBe(false);

    const nameRes = await request(app)
      .patch(`/api/shops/${shop.shopId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ shopName: 'Renamed by staff' });
    expect(nameRes.status).toBe(403);
  });

  it("rejects staff from toggling another shop's acceptingOrders", async () => {
    const ownShop = await createTestShop('status-staff-cross-own');
    const otherShop = await createTestShop('status-staff-cross-other');
    const staff = await createUserWithRole('status-staff-cross-staff', 'SHOP_STAFF', ownShop.shopId);

    const res = await request(app)
      .patch(`/api/shops/${otherShop.shopId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ acceptingOrders: false });
    expect(res.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Shop-scoped staff visibility into payments and refunds
// ───────────────────────────────────────────────────────────────────────

describe('shop-scoped staff payment and refund visibility', () => {
  it('allows staff to view (but not process) a payment/refund for an order in their own shop', async () => {
    const shop = await createTestShop('payrefund-staff-own');
    const staff = await createUserWithRole('payrefund-staff-own-staff', 'SHOP_STAFF', shop.shopId);
    const student = await registerStudent('payrefund-staff-own');
    const { orderId } = await createQueuedOrder(student.token, shop);

    const paymentRes = await request(app)
      .get(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(paymentRes.status).toBe(200);
    expect(paymentRes.body.data.payment.paymentStatus).toBe('SUCCESS');

    const cancelRes = await request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({});
    expect(cancelRes.status).toBe(200);

    const refundRequestRes = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ reason: 'Changed my mind' });
    expect(refundRequestRes.status).toBe(201);

    const refundViewRes = await request(app)
      .get(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(refundViewRes.status).toBe(200);
    expect(refundViewRes.body.data.refund.refundStatus).toBe('REQUESTED');

    const processRes = await request(app)
      .patch(`/api/orders/${orderId}/refund/process`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(processRes.status).toBe(403);
  });

  it("rejects staff from viewing another shop's payment or refund", async () => {
    const ownShop = await createTestShop('payrefund-staff-cross-own');
    const otherShop = await createTestShop('payrefund-staff-cross-other');
    const staff = await createUserWithRole('payrefund-staff-cross-staff', 'SHOP_STAFF', ownShop.shopId);
    const student = await registerStudent('payrefund-staff-cross');
    const { orderId } = await createQueuedOrder(student.token, otherShop);

    const paymentRes = await request(app)
      .get(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(paymentRes.status).toBe(403);

    const cancelRes = await request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({});
    expect(cancelRes.status).toBe(200);
    const refundRequestRes = await request(app)
      .post(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ reason: 'Changed my mind' });
    expect(refundRequestRes.status).toBe(201);

    const refundViewRes = await request(app)
      .get(`/api/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${staff.token}`);
    expect(refundViewRes.status).toBe(403);
  });

  it('allows admin to view payment/refund for any shop', async () => {
    const shop = await createTestShop('payrefund-admin');
    const student = await registerStudent('payrefund-admin');
    const { orderId } = await createQueuedOrder(student.token, shop);

    const paymentRes = await request(app)
      .get(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(paymentRes.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Queue operations as shop staff
// ───────────────────────────────────────────────────────────────────────

describe('queue operations performed by assigned staff', () => {
  it('assigned staff can start-next and complete, preserving FIFO order', async () => {
    const shop = await createTestShop('queue-staff-fifo');
    const staff = await createUserWithRole('queue-staff-fifo-staff', 'SHOP_STAFF', shop.shopId);

    const studentA = await registerStudent('queue-staff-a');
    const studentB = await registerStudent('queue-staff-b');
    const a = await createQueuedOrder(studentA.token, shop);
    await sleep(15);
    const b = await createQueuedOrder(studentB.token, shop);

    const startRes = await request(app)
      .post(`/api/shops/${shop.shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(startRes.status).toBe(200);
    expect(startRes.body.data.queue.orderId).toBe(a.orderId);

    const completeRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/queue/${startRes.body.data.queue.queueId}/complete`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.data.queue.queueStatus).toBe('COMPLETED');

    const collectRes = await request(app)
      .patch(`/api/orders/${a.orderId}/collect`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(collectRes.status).toBe(200);

    const startNextB = await request(app)
      .post(`/api/shops/${shop.shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(startNextB.status).toBe(200);
    expect(startNextB.body.data.queue.orderId).toBe(b.orderId);
  });

  it("rejects staff from a different shop starting or completing this shop's queue", async () => {
    const shop = await createTestShop('queue-wrong-shop');
    const otherShop = await createTestShop('queue-wrong-shop-other');
    const wrongStaff = await createUserWithRole('queue-wrong-shop-staff', 'SHOP_STAFF', otherShop.shopId);
    const student = await registerStudent('queue-wrong-shop');
    await createQueuedOrder(student.token, shop);

    const startRes = await request(app)
      .post(`/api/shops/${shop.shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${wrongStaff.token}`)
      .send({});
    expect(startRes.status).toBe(403);
  });

  it('rejects a student from starting or completing any shop queue', async () => {
    const shop = await createTestShop('queue-student-blocked');
    const student = await registerStudent('queue-student-blocked');
    await createQueuedOrder(student.token, shop);

    const startRes = await request(app)
      .post(`/api/shops/${shop.shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({});
    expect(startRes.status).toBe(403);
  });

  it('concurrent start-next calls from the assigned staff member remain race-safe', async () => {
    const shop = await createTestShop('queue-staff-concurrency');
    const staff = await createUserWithRole(
      'queue-staff-concurrency-staff',
      'SHOP_STAFF',
      shop.shopId,
    );
    const studentA = await registerStudent('queue-conc-a');
    const studentB = await registerStudent('queue-conc-b');
    await createQueuedOrder(studentA.token, shop);
    await createQueuedOrder(studentB.token, shop);

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/shops/${shop.shopId}/queue/start-next`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({}),
      request(app)
        .post(`/api/shops/${shop.shopId}/queue/start-next`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({}),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const printingCount = await prisma.queue.count({
      where: { queueStatus: 'PRINTING', order: { shopId: shop.shopId } },
    });
    expect(printingCount).toBe(1);
  });
});
