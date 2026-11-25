import http from 'node:http';
import { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import * as orderService from '../src/services/order.service';
import * as queueService from '../src/services/queue.service';
import { publishShopQueueChanged, subscribeToShopQueue } from '../src/services/queueEvents';
import * as shopService from '../src/services/shop.service';
import { SafeQueueEntry } from '../src/types/queue.types';
import { ForbiddenError, NotFoundError } from '../src/utils/errors';

// These tests deliberately do not touch the database: the queue/shop/order
// lookups are stubbed so the new logic - the event bus, the SSE stream and the
// pickup lookup's access rules - is exercised on its own. (The wait-time model
// itself is tested in waitModel.test.ts.)

const app = createApp();

function token(userId: string, role: 'STUDENT' | 'SHOP_STAFF' | 'ADMIN'): string {
  return jwt.sign({ userId, role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

function entry(overrides: Partial<SafeQueueEntry> = {}): SafeQueueEntry {
  return {
    queueId: 'q-1',
    orderId: 'o-1',
    orderCode: 'SP-TEST-0001',
    shopId: 'shop-1',
    queueNumber: 7,
    queueStatus: 'WAITING',
    enteredAt: new Date('2026-11-01T10:00:00Z'),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    position: 3,
    estimatedWaitMinutes: 10,
    estimatedWaitRange: { low: 6, high: 14 },
    estimateBasis: { method: 'bayesian-linear-regression', trainingOrders: 0, maeMinutes: null, baselineMaeMinutes: null },
    estimateStatus: 'normal',
    ...overrides,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('queue event bus', () => {
  it('notifies subscribers of the same shop only, and stops after unsubscribe', () => {
    const sameShop = jest.fn();
    const otherShop = jest.fn();
    const unsubscribe = subscribeToShopQueue('shop-a', sameShop);
    const unsubscribeOther = subscribeToShopQueue('shop-b', otherShop);

    publishShopQueueChanged('shop-a');
    expect(sameShop).toHaveBeenCalledTimes(1);
    expect(otherShop).not.toHaveBeenCalled();

    unsubscribe();
    publishShopQueueChanged('shop-a');
    expect(sameShop).toHaveBeenCalledTimes(1);
    unsubscribeOther();
  });

  it('never throws into the caller when a subscriber throws', () => {
    const unsubscribe = subscribeToShopQueue('shop-c', () => {
      throw new Error('boom');
    });
    expect(() => publishShopQueueChanged('shop-c')).not.toThrow();
    unsubscribe();
  });
});

describe('GET /api/orders/:orderId/queue/stream', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(bearer: string | null, orderId = 'o-1'): Promise<{ res: http.IncomingMessage; frames: () => string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const req = http.get({ host: '127.0.0.1', port, path: `/api/orders/${orderId}/queue/stream`, headers }, (res) => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
        });
        resolve({ res, frames: () => received });
      });
      req.on('error', reject);
    });
  }

  async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for stream data');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('rejects a request without a token', async () => {
    const res = await request(app).get('/api/orders/o-1/queue/stream');
    expect(res.status).toBe(401);
  });

  it('returns a normal JSON error (not a stream) when the order is not accessible', async () => {
    jest.spyOn(queueService, 'getQueueEntryForOrder').mockRejectedValue(new NotFoundError('Order not found'));
    const res = await request(app)
      .get('/api/orders/o-404/queue/stream')
      .set('Authorization', `Bearer ${token('student-1', 'STUDENT')}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('sends the current entry, pushes an update when the shop queue changes, and ends when the order leaves the queue', async () => {
    const spy = jest
      .spyOn(queueService, 'getQueueEntryForOrder')
      .mockResolvedValueOnce(entry({ position: 3, estimatedWaitMinutes: 10 }))
      .mockResolvedValueOnce(entry({ position: 1, estimatedWaitMinutes: 0 }))
      .mockResolvedValueOnce(entry({ queueStatus: 'COMPLETED', position: null, estimatedWaitMinutes: null }));

    const { res, frames } = await open(token('student-1', 'STUDENT'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);

    await until(() => frames().includes('event: queue'));
    expect(frames()).toContain('"position":3');

    publishShopQueueChanged('shop-1');
    await until(() => frames().includes('"position":1'));

    const ended = new Promise<void>((resolve) => res.on('end', resolve));
    publishShopQueueChanged('shop-1');
    await ended;
    expect(frames()).toContain('"queueStatus":"COMPLETED"');
    expect(frames()).toContain('event: end');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops listening to the shop once the client disconnects', async () => {
    const spy = jest.spyOn(queueService, 'getQueueEntryForOrder').mockResolvedValue(entry());
    const { res, frames } = await open(token('student-2', 'STUDENT'));
    await until(() => frames().includes('event: queue'));
    expect(spy).toHaveBeenCalledTimes(1);

    const closed = new Promise<void>((resolve) => res.on('close', resolve));
    res.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    publishShopQueueChanged('shop-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('limits how many streams one user can hold open', async () => {
    jest.spyOn(queueService, 'getQueueEntryForOrder').mockResolvedValue(entry());
    const bearer = token('student-3', 'STUDENT');
    const opened = [];
    for (let i = 0; i < 5; i += 1) {
      const stream = await open(bearer);
      expect(stream.res.statusCode).toBe(200);
      opened.push(stream);
    }
    const sixth = await request(app).get('/api/orders/o-1/queue/stream').set('Authorization', `Bearer ${bearer}`);
    expect(sixth.status).toBe(429);

    for (const { res } of opened) res.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await open(bearer);
    expect(again.res.statusCode).toBe(200);
    again.res.destroy();
  });
});

describe('GET /api/orders/by-code/:orderCode (pickup scan)', () => {
  const baseOrder = { orderId: 'o-1', orderCode: 'SP-ABC-123', shopId: 'shop-1' };

  function stubOrderRow(row: typeof baseOrder | null) {
    return jest.spyOn(prisma.order, 'findUnique').mockResolvedValue(row as never);
  }

  it('is closed to students at the route level', async () => {
    const res = await request(app)
      .get('/api/orders/by-code/SP-ABC-123')
      .set('Authorization', `Bearer ${token('student-1', 'STUDENT')}`);
    expect(res.status).toBe(403);
  });

  it('requires a token', async () => {
    const res = await request(app).get('/api/orders/by-code/SP-ABC-123');
    expect(res.status).toBe(401);
  });

  it('normalises the scanned code (trim, case) before looking it up', async () => {
    const find = stubOrderRow(null);
    await expect(orderService.getOrderByCodeForStaff('admin-1', 'ADMIN', '  sp-abc-123 ')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { orderCode: 'SP-ABC-123' } }));
  });

  it('rejects empty and non-string codes', async () => {
    await expect(orderService.getOrderByCodeForStaff('admin-1', 'ADMIN', '   ')).rejects.toThrow('Order code is required');
    await expect(orderService.getOrderByCodeForStaff('admin-1', 'ADMIN', { $ne: 1 })).rejects.toThrow('Order code is required');
    await expect(orderService.getOrderByCodeForStaff('admin-1', 'ADMIN', 'X'.repeat(65))).rejects.toThrow('too long');
  });

  it("reports another shop's order to staff as plain 'not found' (no existence leak)", async () => {
    stubOrderRow(baseOrder);
    jest.spyOn(shopService, 'assertShopAccess').mockRejectedValue(new ForbiddenError('You are not authorized to manage this shop'));
    await expect(orderService.getOrderByCodeForStaff('staff-1', 'SHOP_STAFF', 'SP-ABC-123')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('checks shop access against the ORDER\'s shop, not anything the client sent', async () => {
    stubOrderRow(baseOrder);
    const access = jest.spyOn(shopService, 'assertShopAccess').mockRejectedValue(new ForbiddenError('nope'));
    await expect(orderService.getOrderByCodeForStaff('staff-1', 'SHOP_STAFF', 'SP-ABC-123')).rejects.toBeDefined();
    expect(access).toHaveBeenCalledWith('staff-1', 'SHOP_STAFF', 'shop-1');
  });
});
