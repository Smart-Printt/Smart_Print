import { afterEach, describe, expect, it, vi } from 'vitest'

import { createIdempotencyKey } from './idempotencyKey'

const ACCEPTED_BY_BACKEND = /^[A-Za-z0-9._~:-]{8,128}$/

describe('createIdempotencyKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a different key every time, in the format the backend accepts', () => {
    const keys = new Set(Array.from({ length: 50 }, () => createIdempotencyKey()))
    expect(keys.size).toBe(50)
    for (const key of keys) {
      expect(key).toMatch(ACCEPTED_BY_BACKEND)
    }
  })

  it('still works where crypto.randomUUID is unavailable (insecure context)', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(createIdempotencyKey()).toMatch(ACCEPTED_BY_BACKEND)
  })
})
