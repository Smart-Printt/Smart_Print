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

const TEST_EMAIL_PREFIX = 'pricingtest.';
const STUDENT_DOMAIN = env.allowedStudentEmailDomain;
const VALID_PASSWORD = 'CorrectHorse123';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_SHOP_PREFIX = 'PRICETEST-';

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
    .send({ name: `Pricing Test ${label}`, email: studentEmail(label), password: VALID_PASSWORD });
  expect(res.status).toBe(201);
  return { userId: res.body.data.user.userId, token: res.body.data.token };
}

function signToken(userId: string, role: 'ADMIN' | 'SHOP_STAFF' | 'STUDENT'): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

async function createUserWithRole(
  label: string,
  role: 'ADMIN' | 'SHOP_STAFF',
): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `Pricing Test ${label}`,
      email: `${TEST_EMAIL_PREFIX}${unique(label)}@gmail.com`,
      passwordHash: await hashPassword(VALID_PASSWORD),
      role,
      status: 'ACTIVE',
    },
  });
  return { userId: user.userId, token: signToken(user.userId, role) };
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

async function createTestShop(opts: {
  isActive?: boolean;
  acceptingOrders?: boolean;
}): Promise<PrintShop> {
  return prisma.printShop.create({
    data: {
      shopCode: `${TEST_SHOP_PREFIX}${unique('shop')}`,
      shopName: 'Pricing Test Print Shop',
      location: 'Test Location',
      contact: '9000000000',
      isActive: opts.isActive ?? true,
      acceptingOrders: opts.acceptingOrders ?? true,
    },
  });
}

const now = new Date();
const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const farPast = new Date(now.getTime() - 48 * 60 * 60 * 1000);
const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);

let admin: { userId: string; token: string };
let staff: { userId: string; token: string };
let student: { userId: string; token: string };
let shopA: PrintShop;
let shopB: PrintShop;
const createdShopIds: string[] = [];

beforeAll(async () => {
  admin = await createUserWithRole('admin', 'ADMIN');
  staff = await createUserWithRole('staff', 'SHOP_STAFF');
  student = await registerStudent('generic');
  shopA = await createTestShop({});
  shopB = await createTestShop({});
  createdShopIds.push(shopA.shopId, shopB.shopId);
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.shopPricingRule.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.shopFinishingRule.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } } });
  await prisma.printShop.deleteMany({ where: { shopId: { in: createdShopIds } } });
  await prisma.$disconnect();
});

function pricingRuleBody(overrides: Record<string, unknown> = {}) {
  return {
    printType: 'BW',
    paperSize: 'A4',
    sides: 'SINGLE',
    pricePerPage: 2.0,
    effectiveFrom: farPast.toISOString(),
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Pricing rule creation
// ───────────────────────────────────────────────────────────────────────

describe('POST /api/shops/:shopId/pricing-rules - create pricing rule', () => {
  it('allows an admin to create a valid pricing rule', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'A3' }));

    expect(res.status).toBe(201);
    expect(res.body.data.pricingRule).toMatchObject({
      shopId: shopA.shopId,
      printType: 'BW',
      paperSize: 'A3',
      sides: 'SINGLE',
      pricePerPage: '2',
      isCurrentlyEffective: true,
    });
  });

  it('creates a future-dated rule that is not yet currently effective', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LEGAL', effectiveFrom: future.toISOString() }));

    expect(res.status).toBe(201);
    expect(res.body.data.pricingRule.isCurrentlyEffective).toBe(false);
  });

  it('rejects a student caller with 403', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${student.token}`)
      .send(pricingRuleBody({ paperSize: 'A5' }));
    expect(res.status).toBe(403);
  });

  it('rejects a SHOP_STAFF caller with 403 (shop-staff linkage intentionally deferred)', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send(pricingRuleBody({ paperSize: 'A5' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .send(pricingRuleBody({ paperSize: 'A5' }));
    expect(res.status).toBe(401);
  });

  it('rejects a negative price', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', pricePerPage: -1 }));
    expect(res.status).toBe(400);
  });

  it('rejects a NaN-like price', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', pricePerPage: 'not-a-number' }));
    expect(res.status).toBe(400);
  });

  it('rejects a price with more than 2 decimal places', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', pricePerPage: 1.999 }));
    expect(res.status).toBe(400);
  });

  it('rejects an unreasonably large price', async () => {
    const res = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', pricePerPage: 999999999 }));
    expect(res.status).toBe(400);
  });

  it('accepts a zero price', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const res = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ pricePerPage: 0 }));
    expect(res.status).toBe(201);
    expect(res.body.data.pricingRule.pricePerPage).toBe('0');
  });

  it('rejects an invalid printType/paperSize/sides', async () => {
    const badPrintType = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', printType: 'SEPIA' }));
    expect(badPrintType.status).toBe(400);

    const badPaperSize = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'HUGE' }));
    expect(badPaperSize.status).toBe(400);

    const badSides = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'LETTER', sides: 'TRIPLE' }));
    expect(badSides.status).toBe(400);
  });

  it('rejects effectiveTo before or equal to effectiveFrom', async () => {
    const before = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          paperSize: 'LETTER',
          effectiveFrom: now.toISOString(),
          effectiveTo: past.toISOString(),
        }),
      );
    expect(before.status).toBe(400);

    const equal = await request(app)
      .post(`/api/shops/${shopA.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          paperSize: 'LETTER',
          effectiveFrom: now.toISOString(),
          effectiveTo: now.toISOString(),
        }),
      );
    expect(equal.status).toBe(400);
  });

  it('returns 404 for a nonexistent shop', async () => {
    const res = await request(app)
      .post('/api/shops/00000000-0000-0000-0000-000000000000/pricing-rules')
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody());
    expect(res.status).toBe(404);
  });

  it('rejects an overlapping pricing rule (same shop/printType/paperSize/sides)', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const first = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z').toISOString(),
          effectiveTo: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        }),
      );
    expect(first.status).toBe(201);

    const overlapping = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          pricePerPage: 1.5,
          effectiveFrom: new Date('2026-03-01T00:00:00.000Z').toISOString(),
          effectiveTo: new Date('2026-12-31T00:00:00.000Z').toISOString(),
        }),
      );
    expect(overlapping.status).toBe(409);

    // Boundary: effectiveTo of the first rule equal to effectiveFrom of a
    // new rule is still an overlap - both are inclusive, so at that exact
    // instant both would be simultaneously effective and ambiguous.
    const touchingBoundary = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          pricePerPage: 1.5,
          effectiveFrom: new Date('2026-06-01T00:00:00.000Z').toISOString(),
          effectiveTo: new Date('2026-12-31T00:00:00.000Z').toISOString(),
        }),
      );
    expect(touchingBoundary.status).toBe(409);
  });

  it('accepts non-overlapping sequential rules with a gap between them', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const first = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z').toISOString(),
          effectiveTo: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        }),
      );
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          pricePerPage: 1.5,
          effectiveFrom: new Date('2026-06-01T00:00:00.001Z').toISOString(),
          effectiveTo: new Date('2026-12-31T00:00:00.000Z').toISOString(),
        }),
      );
    expect(second.status).toBe(201);
  });

  it('accepts a new open-ended rule after an existing rule was deactivated with a matching end date', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const created = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ effectiveFrom: farPast.toISOString() }));
    expect(created.status).toBe(201);

    const deactivated = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${created.body.data.pricingRule.pricingRuleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ effectiveTo: past.toISOString() });
    expect(deactivated.status).toBe(200);

    const replacement = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ pricePerPage: 3.0, effectiveFrom: new Date(past.getTime() + 1).toISOString() }));
    expect(replacement.status).toBe(201);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Pricing rule retrieval
// ───────────────────────────────────────────────────────────────────────

describe('GET /api/shops/:shopId/pricing-rules - list pricing rules', () => {
  it('returns only rules for the requested shop, scoped correctly', async () => {
    const shop1 = await createTestShop({});
    const shop2 = await createTestShop({});
    createdShopIds.push(shop1.shopId, shop2.shopId);

    await request(app)
      .post(`/api/shops/${shop1.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ effectiveFrom: farPast.toISOString() }));
    await request(app)
      .post(`/api/shops/${shop2.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ pricePerPage: 9.0, effectiveFrom: farPast.toISOString() }));

    const res = await request(app)
      .get(`/api/shops/${shop1.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${student.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pricingRules).toHaveLength(1);
    expect(res.body.data.pricingRules[0].shopId).toBe(shop1.shopId);
  });

  it('default (current) view excludes future/expired rules; ?status=all as admin includes them', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ effectiveFrom: farPast.toISOString(), effectiveTo: past.toISOString() }));
    await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'A3', effectiveFrom: future.toISOString() }));

    const currentRes = await request(app)
      .get(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(currentRes.status).toBe(200);
    expect(currentRes.body.data.pricingRules).toHaveLength(0);

    const allAsAdmin = await request(app)
      .get(`/api/shops/${shop.shopId}/pricing-rules?status=all`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(allAsAdmin.status).toBe(200);
    expect(allAsAdmin.body.data.pricingRules).toHaveLength(2);
  });

  it('rejects ?status=all from a non-admin with 403', async () => {
    const res = await request(app)
      .get(`/api/shops/${shopA.shopId}/pricing-rules?status=all`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a nonexistent shop', async () => {
    const res = await request(app)
      .get('/api/shops/00000000-0000-0000-0000-000000000000/pricing-rules')
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Pricing rule deactivation
// ───────────────────────────────────────────────────────────────────────

describe('PATCH /api/shops/:shopId/pricing-rules/:ruleId/deactivate', () => {
  async function createRule(shopId: string) {
    const res = await request(app)
      .post(`/api/shops/${shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ paperSize: 'A5', effectiveFrom: farPast.toISOString() }));
    expect(res.status).toBe(201);
    return res.body.data.pricingRule.pricingRuleId as string;
  }

  it('allows an admin to deactivate a rule', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const ruleId = await createRule(shop.shopId);

    const res = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      // An explicit past date: the default ("now") is still inclusive-effective
      // when the response is built within the same millisecond.
      .send({ effectiveTo: new Date(Date.now() - 1000).toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.data.pricingRule.isCurrentlyEffective).toBe(false);
  });

  it('rejects a student/staff caller with 403', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const ruleId = await createRule(shop.shopId);

    const studentRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({});
    expect(studentRes.status).toBe(403);

    const staffRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({});
    expect(staffRes.status).toBe(403);
  });

  it('returns 409 when deactivating an already-inactive rule', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const ruleId = await createRule(shop.shopId);

    const first = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(second.status).toBe(409);
  });

  it('returns 404 for an unknown rule id or a rule belonging to another shop', async () => {
    const shop1 = await createTestShop({});
    const shop2 = await createTestShop({});
    createdShopIds.push(shop1.shopId, shop2.shopId);
    const ruleId = await createRule(shop1.shopId);

    const unknown = await request(app)
      .patch(`/api/shops/${shop1.shopId}/pricing-rules/00000000-0000-0000-0000-000000000000/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(unknown.status).toBe(404);

    const wrongShop = await request(app)
      .patch(`/api/shops/${shop2.shopId}/pricing-rules/${ruleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(wrongShop.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Finishing rule management
// ───────────────────────────────────────────────────────────────────────

describe('Finishing rule management', () => {
  it('allows an admin to create, list, and update a finishing rule', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const created = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ finishingType: 'STAPLING', price: 5.0, effectiveFrom: farPast.toISOString() });
    expect(created.status).toBe(201);
    expect(created.body.data.finishingRule).toMatchObject({
      shopId: shop.shopId,
      finishingType: 'STAPLING',
      price: '5',
      isActive: true,
      isCurrentlyEffective: true,
    });
    const finishingRuleId = created.body.data.finishingRule.finishingRuleId as string;

    const listRes = await request(app)
      .get(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.finishingRules).toHaveLength(1);

    const updateRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/finishing-rules/${finishingRuleId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ price: 7.5 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.finishingRule.price).toBe('7.5');

    const deactivateRes = await request(app)
      .patch(`/api/shops/${shop.shopId}/finishing-rules/${finishingRuleId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false });
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.data.finishingRule.isCurrentlyEffective).toBe(false);
  });

  it('rejects an invalid finishing price', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const res = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ finishingType: 'STAPLING', price: -5, effectiveFrom: farPast.toISOString() });
    expect(res.status).toBe(400);
  });

  it('rejects a wrong-shop finishing rule update with 404', async () => {
    const shop1 = await createTestShop({});
    const shop2 = await createTestShop({});
    createdShopIds.push(shop1.shopId, shop2.shopId);

    const created = await request(app)
      .post(`/api/shops/${shop1.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ finishingType: 'LAMINATION', price: 10, effectiveFrom: farPast.toISOString() });
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`/api/shops/${shop2.shopId}/finishing-rules/${created.body.data.finishingRule.finishingRuleId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ price: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects an overlapping finishing rule for the same shop/type', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const first = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        finishingType: 'SPIRAL_BINDING',
        price: 20,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      });
    expect(first.status).toBe(201);

    const overlapping = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        finishingType: 'SPIRAL_BINDING',
        price: 25,
        effectiveFrom: new Date('2026-02-01T00:00:00.000Z').toISOString(),
      });
    expect(overlapping.status).toBe(409);
  });

  it('rejects student/staff from creating or updating finishing rules', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const studentCreate = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${student.token}`)
      .send({ finishingType: 'STAPLING', price: 5, effectiveFrom: farPast.toISOString() });
    expect(studentCreate.status).toBe(403);

    const staffCreate = await request(app)
      .post(`/api/shops/${shop.shopId}/finishing-rules`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ finishingType: 'STAPLING', price: 5, effectiveFrom: farPast.toISOString() });
    expect(staffCreate.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Price calculation via preview
// ───────────────────────────────────────────────────────────────────────

describe('POST /api/pricing/preview', () => {
  let previewShop: PrintShop;
  let staplingRuleId: string;

  beforeAll(async () => {
    previewShop = await createTestShop({});
    createdShopIds.push(previewShop.shopId);

    await prisma.shopPricingRule.createMany({
      data: [
        {
          shopId: previewShop.shopId,
          printType: 'BW',
          paperSize: 'A4',
          sides: 'SINGLE',
          pricePerPage: 2.0,
          effectiveFrom: farPast,
        },
        {
          shopId: previewShop.shopId,
          printType: 'COLOR',
          paperSize: 'A4',
          sides: 'SINGLE',
          pricePerPage: 8.0,
          effectiveFrom: farPast,
        },
      ],
    });

    const staple = await prisma.shopFinishingRule.create({
      data: {
        shopId: previewShop.shopId,
        finishingType: 'STAPLING',
        price: 5.0,
        isActive: true,
        effectiveFrom: farPast,
      },
    });
    staplingRuleId = staple.finishingRuleId;
  });

  it('calculates a correct preview for a single document with finishing', async () => {
    const previewStudent = await registerStudent('preview-single');
    const { documentId } = await uploadDocument(previewStudent.token);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send({
        shopId: previewShop.shopId,
        items: [
          {
            documentId,
            copies: 2,
            printType: 'BW',
            paperSize: 'A4',
            sides: 'SINGLE',
            finishingRuleId: staplingRuleId,
          },
        ],
      });

    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    // valid.pdf fixture is a known page count - assert the arithmetic
    // relationship rather than a hardcoded page count.
    const pageCount = item.printPageCount / 2;
    expect(Number(item.printCost)).toBeCloseTo(pageCount * 2 * 2.0, 5);
    expect(Number(item.finishingCost)).toBeCloseTo(5.0 * 2, 5);
    expect(Number(item.lineTotal)).toBeCloseTo(Number(item.printCost) + Number(item.finishingCost), 5);
    expect(Number(res.body.data.totalAmount)).toBeCloseTo(Number(item.lineTotal), 5);
  });

  it('sums multiple documents correctly, including differing print types', async () => {
    const previewStudent = await registerStudent('preview-multi');
    const doc1 = await uploadDocument(previewStudent.token);
    const doc2 = await uploadDocument(previewStudent.token);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send({
        shopId: previewShop.shopId,
        items: [
          { documentId: doc1.documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' },
          { documentId: doc2.documentId, copies: 1, printType: 'COLOR', paperSize: 'A4', sides: 'SINGLE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    const expectedTotal = res.body.data.items.reduce(
      (sum: number, item: { lineTotal: string }) => sum + Number(item.lineTotal),
      0,
    );
    expect(Number(res.body.data.totalAmount)).toBeCloseTo(expectedTotal, 5);
  });

  it('does not create an order', async () => {
    const previewStudent = await registerStudent('preview-no-order');
    const { documentId } = await uploadDocument(previewStudent.token);

    const before = await prisma.order.count({ where: { userId: previewStudent.userId } });

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send({
        shopId: previewShop.shopId,
        items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(res.status).toBe(200);

    const after = await prisma.order.count({ where: { userId: previewStudent.userId } });
    expect(after).toBe(before);
  });

  it('produces the same total as actually creating the equivalent order', async () => {
    const previewStudent = await registerStudent('preview-matches-order');
    const { documentId } = await uploadDocument(previewStudent.token);
    const body = {
      shopId: previewShop.shopId,
      items: [{ documentId, copies: 3, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
    };

    const previewRes = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send(body);
    expect(previewRes.status).toBe(200);

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send(body);
    expect(orderRes.status).toBe(201);

    expect(orderRes.body.data.order.totalAmount).toBe(previewRes.body.data.totalAmount);
  });

  it('rejects a document belonging to another student with 404 (no private-document leakage)', async () => {
    const owner = await registerStudent('preview-owner');
    const intruder = await registerStudent('preview-intruder');
    const { documentId } = await uploadDocument(owner.token);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({
        shopId: previewShop.shopId,
        items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(res.status).toBe(404);
  });

  it('rejects a finishing rule belonging to a different shop', async () => {
    const otherShop = await createTestShop({});
    createdShopIds.push(otherShop.shopId);
    const otherFinishing = await prisma.shopFinishingRule.create({
      data: {
        shopId: otherShop.shopId,
        finishingType: 'LAMINATION',
        price: 15,
        isActive: true,
        effectiveFrom: farPast,
      },
    });

    const previewStudent = await registerStudent('preview-wrong-shop-finishing');
    const { documentId } = await uploadDocument(previewStudent.token);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send({
        shopId: previewShop.shopId,
        items: [
          {
            documentId,
            copies: 1,
            printType: 'BW',
            paperSize: 'A4',
            sides: 'SINGLE',
            finishingRuleId: otherFinishing.finishingRuleId,
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('rejects preview for a shop that is not accepting orders', async () => {
    const inactiveShop = await createTestShop({ acceptingOrders: false });
    createdShopIds.push(inactiveShop.shopId);
    const previewStudent = await registerStudent('preview-inactive-shop');
    const { documentId } = await uploadDocument(previewStudent.token);

    const res = await request(app)
      .post('/api/pricing/preview')
      .set('Authorization', `Bearer ${previewStudent.token}`)
      .send({
        shopId: inactiveShop.shopId,
        items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/pricing/preview')
      .send({ shopId: previewShop.shopId, items: [] });
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Historical price snapshot safety across pricing-rule changes
// ───────────────────────────────────────────────────────────────────────

describe('Historical price snapshot safety', () => {
  it('an existing order keeps its original price after the rule price changes; a new order uses the new price', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    const originalRule = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(pricingRuleBody({ pricePerPage: 1.0, effectiveFrom: farPast.toISOString() }));
    expect(originalRule.status).toBe(201);
    const originalRuleId = originalRule.body.data.pricingRule.pricingRuleId as string;

    const buyer = await registerStudent('snapshot-buyer');
    const { documentId, pageCount } = await uploadDocument(buyer.token);
    const knownPageCount = pageCount ?? 1;

    const firstOrder = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        shopId: shop.shopId,
        items: [
          {
            documentId,
            copies: 2,
            printType: 'BW',
            paperSize: 'A4',
            sides: 'SINGLE',
            ...(pageCount === null ? { pageRange: '1' } : {}),
          },
        ],
      });
    expect(firstOrder.status).toBe(201);
    const originalTotal = Number(firstOrder.body.data.order.totalAmount);
    const expectedPages = pageCount === null ? 1 : knownPageCount;
    expect(originalTotal).toBeCloseTo(expectedPages * 2 * 1.0, 5);

    // Raise the price: deactivate the old rule, create a new one.
    const deactivate = await request(app)
      .patch(`/api/shops/${shop.shopId}/pricing-rules/${originalRuleId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(deactivate.status).toBe(200);
    const closedAt = deactivate.body.data.pricingRule.effectiveTo as string;

    const newRule = await request(app)
      .post(`/api/shops/${shop.shopId}/pricing-rules`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(
        pricingRuleBody({
          pricePerPage: 2.0,
          effectiveFrom: new Date(new Date(closedAt).getTime() + 1).toISOString(),
        }),
      );
    expect(newRule.status).toBe(201);

    // The already-placed order must be unaffected by the price change.
    const refetched = await request(app)
      .get(`/api/orders/${firstOrder.body.data.order.orderId}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(refetched.status).toBe(200);
    expect(Number(refetched.body.data.order.totalAmount)).toBeCloseTo(originalTotal, 5);

    // A new order at the same shop/config uses the NEW price.
    const doc2 = await uploadDocument(buyer.token);
    const secondOrder = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        shopId: shop.shopId,
        items: [
          {
            documentId: doc2.documentId,
            copies: 2,
            printType: 'BW',
            paperSize: 'A4',
            sides: 'SINGLE',
            ...(doc2.pageCount === null ? { pageRange: '1' } : {}),
          },
        ],
      });
    expect(secondOrder.status).toBe(201);
    const expectedPages2 = doc2.pageCount === null ? 1 : doc2.pageCount;
    expect(Number(secondOrder.body.data.order.totalAmount)).toBeCloseTo(expectedPages2 * 2 * 2.0, 5);
  });
});

// ───────────────────────────────────────────────────────────────────────
// DB-level duplicate prevention (shop_pricing_rules / shop_finishing_rules
// unique constraints) - guards against a non-idempotent seed (or any other
// direct insert) silently creating duplicate rows, while still allowing the
// same (shop, config) combination to have multiple rows across different
// effectiveFrom periods, which is the normal repricing-over-time behavior
// already covered by the "accepts non-overlapping sequential rules" test
// and the historical-snapshot test above.
// ───────────────────────────────────────────────────────────────────────

describe('pricing/finishing rule DB-level duplicate prevention', () => {
  it('rejects an exact-duplicate pricing rule row (same shop/config/effectiveFrom) at the database level', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');

    await prisma.shopPricingRule.create({
      data: { shopId: shop.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 2.0, effectiveFrom },
    });

    await expect(
      prisma.shopPricingRule.create({
        data: { shopId: shop.shopId, printType: 'BW', paperSize: 'A4', sides: 'SINGLE', pricePerPage: 2.0, effectiveFrom },
      }),
    ).rejects.toThrow();
  });

  it('still allows two rules for the same shop/config with different effectiveFrom (legitimate repricing)', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);

    await prisma.shopPricingRule.create({
      data: {
        shopId: shop.shopId,
        printType: 'BW',
        paperSize: 'A4',
        sides: 'SINGLE',
        pricePerPage: 2.0,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      },
    });

    await expect(
      prisma.shopPricingRule.create({
        data: {
          shopId: shop.shopId,
          printType: 'BW',
          paperSize: 'A4',
          sides: 'SINGLE',
          pricePerPage: 3.0,
          effectiveFrom: new Date('2026-06-01T00:00:00.001Z'),
        },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects an exact-duplicate finishing rule row (same shop/type/effectiveFrom) at the database level', async () => {
    const shop = await createTestShop({});
    createdShopIds.push(shop.shopId);
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');

    await prisma.shopFinishingRule.create({
      data: { shopId: shop.shopId, finishingType: 'STAPLING', price: 5.0, effectiveFrom },
    });

    await expect(
      prisma.shopFinishingRule.create({
        data: { shopId: shop.shopId, finishingType: 'STAPLING', price: 5.0, effectiveFrom },
      }),
    ).rejects.toThrow();
  });
});
