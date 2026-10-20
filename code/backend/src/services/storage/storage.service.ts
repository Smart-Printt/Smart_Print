// Storage abstraction: the document service/controller talk only to this
// interface. Swapping LocalStorageService for a future S3-compatible
// implementation should not require changing anything outside this folder.
import { Readable } from 'node:stream';

export interface StorageService {
  save(storageKey: string, data: Buffer): Promise<void>;
  // Resolves only once the object has actually been opened, so a missing or
  // unreadable file rejects HERE (before any response header is sent) instead
  // of surfacing as an 'error' event halfway through a response. A missing
  // object rejects with an error whose `code` is 'ENOENT'. The caller owns the
  // returned stream and must consume or destroy it.
  openReadStream(storageKey: string): Promise<Readable>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
}
