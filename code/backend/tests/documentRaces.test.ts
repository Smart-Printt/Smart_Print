import request from 'supertest';

import { prisma } from '../src/config/prisma';
import { storageService } from '../src/services/storage';
import { pauseNextWrite, withTimeout } from './helpers/concurrency';
import { createRaceFixtures } from './helpers/raceFixtures';

// Deterministic races between deleting a document and creating an order that
// uses it. Same technique as orderRaces.test.ts: one operation is paused after
// it has read its inputs and before it writes, the competing operation runs to
// completion, then the paused one is released.

jest.setTimeout(90_000);

const fx = createRaceFixtures('docracetest.');
const STEP_MS = 15_000;

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

describe('document deletion versus order creation', () => {
  it('an order created from a document deleted in the meantime fails cleanly (no 500, no partial order)', async () => {
    const student = await fx.registerStudent('delete-vs-order');
    const shop = await fx.createShop('delete-vs-order');
    const documentId = await fx.uploadDocument(student.token);

    const pause = pauseNextWrite();
    const create = fx.fire(
      request(fx.app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${student.token}`)
        .send({
          shopId: shop.shopId,
          items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
        }),
    );
    await withTimeout(pause.entered, STEP_MS, 'order creation to reach its write');
    pause.restore();

    const del = await request(fx.app)
      .delete(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(del.status).toBe(200);

    pause.release();
    const res = await withTimeout(create, STEP_MS, 'order creation response');
    expect([404, 409]).toContain(res.status);
    expect(await prisma.order.count({ where: { userId: student.userId } })).toBe(0);
  });

  it('a document that an order references in the meantime is neither deleted nor left without its file', async () => {
    const student = await fx.registerStudent('order-vs-delete');
    const shop = await fx.createShop('order-vs-delete');
    const documentId = await fx.uploadDocument(student.token);
    const { storageKey } = await prisma.document.findUniqueOrThrow({ where: { documentId } });

    const pause = pauseNextWrite({ storageDelete: true });
    const del = fx.fire(
      request(fx.app).delete(`/api/documents/${documentId}`).set('Authorization', `Bearer ${student.token}`),
    );
    await withTimeout(pause.entered, STEP_MS, 'deletion to reach its write');
    pause.restore();

    await fx.createOrder(student.token, shop, documentId);

    pause.release();
    const delRes = await withTimeout(del, STEP_MS, 'deletion response');
    expect(delRes.status).toBe(409);

    expect(await prisma.document.count({ where: { documentId } })).toBe(1);
    expect(await storageService.exists(storageKey)).toBe(true);
  });
});
