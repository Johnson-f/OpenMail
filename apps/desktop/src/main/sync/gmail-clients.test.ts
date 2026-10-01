import { FakeGmail } from '@gmail/gmail'
import { describe, expect, it, vi } from 'vitest'
import { GmailClientCache } from './gmail-clients'

describe('GmailClientCache', () => {
  it('creates one client per account and reuses it', () => {
    const create = vi.fn(() => new FakeGmail())
    const cache = new GmailClientCache(create)

    expect(cache.get(1)).toBe(cache.get(1))
    expect(cache.get(2)).not.toBe(cache.get(1))
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('builds a fresh client after invalidation, for that account only', () => {
    const cache = new GmailClientCache(() => new FakeGmail())
    const first = cache.get(1)
    const other = cache.get(2)

    cache.invalidate(1)

    expect(cache.get(1)).not.toBe(first)
    expect(cache.get(2)).toBe(other)
  })
})
