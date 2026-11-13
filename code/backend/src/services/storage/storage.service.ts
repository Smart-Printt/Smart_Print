// Storage abstraction: the document service/controller talk only to this
// interface. Swapping LocalStorageService for a future S3-compatible
// implementation should not require changing anything outside this folder.
import { Readable } from 'node:stream';

// 'missing' = the object definitely does not exist (or is not a regular
// file). Anything else that stops us from finding out - permissions, I/O
// errors, a cloud provider outage - is NOT 'missing': checkAvailability
// rejects, so callers can tell "your file is gone" from "storage is down".
export type StorageAvailability = 'available' | 'missing';

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
  // Is the object present AND readable right now? Resolves 'available' or
  // 'missing'; rejects on any other failure (see StorageAvailability). Must
  // be cheap and must not download the object: a cloud implementation should
  // use a metadata request (e.g. S3 HeadObject), mapping a 404/NoSuchKey to
  // 'missing' and every other error to a rejection.
  checkAvailability(storageKey: string): Promise<StorageAvailability>;
}
