import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { StorageAvailability, StorageService } from './storage.service';

// S3-compatible object storage: AWS S3, Cloudflare R2, MinIO, etc. Files are
// kept in a PRIVATE bucket; students and staff never get a bucket URL - every
// download still goes through the API, which checks who is asking first.

export interface S3StorageConfig {
  bucket: string;
  region: string;
  // Leave unset for AWS S3. For Cloudflare R2 it is
  // https://<account-id>.r2.cloudflarestorage.com
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Folder-like prefix inside the bucket, e.g. "documents/".
  keyPrefix?: string;
}

// Only the part of S3Client we use, so tests can pass a fake.
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.Code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function notFoundError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('Stored object not found');
  err.code = 'ENOENT';
  return err;
}

export class S3StorageService implements StorageService {
  private readonly client: S3Like;
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(config: S3StorageConfig, client?: S3Like) {
    this.bucket = config.bucket;
    this.keyPrefix = config.keyPrefix ?? '';
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        // R2 and MinIO need path-style URLs when a custom endpoint is used.
        forcePathStyle: Boolean(config.endpoint),
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      });
  }

  private objectKey(storageKey: string): string {
    // storageKey is server-generated (UUID + extension); refuse anything else
    // so a bad value can never reach outside our prefix.
    if (!/^[A-Za-z0-9._-]+$/.test(storageKey) || storageKey.startsWith('.')) {
      throw new Error('Invalid storage key');
    }
    return `${this.keyPrefix}${storageKey}`;
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(storageKey),
        Body: data,
        // Refuse to overwrite an existing object (same idea as the local
        // store's 'wx' flag). Supported by AWS S3 and Cloudflare R2.
        IfNoneMatch: '*',
      }),
    );
  }

  async openReadStream(storageKey: string): Promise<Readable> {
    let result: { Body?: unknown };
    try {
      result = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(storageKey) }),
      )) as { Body?: unknown };
    } catch (err) {
      if (isNotFound(err)) {
        throw notFoundError();
      }
      throw err;
    }
    if (!(result.Body instanceof Readable)) {
      throw new Error('Storage returned no readable body');
    }
    return result.Body;
  }

  async delete(storageKey: string): Promise<void> {
    try {
      // S3 DeleteObject succeeds even when the object is already gone.
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(storageKey) }),
      );
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }

  async checkAvailability(storageKey: string): Promise<StorageAvailability> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(storageKey) }),
      );
      return 'available';
    } catch (err) {
      if (isNotFound(err)) {
        return 'missing';
      }
      throw err;
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      return (await this.checkAvailability(storageKey)) === 'available';
    } catch {
      return false;
    }
  }
}
