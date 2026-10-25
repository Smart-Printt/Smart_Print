import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalStorageService } from '../src/services/storage/localStorage.service';

// checkAvailability is the storage-provider-independent "is this object there
// and readable?" probe used before an order is created. It must distinguish
// three things, because the caller reacts differently to each:
//   'available' -> carry on
//   'missing'   -> the client's document is gone (409)
//   rejection   -> storage itself is unhealthy (503, retry later)

let dir: string;
let storage: LocalStorageService;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartprint-storage-availability-'));
  storage = new LocalStorageService(dir);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

describe('LocalStorageService.checkAvailability', () => {
  it("returns 'available' for a stored, readable file", async () => {
    await storage.save('present.pdf', Buffer.from('%PDF-1.4 x'));
    await expect(storage.checkAvailability('present.pdf')).resolves.toBe('available');
  });

  it("returns 'missing' when no such file exists", async () => {
    await expect(storage.checkAvailability('never-saved.pdf')).resolves.toBe('missing');
  });

  it("returns 'missing' after the file is deleted", async () => {
    await storage.save('soon-gone.pdf', Buffer.from('x'));
    await storage.delete('soon-gone.pdf');
    await expect(storage.checkAvailability('soon-gone.pdf')).resolves.toBe('missing');
  });

  it("returns 'missing' when the key points at a directory rather than a file", async () => {
    await fs.mkdir(path.join(dir, 'a-directory.pdf'));
    await expect(storage.checkAvailability('a-directory.pdf')).resolves.toBe('missing');
  });

  it("returns 'missing' when a path component is a file (ENOTDIR)", async () => {
    await storage.save('plain.pdf', Buffer.from('x'));
    await expect(storage.checkAvailability('plain.pdf/child.pdf')).resolves.toBe('missing');
  });

  it('does not read or modify the file', async () => {
    await storage.save('untouched.pdf', Buffer.from('abc'));
    const before = await fs.stat(path.join(dir, 'untouched.pdf'));
    await storage.checkAvailability('untouched.pdf');
    const after = await fs.stat(path.join(dir, 'untouched.pdf'));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'EMFILE'])(
    'rejects (does NOT report missing) when the file cannot be inspected: %s',
    async (code) => {
      jest.spyOn(fs, 'stat').mockRejectedValue(errnoError(code));
      await expect(storage.checkAvailability('anything.pdf')).rejects.toMatchObject({ code });
    },
  );

  it('rejects when the file exists but is not readable (EACCES from the read-permission check)', async () => {
    await storage.save('locked.pdf', Buffer.from('x'));
    jest.spyOn(fs, 'access').mockRejectedValue(errnoError('EACCES'));
    await expect(storage.checkAvailability('locked.pdf')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('refuses a key that would escape the storage directory', async () => {
    await expect(storage.checkAvailability('../outside.pdf')).rejects.toThrow(/escapes/);
  });
});
