import { prisma } from '../../src/config/prisma';
import { storageService } from '../../src/services/storage';

// Helpers for deterministic concurrency tests. A race is never "proved" by
// firing requests together and hoping they interleave: each test pauses one
// operation at a known point (after it has read state, before it writes),
// lets a competing operation run to completion, and only then releases the
// paused one. Database-level lock waits are observed through pg_stat_activity
// instead of sleeping for a guessed amount of time.

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function eventually(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface Pause {
  // Resolves once the paused operation has reached the pause point.
  entered: Promise<void>;
  // Lets the paused operation continue.
  release: () => void;
  restore: () => void;
}

// Pauses the FIRST database transaction (or, optionally, the first storage
// delete) started by the code under test. Every service in this project reads
// and authorises outside its transaction and then opens one, so this is the
// exact "read state, then write" gap the races exploit. Install it
// immediately before starting the operation to pause, and start nothing else
// until `entered` resolves.
export function pauseNextWrite(options: { storageDelete?: boolean } = {}): Pause {
  const entered = deferred<void>();
  const gate = deferred<void>();
  let fired = false;

  const pauseOnce = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    entered.resolve();
    await gate.promise;
  };

  const originalTransaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => unknown;
  const transactionSpy = jest
    .spyOn(prisma, '$transaction')
    .mockImplementation(((...args: unknown[]) =>
      pauseOnce().then(() => originalTransaction(...args))) as never);

  let deleteSpy: jest.SpyInstance | undefined;
  if (options.storageDelete) {
    const originalDelete = storageService.delete.bind(storageService);
    deleteSpy = jest
      .spyOn(storageService, 'delete')
      .mockImplementation(((key: string) => pauseOnce().then(() => originalDelete(key))) as never);
  }

  // Only the first call is gated; later calls pass straight through.
  const restore = (): void => {
    transactionSpy.mockRestore();
    deleteSpy?.mockRestore();
  };

  return {
    entered: entered.promise,
    release: () => {
      gate.resolve();
    },
    restore,
  };
}

export interface LockHolder {
  acquired: Promise<void>;
  // Runs `beforeCommit`, commits, and resolves when the transaction is over.
  release: () => Promise<void>;
}

// Holds database row locks from a separate transaction until released.
export function holdLocks(lockSql: string[], beforeCommitSql: string[] = []): LockHolder {
  const acquired = deferred<void>();
  const releaseGate = deferred<void>();

  const finished = prisma
    .$transaction(
      async (tx) => {
        for (const sql of lockSql) {
          await tx.$queryRawUnsafe(sql);
        }
        acquired.resolve();
        await releaseGate.promise;
        for (const sql of beforeCommitSql) {
          await tx.$executeRawUnsafe(sql);
        }
      },
      { maxWait: 10_000, timeout: 60_000 },
    )
    .catch((err) => {
      acquired.reject(err);
      throw err;
    });

  return {
    acquired: acquired.promise,
    release: async () => {
      releaseGate.resolve();
      await finished;
    },
  };
}

// Number of other database sessions currently blocked waiting for a lock.
export async function countLockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'`;
  return rows[0]?.waiting ?? 0;
}

export async function waitForLockWaiters(count: number, timeoutMs = 10_000): Promise<void> {
  await eventually(
    async () => (await countLockWaiters()) >= count,
    `${count} database session(s) blocked on a lock`,
    timeoutMs,
  );
}

// True when the row can be locked immediately, i.e. nobody else holds it.
export async function rowIsLockable(table: 'orders' | 'print_shops' | 'queue', idColumn: string, id: string): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1 FOR UPDATE NOWAIT`, id);
    });
    return true;
  } catch (err) {
    if (String((err as Error).message).includes('55P03') || /could not obtain lock/i.test(String((err as Error).message))) {
      return false;
    }
    throw err;
  }
}

// Order/queue invariants that must hold after ANY interleaving of
// cancel / pay / start-next / complete / collect.
export async function assertOrderQueueInvariants(shopIds: string[]): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { shopId: { in: shopIds } },
    include: { queue: true, statusHistory: true },
  });

  for (const shopId of shopIds) {
    const printing = await prisma.queue.count({
      where: { queueStatus: 'PRINTING', order: { shopId } },
    });
    expect(printing).toBeLessThanOrEqual(1);
  }

  for (const order of orders) {
    const queue = order.queue;
    const label = `order ${order.orderCode} (${order.orderStatus})`;

    switch (order.orderStatus) {
      case 'QUEUED':
        expect([label, queue?.queueStatus]).toEqual([label, 'WAITING']);
        break;
      case 'PRINTING':
        expect([label, queue?.queueStatus]).toEqual([label, 'PRINTING']);
        break;
      case 'READY':
      case 'COLLECTED':
        expect([label, queue?.queueStatus]).toEqual([label, 'COMPLETED']);
        break;
      case 'CANCELLED':
        expect([label, queue ? queue.queueStatus : 'CANCELLED']).toEqual([label, 'CANCELLED']);
        break;
      default:
        // PLACED / PAYMENT_CONFIRMED: never in the queue.
        expect([label, queue]).toEqual([label, null]);
    }

    // Every status is entered at most once per order.
    const seen = new Map<string, number>();
    for (const event of order.statusHistory) {
      seen.set(event.status, (seen.get(event.status) ?? 0) + 1);
    }
    for (const [status, occurrences] of seen) {
      expect([label, status, occurrences]).toEqual([label, status, 1]);
    }
  }
}
