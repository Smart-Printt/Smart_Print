import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { StorageService } from './storage.service';

// Private local-filesystem storage for Phase 3. `storageKey` is always a
// server-generated UUID + validated extension (see utils/fileNaming.ts) -
// this class defends in depth against path traversal anyway by refusing to
// resolve outside baseDir, in case that assumption is ever violated.
export class LocalStorageService implements StorageService {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private resolveSafePath(storageKey: string): string {
    const resolved = path.resolve(this.baseDir, storageKey);
    const withinBase = resolved === this.baseDir || resolved.startsWith(this.baseDir + path.sep);
    if (!withinBase) {
      throw new Error('Resolved storage path escapes the configured upload directory');
    }
    return resolved;
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const target = this.resolveSafePath(storageKey);
    // 'wx' refuses to overwrite an existing file - storageKey collisions
    // (practically impossible with a UUID) fail loudly instead of silently
    // clobbering another document's file.
    await fs.writeFile(target, data, { flag: 'wx' });
  }

  openReadStream(storageKey: string): Promise<Readable> {
    const target = this.resolveSafePath(storageKey);
    const stream = createReadStream(target);
    return new Promise<Readable>((resolve, reject) => {
      const onOpen = (): void => {
        stream.off('error', onError);
        resolve(stream);
      };
      const onError = (err: Error): void => {
        stream.off('open', onOpen);
        stream.destroy();
        reject(err);
      };
      stream.once('open', onOpen);
      stream.once('error', onError);
    });
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolveSafePath(storageKey));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw err;
      }
      // Already missing - deletion is idempotent/safe to retry.
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolveSafePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }
}
