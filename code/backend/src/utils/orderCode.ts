import { randomBytes } from 'node:crypto';

// Human-readable order token, e.g. "SP-LXK3F9-A1B2". Not the primary key
// (orderId is) and not used for FIFO ordering (that is Queue.queueNumber) - purely a display identifier. Collision-resistant
// enough in practice that a DB unique-constraint violation is treated as a
// genuine (astronomically unlikely) failure rather than retried.
export function generateOrderCode(): string {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = randomBytes(3).toString('hex').toUpperCase();
  return `SP-${timePart}-${randomPart}`;
}
