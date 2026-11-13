import jwt from 'jsonwebtoken';
import request from 'supertest';

import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/utils/password';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// The staff "Mark as Collected" button only calls PATCH /api/orders/:id/collect;
// the server decides. These tests pin the rules the button relies on that the
// existing queue/race suites do not: another shop's staff, and the exact
// message a duplicate collection returns.

jest.setTimeout(60_000);

const fx = createRaceFixtures('collectperm.');

let admin: TestUser;
let student: TestUser;

async function createStaff(label: string, shopId: string): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      name: `Collect Perm ${label}`,
      email: `collectperm.${label}.${Date.now()}@gmail.com`,
      passwordHash: await hashPassword('CorrectHorse123'),
      role: 'SHOP_STAFF',
      status: 'ACTIVE',
      shopId,
    },
  });
  const token = jwt.sign({ userId: user.userId, role: 'SHOP_STAFF' }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
  return { userId: user.userId, token };
}

function collect(token: string, orderId: string) {
  return request(fx.app).patch(`/api/orders/${orderId}/collect`).set('Authorization', `Bearer ${token}`);
}

async function readyOrder(shopId: string, shop: Awaited<ReturnType<typeof fx.createShop>>): Promise<string> {
  const orderId = await fx.createQueuedOrder(student.token, shop);
  const started = await fx.startNextRequest(admin.token, shopId);
  expect(started.status).toBe(200);
  expect((await fx.completeRequest(admin.token, shopId, started.body.data.queue.queueId)).status).toBe(200);
  return orderId;
}

beforeAll(async () => {
  admin = await fx.createAdmin('admin');
  student = await fx.registerStudent('student');
});

afterAll(async () => {
  // The staff users share the fixtures' email prefix, so cleanup() removes them
  // too - after the orders whose history rows reference them.
  await fx.cleanup();
});

describe('PATCH /api/orders/:id/collect permissions', () => {
  it("staff of the order's own shop can collect a READY order", async () => {
    const shop = await fx.createShop('own');
    const staff = await createStaff('own', shop.shopId);
    const orderId = await readyOrder(shop.shopId, shop);

    expect((await collect(staff.token, orderId)).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe('COLLECTED');
  });

  it("staff of ANOTHER shop cannot collect it (403) and the order stays READY", async () => {
    const shop = await fx.createShop('target');
    const otherShop = await fx.createShop('other');
    const intruder = await createStaff('intruder', otherShop.shopId);
    const orderId = await readyOrder(shop.shopId, shop);

    const res = await collect(intruder.token, orderId);

    expect(res.status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe('READY');
    expect(await prisma.orderStatusHistory.count({ where: { orderId, status: 'COLLECTED' } })).toBe(0);
  });

  it('a second, sequential collection is a clean 409 naming the current state, with one COLLECTED history row', async () => {
    const shop = await fx.createShop('dup');
    const staff = await createStaff('dup', shop.shopId);
    const orderId = await readyOrder(shop.shopId, shop);

    expect((await collect(staff.token, orderId)).status).toBe(200);
    const again = await collect(staff.token, orderId);

    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Order cannot be collected while it is COLLECTED');
    expect(await prisma.orderStatusHistory.count({ where: { orderId, status: 'COLLECTED' } })).toBe(1);
  });

  it.each(['QUEUED', 'PRINTING'] as const)('rejects collecting a %s order with 409 and changes nothing', async (state) => {
    const shop = await fx.createShop(`not-ready-${state.toLowerCase()}`);
    const staff = await createStaff(`nr-${state.toLowerCase()}`, shop.shopId);
    const orderId = await fx.createQueuedOrder(student.token, shop);
    if (state === 'PRINTING') {
      expect((await fx.startNextRequest(admin.token, shop.shopId)).status).toBe(200);
    }

    const res = await collect(staff.token, orderId);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(`Order cannot be collected while it is ${state}`);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe(state);
  });
});
