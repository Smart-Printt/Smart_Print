// A fresh random key for one "place order" attempt. The backend accepts 8-128
// characters from A-Z a-z 0-9 . _ ~ : - (see backend utils/idempotency.ts).
// crypto.randomUUID() exists only in secure contexts (https / localhost), so a
// dev server opened over a LAN http address falls back to random hex.
export function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
