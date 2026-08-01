import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../db/index'
import {
  isRevokedTokenError,
  listAccounts,
  loadRefreshToken,
  markNeedsReauth,
  saveAccount,
  type Encryptor,
} from './tokens'

// Reversible fake so tests can assert round-tripping without touching
// Electron's safeStorage (unavailable outside a real Electron process).
// Reversible but not a mere passthrough: base64-encodes the plaintext so
// the raw token text never literally appears in the "encrypted" bytes.
function fakeEncryptor(): Encryptor {
  return {
    encryptString(plain: string): Buffer {
      return Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
    },
    decryptString(cipher: Buffer): string {
      const str = cipher.toString('utf8')
      if (!str.startsWith('enc:')) throw new Error('not encrypted by fakeEncryptor')
      return Buffer.from(str.slice('enc:'.length), 'base64').toString('utf8')
    },
  }
}

/**
 * Use the REAL schema, not a hand-written stand-in.
 *
 * These tests originally defined their own `accounts` table, which drifted
 * from production in two ways: it gave `created_at` a DEFAULT (the real
 * schema has none) and typed it TEXT (the real one is INTEGER Unix ms).
 * Every test passed and sign-in then failed on the first run with
 * "NOT NULL constraint failed: accounts.created_at". A test double of your
 * own schema is a test of nothing.
 */
function createTestDb(): Database.Database {
  return openDatabase(':memory:')
}

describe('saveAccount / loadRefreshToken', () => {
  let db: Database.Database
  let enc: Encryptor

  beforeEach(() => {
    db = createTestDb()
    enc = fakeEncryptor()
  })

  it('round-trips the refresh token through save and load', () => {
    const id = saveAccount(db, enc, 'user@example.com', 'refresh-token-123')
    expect(loadRefreshToken(db, enc, id)).toBe('refresh-token-123')
  })

  it('never stores the plaintext token in the BLOB column', () => {
    const id = saveAccount(db, enc, 'user@example.com', 'super-secret-token')

    const row = db
      .prepare<[number], { encrypted_refresh_token: Buffer }>(
        'SELECT encrypted_refresh_token FROM accounts WHERE id = ?',
      )
      .get(id)

    expect(row).toBeDefined()
    const stored = row!.encrypted_refresh_token.toString('utf8')
    expect(stored).not.toBe('super-secret-token')
    expect(stored).not.toContain('super-secret-token')
  })

  it('re-signin replaces the token and returns the same account id', () => {
    const id1 = saveAccount(db, enc, 'user@example.com', 'first-token')
    const id2 = saveAccount(db, enc, 'user@example.com', 'second-token')

    expect(id2).toBe(id1)
    expect(loadRefreshToken(db, enc, id1)).toBe('second-token')
  })

  it('re-signin clears needs_reauth', () => {
    const id = saveAccount(db, enc, 'user@example.com', 'first-token')
    markNeedsReauth(db, id)

    expect(listAccounts(db).find((a) => a.id === id)?.needsReauth).toBe(true)

    saveAccount(db, enc, 'user@example.com', 'new-token')

    expect(listAccounts(db).find((a) => a.id === id)?.needsReauth).toBe(false)
  })

  it('throws a clear error for an unknown account', () => {
    expect(() => loadRefreshToken(db, enc, 999)).toThrow(/999/)
  })

  it('sets created_at to an integer timestamp', () => {
    // Regression: the column is NOT NULL with no default, so an INSERT that
    // omits it fails at runtime. Every timestamp in this project is INTEGER
    // Unix milliseconds, never an ISO string.
    const before = Date.now()
    const id = saveAccount(db, enc, 'user@example.com', 'token')
    const after = Date.now()

    const row = db
      .prepare<[number], { created_at: unknown }>(
        'SELECT created_at FROM accounts WHERE id = ?',
      )
      .get(id)

    expect(typeof row!.created_at).toBe('number')
    expect(row!.created_at as number).toBeGreaterThanOrEqual(before)
    expect(row!.created_at as number).toBeLessThanOrEqual(after)
  })
})

describe('listAccounts', () => {
  it('maps db rows to AccountRow', () => {
    const db = createTestDb()
    const enc = fakeEncryptor()
    const id = saveAccount(db, enc, 'user@example.com', 'token')

    const accounts = listAccounts(db)
    expect(accounts).toEqual([{ id, email: 'user@example.com', needsReauth: false }])
  })
})

describe('markNeedsReauth', () => {
  it('flips needs_reauth to true for the given account', () => {
    const db = createTestDb()
    const enc = fakeEncryptor()
    const id = saveAccount(db, enc, 'user@example.com', 'token')

    markNeedsReauth(db, id)

    expect(listAccounts(db)[0]?.needsReauth).toBe(true)
  })
})

describe('isRevokedTokenError', () => {
  it('is true for a Google invalid_grant response body', () => {
    const err = { response: { data: { error: 'invalid_grant' } } }
    expect(isRevokedTokenError(err)).toBe(true)
  })

  it('is true for an invalid_grant message', () => {
    const err = new Error('invalid_grant: Token has been expired or revoked.')
    expect(isRevokedTokenError(err)).toBe(true)
  })

  it('is false for a network error like ECONNRESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(isRevokedTokenError(err)).toBe(false)
  })

  it('is false for a 429 rate limit error', () => {
    const err = { response: { status: 429, data: { error: 'rate_limit_exceeded' } } }
    expect(isRevokedTokenError(err)).toBe(false)
  })
})
