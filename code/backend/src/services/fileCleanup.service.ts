import { OrderStatus } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { storageService } from './storage';

// Automatic file clean-up (data privacy: we keep students' files only as long
// as the shop needs them).
//
//   1. A document that was uploaded but never used in any order is deleted
//      completely (row + file) once it is older than the unused retention.
//   2. A document whose orders are ALL finished (collected or cancelled) for
//      longer than the finished retention has its FILE deleted. The row stays,
//      marked with fileDeletedAt, so order history still shows the file name.
//
// Each document is handled in its own transaction that locks the row FOR
// UPDATE and re-checks the rule before touching storage. createOrder takes the
// same row FOR SHARE, so a document cannot be cleaned up while a new order is
// being placed with it - and an order placed after the clean-up sees
// fileDeletedAt and asks the student to upload the file again.
//
// The stored file is deleted INSIDE the transaction, before the row change is
// committed: if storage fails, nothing is committed and the next run retries.
// If the commit fails after the file was deleted, the document simply shows as
// "file missing" (already handled everywhere) and the next run finishes it.

export const FINISHED_ORDER_STATUSES: OrderStatus[] = ['COLLECTED', 'CANCELLED'];

export interface FileCleanupOptions {
  now?: Date;
  finishedOrderRetentionHours?: number;
  unusedDocumentRetentionHours?: number;
  batchSize?: number;
}

export interface FileCleanupResult {
  unusedDocumentsDeleted: number;
  finishedOrderFilesDeleted: number;
  failures: number;
}

const HOUR_MS = 60 * 60 * 1000;
const TRANSACTION_TIMEOUT_MS = 20_000;

function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

function logFailure(what: string, documentId: string, err: unknown): void {
  // Error code/name only: storage errors can contain bucket paths.
  const e = err as NodeJS.ErrnoException;
  // eslint-disable-next-line no-console
  console.error(`File clean-up: could not ${what} for document ${documentId}:`, e?.code ?? e?.name ?? 'error');
}

// The uploaded file and, for Office uploads, the PDF made from it.
async function deleteStoredFiles(row: { storage_key: string; print_storage_key: string | null }): Promise<void> {
  await storageService.delete(row.storage_key);
  if (row.print_storage_key) {
    await storageService.delete(row.print_storage_key);
  }
}

async function deleteUnusedDocument(documentId: string, cutoff: Date): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ storage_key: string; print_storage_key: string | null; uploaded_at: Date }[]>`
        SELECT storage_key, print_storage_key, uploaded_at FROM documents WHERE document_id = ${documentId} FOR UPDATE`;
      if (locked.length === 0 || locked[0].uploaded_at >= cutoff) {
        return false;
      }
      const used = await tx.orderDocument.findFirst({ where: { documentId }, select: { documentId: true } });
      if (used) {
        return false;
      }
      await deleteStoredFiles(locked[0]);
      await tx.document.delete({ where: { documentId } });
      return true;
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

async function deleteFinishedOrderFile(documentId: string, cutoff: Date, now: Date): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<
        { storage_key: string; print_storage_key: string | null; file_deleted_at: Date | null }[]
      >`
        SELECT storage_key, print_storage_key, file_deleted_at FROM documents
        WHERE document_id = ${documentId} FOR UPDATE`;
      if (locked.length === 0 || locked[0].file_deleted_at) {
        return false;
      }
      const stillNeeded = await tx.orderDocument.findFirst({
        where: {
          documentId,
          OR: [
            { order: { orderStatus: { notIn: FINISHED_ORDER_STATUSES } } },
            { order: { updatedAt: { gte: cutoff } } },
          ],
        },
        select: { documentId: true },
      });
      if (stillNeeded) {
        return false;
      }
      await deleteStoredFiles(locked[0]);
      await tx.document.update({ where: { documentId }, data: { fileDeletedAt: now } });
      return true;
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

export async function runFileCleanup(options: FileCleanupOptions = {}): Promise<FileCleanupResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 100;
  const unusedCutoff = hoursBefore(
    now,
    options.unusedDocumentRetentionHours ?? env.fileCleanup.unusedDocumentRetentionHours,
  );
  const finishedCutoff = hoursBefore(
    now,
    options.finishedOrderRetentionHours ?? env.fileCleanup.finishedOrderRetentionHours,
  );
  const result: FileCleanupResult = { unusedDocumentsDeleted: 0, finishedOrderFilesDeleted: 0, failures: 0 };

  const unused = await prisma.document.findMany({
    where: { uploadedAt: { lt: unusedCutoff }, orderDocuments: { none: {} } },
    select: { documentId: true },
    orderBy: { uploadedAt: 'asc' },
    take: batchSize,
  });
  for (const { documentId } of unused) {
    try {
      if (await deleteUnusedDocument(documentId, unusedCutoff)) {
        result.unusedDocumentsDeleted += 1;
      }
    } catch (err) {
      result.failures += 1;
      logFailure('delete unused document', documentId, err);
    }
  }

  const finished = await prisma.document.findMany({
    where: {
      fileDeletedAt: null,
      orderDocuments: {
        some: {},
        every: { order: { orderStatus: { in: FINISHED_ORDER_STATUSES }, updatedAt: { lt: finishedCutoff } } },
      },
    },
    select: { documentId: true },
    orderBy: { uploadedAt: 'asc' },
    take: batchSize,
  });
  for (const { documentId } of finished) {
    try {
      if (await deleteFinishedOrderFile(documentId, finishedCutoff, now)) {
        result.finishedOrderFilesDeleted += 1;
      }
    } catch (err) {
      result.failures += 1;
      logFailure('delete file', documentId, err);
    }
  }

  return result;
}

// Runs the clean-up every FILE_CLEANUP_INTERVAL_MINUTES (0 = off). Called from
// server.ts only, so tests never start a background timer.
export function startFileCleanupJob(intervalMinutes = env.fileCleanup.intervalMinutes): () => void {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return () => undefined;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const r = await runFileCleanup();
      if (r.unusedDocumentsDeleted || r.finishedOrderFilesDeleted || r.failures) {
        // eslint-disable-next-line no-console
        console.log(
          `File clean-up: removed ${r.unusedDocumentsDeleted} unused document(s) and ` +
            `${r.finishedOrderFilesDeleted} finished-order file(s); ${r.failures} failure(s).`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('File clean-up run failed:', (err as Error).name);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), intervalMinutes * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
