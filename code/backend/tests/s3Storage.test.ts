import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { createStorageService, LocalStorageService, S3StorageService } from '../src/services/storage';

// S3StorageService is tested against a fake client: no network, no bucket.

function fakeClient(handler: (command: unknown) => unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    send: jest.fn(async (command: unknown) => {
      calls.push(command);
      return handler(command);
    }),
  };
}

const config = {
  bucket: 'smartprint-test',
  region: 'auto',
  accessKeyId: 'id',
  secretAccessKey: 'secret',
  keyPrefix: 'documents/',
};

function awsError(name: string, status: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

describe('S3StorageService', () => {
  it('uploads under the key prefix and refuses to overwrite', async () => {
    const client = fakeClient(() => ({}));
    await new S3StorageService(config, client).save('abc.pdf', Buffer.from('x'));
    const cmd = client.calls[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: 'smartprint-test', Key: 'documents/abc.pdf', IfNoneMatch: '*' });
  });

  it('rejects storage keys that are not plain file names', async () => {
    const storage = new S3StorageService(config, fakeClient(() => ({})));
    await expect(storage.save('../escape.pdf', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(storage.save('a/b.pdf', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
  });

  it('returns the object body as a stream', async () => {
    const client = fakeClient(() => ({ Body: Readable.from([Buffer.from('hello')]) }));
    const stream = await new S3StorageService(config, client).openReadStream('abc.pdf');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(client.calls[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('reports a missing object as ENOENT when opening it', async () => {
    const client = fakeClient(() => {
      throw awsError('NoSuchKey', 404);
    });
    await expect(new S3StorageService(config, client).openReadStream('gone.pdf')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checkAvailability: available / missing / storage error', async () => {
    const ok = new S3StorageService(config, fakeClient(() => ({})));
    await expect(ok.checkAvailability('a.pdf')).resolves.toBe('available');

    const missing = new S3StorageService(
      config,
      fakeClient(() => {
        throw awsError('NotFound', 404);
      }),
    );
    await expect(missing.checkAvailability('a.pdf')).resolves.toBe('missing');

    const broken = new S3StorageService(
      config,
      fakeClient(() => {
        throw awsError('InternalError', 500);
      }),
    );
    await expect(broken.checkAvailability('a.pdf')).rejects.toMatchObject({ name: 'InternalError' });
  });

  it('uses a HEAD request (never downloads) to check availability', async () => {
    const client = fakeClient(() => ({}));
    await new S3StorageService(config, client).checkAvailability('a.pdf');
    expect(client.calls[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('deleting a missing object is not an error', async () => {
    const client = fakeClient(() => {
      throw awsError('NoSuchKey', 404);
    });
    await expect(new S3StorageService(config, client).delete('gone.pdf')).resolves.toBeUndefined();
    expect(client.calls[0]).toBeInstanceOf(DeleteObjectCommand);
  });
});

describe('createStorageService', () => {
  const s3 = { ...config, endpoint: undefined };

  it('uses local disk by default', () => {
    expect(createStorageService({ provider: 'local', s3 }, 'tests/tmp-uploads')).toBeInstanceOf(LocalStorageService);
  });

  it('uses S3 when configured', () => {
    expect(createStorageService({ provider: 's3', s3 })).toBeInstanceOf(S3StorageService);
  });

  it('names the missing variables when S3 is not fully configured', () => {
    expect(() => createStorageService({ provider: 's3', s3: { ...s3, bucket: '', secretAccessKey: '' } })).toThrow(
      'S3_BUCKET, S3_SECRET_ACCESS_KEY',
    );
  });

  it('refuses an unknown provider', () => {
    expect(() => createStorageService({ provider: 'ftp', s3 })).toThrow('Unknown STORAGE_PROVIDER');
  });
});
