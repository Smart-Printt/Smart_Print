import fsSync from 'node:fs';
import path from 'node:path';

import { PrintShop } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/config/prisma';
import { storageService } from '../../src/services/storage';
import { hashPassword } from '../../src/utils/password';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const VALID_PASSWORD = 'CorrectHorse123';

export type TestUser = { userId: string; token: string };

// Shared scaffolding for the race/stream test files. Everything created is
// tagged with `prefix` (users, shops) so cleanup only ever removes this
// file's own data.
export function createRaceFixtures(prefix: string) {
  const app = createApp();
  const shopIds: string[] = [];
  let counter = 0;

  function unique(label: string): string {
    counter += 1;
    return `${label}.${Date.now()}.${counter}`;
  }

  async function registerStudent(label: string): Promise<TestUser> {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: `Race Test ${label}`,
        email: `${prefix}${unique(label)}@${env.allowedStudentEmailDomain}`,
        password: VALID_PASSWORD,
      });
    expect(res.status).toBe(201);
    return { userId: res.body.data.user.userId, token: res.body.data.token };
  }

  async function createAdmin(label: string): Promise<TestUser> {
    const user = await prisma.user.create({
      data: {
        name: `Race Test ${label}`,
        email: `${prefix}${unique(label)}@gmail.com`,
        passwordHash: await hashPassword(VALID_PASSWORD),
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const token = jwt.sign({ userId: user.userId, role: 'ADMIN' }, env.jwtSecret, {
      expiresIn: env.jwtExpiresIn,
    } as jwt.SignOptions);
    return { userId: user.userId, token };
  }

  // A fresh shop per test, so one test's PRINTING order can never affect
  // another test's outcome.
  async function createShop(label: string): Promise<PrintShop> {
    const shop = await prisma.printShop.create({
      data: {
        shopCode: `${prefix.toUpperCase()}${unique(label)}`,
        shopName: `Race Test Shop ${label}`,
        location: 'Test Location',
        contact: '9000000000',
        isActive: true,
        acceptingOrders: true,
      },
    });
    shopIds.push(shop.shopId);
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

  async function uploadDocument(token: string): Promise<string> {
    const buffer = fsSync.readFileSync(path.join(FIXTURES_DIR, 'valid.pdf'));
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename: 'valid.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    return res.body.data.document.documentId;
  }

  async function createOrder(token: string, shop: PrintShop, documentId?: string): Promise<string> {
    const docId = documentId ?? (await uploadDocument(token));
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shopId: shop.shopId,
        items: [{ documentId: docId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(res.status).toBe(201);
    return res.body.data.order.orderId;
  }

  async function initiatePayment(token: string, orderId: string) {
    return request(app)
      .post(`/api/orders/${orderId}/payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'UPI' });
  }

  function confirmPaymentRequest(token: string, orderId: string) {
    return request(app)
      .post(`/api/orders/${orderId}/payment/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ simulateOutcome: 'SUCCESS' });
  }

  async function createQueuedOrder(token: string, shop: PrintShop): Promise<string> {
    const orderId = await createOrder(token, shop);
    expect((await initiatePayment(token, orderId)).status).toBe(201);
    expect((await confirmPaymentRequest(token, orderId)).status).toBe(200);
    return orderId;
  }

  function cancelRequest(token: string, orderId: string) {
    return request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'race test' });
  }

  function startNextRequest(token: string, shopId: string) {
    return request(app)
      .post(`/api/shops/${shopId}/queue/start-next`)
      .set('Authorization', `Bearer ${token}`);
  }

  function completeRequest(token: string, shopId: string, queueId: string) {
    return request(app)
      .patch(`/api/shops/${shopId}/queue/${queueId}/complete`)
      .set('Authorization', `Bearer ${token}`);
  }

  function collectRequest(token: string, orderId: string) {
    return request(app)
      .patch(`/api/orders/${orderId}/collect`)
      .set('Authorization', `Bearer ${token}`);
  }

  // supertest requests only start when something subscribes to them; this
  // starts the request now and returns a promise for its response.
  function fire<T>(req: PromiseLike<T>): Promise<T> {
    return Promise.resolve(req.then((res) => res));
  }

  async function cleanup(): Promise<void> {
    await prisma.refund.deleteMany({ where: { payment: { order: { shopId: { in: shopIds } } } } });
    await prisma.payment.deleteMany({ where: { order: { shopId: { in: shopIds } } } });
    await prisma.order.deleteMany({ where: { shopId: { in: shopIds } } });

    const documents = await prisma.document.findMany({
      where: { user: { email: { startsWith: prefix } } },
      select: { storageKey: true },
    });
    for (const doc of documents) {
      await storageService.delete(doc.storageKey).catch(() => undefined);
    }
    await prisma.document.deleteMany({ where: { user: { email: { startsWith: prefix } } } });
    await prisma.shopPricingRule.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    await prisma.printShop.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.$disconnect();
  }

  return {
    app,
    shopIds,
    registerStudent,
    createAdmin,
    createShop,
    uploadDocument,
    createOrder,
    initiatePayment,
    confirmPaymentRequest,
    createQueuedOrder,
    cancelRequest,
    startNextRequest,
    completeRequest,
    collectRequest,
    fire,
    cleanup,
  };
}
