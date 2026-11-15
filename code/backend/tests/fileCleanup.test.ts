import request from 'supertest';

import { PrintShop } from '@prisma/client';

import { prisma } from '../src/config/prisma';
import { runFileCleanup } from '../src/services/fileCleanup.service';
import { storageService } from '../src/services/storage';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// The automatic clean-up removes files nobody needs any more:
//   - documents never used in an order, after the unused retention
//   - files whose orders are ALL collected/cancelled, after the finished
//     retention (the row stays, marked fileDeletedAt, for order history)
// and must never touch a file that an open order still needs.

jest.setTimeout(90_000);

const fx = createRaceFixtures('filecleanup.');
const HOUR = 60 * 60 * 1000;
// Large batch so documents left over in the test database by other files can
// never push this file's documents out of a run.
const BATCH = 100_000;

let student: TestUser;
let shop: PrintShop;

beforeAll(async () => {
  student = await fx.registerStudent('student');
  shop = await fx.createShop('shop');
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
});

function later(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

async function docRow(documentId: string) {
  return prisma.document.findUnique({ where: { documentId } });
}

async function cancel(orderId: string): Promise<void> {
  const res = await fx.cancelRequest(student.token, orderId);
  expect(res.status).toBe(200);
}

describe('unused documents', () => {
  it('deletes a never-used document (row and file) once it is older than the retention', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const { storageKey } = (await docRow(documentId))!;

    const result = await runFileCleanup({ now: later(25), unusedDocumentRetentionHours: 24, batchSize: BATCH });

    expect(result.unusedDocumentsDeleted).toBeGreaterThanOrEqual(1);
    expect(await docRow(documentId)).toBeNull();
    await expect(storageService.checkAvailability(storageKey)).resolves.toBe('missing');
  });

  it('keeps a never-used document that is younger than the retention', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const { storageKey } = (await docRow(documentId))!;

    await runFileCleanup({ now: later(1), unusedDocumentRetentionHours: 24, batchSize: BATCH });

    expect(await docRow(documentId)).not.toBeNull();
    await expect(storageService.checkAvailability(storageKey)).resolves.toBe('available');
  });
});

describe('documents used in orders', () => {
  it('never deletes the file of an order that is still open, however old', async () => {
    const documentId = await fx.uploadDocument(student.token);
    await fx.createOrder(student.token, shop, documentId);
    const { storageKey } = (await docRow(documentId))!;

    await runFileCleanup({
      now: later(24 * 365),
      unusedDocumentRetentionHours: 0,
      finishedOrderRetentionHours: 0,
      batchSize: BATCH,
    });

    const row = await docRow(documentId);
    expect(row?.fileDeletedAt).toBeNull();
    await expect(storageService.checkAvailability(storageKey)).resolves.toBe('available');
  });

  it('keeps the file while a cancelled order is still inside the retention window', async () => {
    const documentId = await fx.uploadDocument(student.token);
    await cancel(await fx.createOrder(student.token, shop, documentId));

    await runFileCleanup({ now: later(2), finishedOrderRetentionHours: 24, batchSize: BATCH });

    expect((await docRow(documentId))?.fileDeletedAt).toBeNull();
  });

  it('deletes the file (but keeps the row) once every order using it is finished', async () => {
    const documentId = await fx.uploadDocument(student.token);
    const orderId = await fx.createOrder(student.token, shop, documentId);
    await cancel(orderId);
    const { storageKey } = (await docRow(documentId))!;

    const result = await runFileCleanup({ now: later(25), finishedOrderRetentionHours: 24, batchSize: BATCH });

    expect(result.finishedOrderFilesDeleted).toBeGreaterThanOrEqual(1);
    const row = await docRow(documentId);
    expect(row).not.toBeNull();
    expect(row?.fileDeletedAt).not.toBeNull();
    await expect(storageService.checkAvailability(storageKey)).resolves.toBe('missing');

    // The order still lists the document.
    expect(await prisma.orderDocument.count({ where: { orderId, documentId } })).toBe(1);

    // Hidden from "my documents", cannot be downloaded, cannot be ordered again.
    const list = await request(fx.app).get('/api/documents').set('Authorization', `Bearer ${student.token}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(documentId);

    const download = await request(fx.app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(download.status).toBe(404);

    const reorder = await request(fx.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${student.token}`)
      .send({
        shopId: shop.shopId,
        items: [{ documentId, copies: 1, printType: 'BW', paperSize: 'A4', sides: 'SINGLE' }],
      });
    expect(reorder.status).toBe(409);
  });

  it('keeps the file when one order is finished but another order still needs it', async () => {
    const documentId = await fx.uploadDocument(student.token);
    await cancel(await fx.createOrder(student.token, shop, documentId));
    await fx.createOrder(student.token, shop, documentId);

    await runFileCleanup({ now: later(25), finishedOrderRetentionHours: 24, batchSize: BATCH });

    expect((await docRow(documentId))?.fileDeletedAt).toBeNull();
  });

  it('changes nothing when storage fails, and reports the failure', async () => {
    const documentId = await fx.uploadDocument(student.token);
    await cancel(await fx.createOrder(student.token, shop, documentId));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(storageService, 'delete').mockRejectedValue(Object.assign(new Error('down'), { code: 'EIO' }));

    const result = await runFileCleanup({ now: later(25), finishedOrderRetentionHours: 24, batchSize: BATCH });

    expect(result.failures).toBeGreaterThanOrEqual(1);
    expect((await docRow(documentId))?.fileDeletedAt).toBeNull();
  });
});
