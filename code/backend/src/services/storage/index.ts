import { env } from '../../config/env';
import { LocalStorageService } from './localStorage.service';
import { S3StorageService } from './s3Storage.service';
import { StorageService } from './storage.service';

export { StorageAvailability, StorageService } from './storage.service';
export { LocalStorageService } from './localStorage.service';
export { S3StorageService } from './s3Storage.service';

export function createStorageService(config = env.storage, uploadDir = env.uploadDir): StorageService {
  if (config.provider === 'local') {
    return new LocalStorageService(uploadDir);
  }
  if (config.provider === 's3') {
    const missing = (
      [
        ['S3_BUCKET', config.s3.bucket],
        ['S3_ACCESS_KEY_ID', config.s3.accessKeyId],
        ['S3_SECRET_ACCESS_KEY', config.s3.secretAccessKey],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`STORAGE_PROVIDER=s3 needs these environment variables: ${missing.join(', ')}`);
    }
    return new S3StorageService(config.s3);
  }
  throw new Error(`Unknown STORAGE_PROVIDER "${config.provider}" (use "local" or "s3").`);
}

export const storageService: StorageService = createStorageService();
