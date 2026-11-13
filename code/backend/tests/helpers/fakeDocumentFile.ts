import { storageService } from '../../src/services/storage';

// Order creation now checks that a document's stored file exists, so tests
// that insert Document rows directly (to control pageCount etc.) must also put
// a file behind them. The content is irrelevant - only presence matters.
const written: string[] = [];

export async function writeFakeDocumentFile(storageKey: string): Promise<void> {
  await storageService.save(storageKey, Buffer.from('%PDF-1.4 test fixture'));
  written.push(storageKey);
}

export async function removeFakeDocumentFiles(): Promise<void> {
  while (written.length > 0) {
    await storageService.delete(written.pop() as string).catch(() => undefined);
  }
}
