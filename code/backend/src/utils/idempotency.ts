import { createHash } from 'node:crypto';

import { ValidationError } from './errors';

// Same pattern as the CHECK constraint orders_idempotency_key_format (see the
// order_idempotency migration). A UUID fits; so does any opaque token a
// client generates once per "place order" attempt.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]{8,128}$/;

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

// The header is optional. A header that is present but malformed is rejected
// instead of silently ignored: a client that believes it is protected against
// duplicates must never be quietly unprotected. Node joins a repeated header
// with ", ", which the pattern rejects as well.
export function parseIdempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new ValidationError(
      `${IDEMPOTENCY_KEY_HEADER} must be 8-128 characters from A-Z a-z 0-9 . _ ~ : -`,
    );
  }
  return header;
}

// Mirrors how order creation reads these optional text fields (see
// pricing.service.ts::resolvePageRange / resolveFinishingRule and
// order.service.ts::resolveOrderItem): missing, null, empty and
// whitespace-only all mean "not set", and surrounding whitespace is ignored.
function normalizeOptionalText(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  return value;
}

// SHA-256 over a normalized, canonical form of the order request, so a retry
// of the same request hashes identically no matter how the client ordered the
// JSON properties or whether it sent an optional field as absent, null or
// empty, while any change to what would be ordered (shop, documents, copies,
// print type/size/sides, page range, finishing option, instructions, item
// order) changes the hash. Only the fields order creation actually reads are
// included - anything else the client sends is ignored by the server, so it
// must not make two identical orders look different. Prices are never request
// fields: they are resolved from the database at creation time.
export function hashCreateOrderRequest(shopId: unknown, items: unknown[]): string {
  const canonicalItems = items.map((raw) => {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    return [
      item.documentId,
      item.copies,
      item.printType,
      item.paperSize,
      item.sides,
      normalizeOptionalText(item.pageRange),
      normalizeOptionalText(item.finishingRuleId),
      normalizeOptionalText(item.specialInstructions),
    ];
  });
  return createHash('sha256')
    .update(JSON.stringify([shopId ?? null, canonicalItems]))
    .digest('hex');
}
