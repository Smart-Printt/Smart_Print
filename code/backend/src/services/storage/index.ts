import { env } from '../../config/env';
import { LocalStorageService } from './localStorage.service';
import { StorageService } from './storage.service';

export { StorageAvailability, StorageService } from './storage.service';
export { LocalStorageService } from './localStorage.service';

export const storageService: StorageService = new LocalStorageService(env.uploadDir);
