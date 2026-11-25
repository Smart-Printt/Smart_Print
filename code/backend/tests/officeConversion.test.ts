import fsSync from 'node:fs';
import path from 'node:path';

import jwt from 'jsonwebtoken';
import request from 'supertest';

import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { OfficeConverter, officeConverter } from '../src/services/documents/officeConverter';
import { storageService } from '../src/services/storage';
import { hashPassword } from '../src/utils/password';
import { TestUser, createRaceFixtures } from './helpers/raceFixtures';

// Word/Excel/PowerPoint uploads get a PDF copy for printing. LibreOffice is
// replaced by tests/fixtures/fake-soffice (a tiny node script), so these tests
// run anywhere.

jest.setTimeout(90_000);

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE = path.join(FIXTURES, 'fake-soffice', 'fake-soffice.js');
const PDF = fsSync.readFileSync(path.join(FIXTURES, 'valid.pdf'));
const DOCX = fsSync.readFileSync(path.join(FIXTURES, 'valid.docx'));

function converter(overrides: Partial<ConstructorParameters<typeof OfficeConverter>[0]> = {}) {
  return new OfficeConverter({
    enabled: true,
    command: [process.execPath, FAKE],
    timeoutMs: 20_000,
    maxParallel: 2,
    ...overrides,
  });
}

function fakeMode(mode: string): string[] {
  return [process.execPath, FAKE, `--fake-mode=${mode}`];
}

describe('OfficeConverter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('converts a Word file to PDF', async () => {
    const result = await converter().convert('DOCX', '.docx', DOCX);
    expect(result.status).toBe('converted');
    expect(result.status === 'converted' && result.pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('does nothing for PDFs and images', async () => {
    await expect(converter().convert('PDF', '.pdf', PDF)).resolves.toEqual({
      status: 'skipped',
      reason: 'not-convertible',
    });
  });

  it('does nothing when switched off', async () => {
    await expect(converter({ enabled: false }).convert('DOCX', '.docx', DOCX)).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
  });

  it('skips (with one warning) when LibreOffice is not installed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = converter({ command: ['definitely-not-a-real-soffice-binary'] });
    await expect(c.convert('PPTX', '.pptx', DOCX)).resolves.toEqual({ status: 'skipped', reason: 'not-installed' });
    await c.convert('PPTX', '.pptx', DOCX);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('kills a conversion that takes too long', async () => {
    await expect(converter({ timeoutMs: 1_000, command: fakeMode('slow') }).convert('DOCX', '.docx', DOCX)).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
    });
  });

  it.each(['crash', 'no-output'])('reports a failure when LibreOffice does not produce a PDF (%s)', async (mode) => {
    await expect(converter({ command: fakeMode(mode) }).convert('XLSX', '.xlsx', DOCX)).resolves.toEqual({ status: 'failed', reason: 'error' });
  });

  it('runs no more than maxParallel conversions at once', async () => {
    const c = converter({ maxParallel: 1 });
    const results = await Promise.all([1, 2, 3].map(() => c.convert('DOCX', '.docx', DOCX)));
    expect(results.every((r) => r.status === 'converted')).toBe(true);
  });
});

describe('uploading an Office file', () => {
  const fx = createRaceFixtures('officepdf.');
  let student: TestUser;

  beforeAll(async () => {
    student = await fx.registerStudent('student');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: 'officepdf.staff' } } });
    await fx.cleanup();
  });

  async function uploadDocx(): Promise<string> {
    const res = await request(fx.app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${student.token}`)
      .attach('file', DOCX, {
        filename: 'notes.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    expect(res.status).toBe(201);
    return res.body.data.document.documentId;
  }

  async function staffTokenFor(documentId: string): Promise<string> {
    const shop = await fx.createShop('shop');
    await fx.createOrder(student.token, shop, documentId);
    const staff = await prisma.user.create({
      data: {
        name: 'Office PDF Staff',
        email: `officepdf.staff.${Date.now()}@gmail.com`,
        passwordHash: await hashPassword('CorrectHorse123'),
        role: 'SHOP_STAFF',
        status: 'ACTIVE',
        shopId: shop.shopId,
      },
    });
    return jwt.sign({ userId: staff.userId, role: 'SHOP_STAFF' }, env.jwtSecret, {
      expiresIn: env.jwtExpiresIn,
    } as jwt.SignOptions);
  }

  it('stores a PDF copy, uses its page count, and gives it to shop staff', async () => {
    jest.spyOn(officeConverter, 'convert').mockResolvedValue({ status: 'converted', pdf: PDF });
    const documentId = await uploadDocx();

    const row = await prisma.document.findUniqueOrThrow({ where: { documentId } });
    expect(row.printStorageKey).toMatch(/\.pdf$/);
    expect(row.printFileSize).toBe(PDF.length);
    expect(row.pageCount).toBeGreaterThanOrEqual(1);
    await expect(storageService.checkAvailability(row.printStorageKey!)).resolves.toBe('available');

    // The student gets their original file back by default...
    const own = await request(fx.app)
      .get(`/api/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('wordprocessingml');

    // ...or the PDF when asked.
    const asPdf = await request(fx.app)
      .get(`/api/documents/${documentId}/download?format=pdf`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(asPdf.status).toBe(200);
    expect(asPdf.headers['content-type']).toContain('application/pdf');
    expect(asPdf.headers['content-disposition']).toContain('notes.pdf');

    // Shop staff get the PDF by default (that is what they print).
    const staffToken = await staffTokenFor(documentId);
    const staffView = await request(fx.app)
      .get(`/api/documents/${documentId}/view`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffView.status).toBe(200);
    expect(staffView.headers['content-type']).toContain('application/pdf');
    expect(Number(staffView.headers['content-length'])).toBe(PDF.length);

    const staffOriginal = await request(fx.app)
      .get(`/api/documents/${documentId}/download?format=original`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffOriginal.headers['content-type']).toContain('wordprocessingml');
  });

  it('still accepts the upload when conversion fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(officeConverter, 'convert').mockResolvedValue({ status: 'failed', reason: 'timeout' });
    const documentId = await uploadDocx();

    const row = await prisma.document.findUniqueOrThrow({ where: { documentId } });
    expect(row.printStorageKey).toBeNull();

    const asPdf = await request(fx.app)
      .get(`/api/documents/${documentId}/download?format=pdf`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(asPdf.status).toBe(404);
  });

  it('rejects an unknown format', async () => {
    const documentId = await uploadDocx();
    const res = await request(fx.app)
      .get(`/api/documents/${documentId}/download?format=docx`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(400);
  });

  it('deletes the PDF copy together with the document', async () => {
    jest.spyOn(officeConverter, 'convert').mockResolvedValue({ status: 'converted', pdf: PDF });
    const documentId = await uploadDocx();
    const row = await prisma.document.findUniqueOrThrow({ where: { documentId } });

    const res = await request(fx.app)
      .delete(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(res.status).toBe(200);
    await expect(storageService.checkAvailability(row.printStorageKey!)).resolves.toBe('missing');
  });
});
