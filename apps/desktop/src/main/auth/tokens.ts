import type Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import type { AccountRow } from '@gmail/core'

export type Encryptor = {
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

type AccountRowRaw = {
  id: number
  email: string
  encrypted_refresh_token: Buffer
  needs_reauth: number
}

/**
 * Upserts an account by email, storing the (encrypted) refresh token and
 * clearing needs_reauth. Returns the account id whether the row was just
 * created or already existed.
 */
export function saveAccount(
  db: Database.Database,
  enc: Encryptor,
  email: string,
  refreshToken: string,
): number {
  const encrypted = enc.encryptString(refreshToken)

  const existing = db.prepare<[string], { id: number }>('SELECT id FROM accounts WHERE email = ?').get(email)

  if (existing) {
    db.prepare('UPDATE accounts SET encrypted_refresh_token = ?, needs_reauth = 0 WHERE id = ?').run(
      encrypted,
      existing.id,
    )
    return existing.id
  }

  // created_at is NOT NULL with no default in the real schema, and every
  // timestamp in this project is INTEGER Unix milliseconds.
  const result = db
    .prepare(
      'INSERT INTO accounts (email, encrypted_refresh_token, needs_reauth, created_at) VALUES (?, ?, 0, ?)',
    )
    .run(email, encrypted, Date.now())

  return Number(result.lastInsertRowid)
}

export function loadRefreshToken(db: Database.Database, enc: Encryptor, accountId: number): string {
  const row = db
    .prepare<[number], { encrypted_refresh_token: Buffer }>(
      'SELECT encrypted_refresh_token FROM accounts WHERE id = ?',
    )
    .get(accountId)

  if (!row) {
    throw new Error(`No account found with id ${accountId}`)
  }

  return enc.decryptString(row.encrypted_refresh_token)
}

export function markNeedsReauth(db: Database.Database, accountId: number): void {
  db.prepare('UPDATE accounts SET needs_reauth = 1 WHERE id = ?').run(accountId)
}

export function listAccounts(db: Database.Database): AccountRow[] {
  const rows = db
    .prepare<[], AccountRowRaw>('SELECT id, email, encrypted_refresh_token, needs_reauth FROM accounts')
    .all()

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    needsReauth: row.needs_reauth === 1,
  }))
}

/**
 * Wraps Electron's safeStorage. Requires electron lazily (via
 * createRequire, since this file is ESM) so this module can be imported
 * from a Vitest process, which cannot load electron at all.
 */
export function electronEncryptor(): Encryptor {
  const require = createRequire(import.meta.url)
  const { safeStorage } = require('electron') as typeof import('electron')

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable (safeStorage.isEncryptionAvailable() === false). ' +
        'Refusing to store refresh tokens in plaintext.',
    )
  }

  return {
    encryptString(plain: string): Buffer {
      return safeStorage.encryptString(plain)
    },
    decryptString(cipher: Buffer): string {
      return safeStorage.decryptString(cipher)
    },
  }
}

/**
 * True only when Google has actually revoked/invalidated the refresh token
 * (`invalid_grant`). Network blips (ECONNRESET) and rate limits (429) must
 * return false here, or a dropped connection would sign the user out.
 */
export function isRevokedTokenError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const asRecord = err as Record<string, unknown>

  const response = asRecord.response
  if (response && typeof response === 'object') {
    const data = (response as Record<string, unknown>).data
    if (data && typeof data === 'object') {
      const error = (data as Record<string, unknown>).error
      if (error === 'invalid_grant') return true
    }
  }

  const message = asRecord.message
  if (typeof message === 'string' && /invalid_grant/i.test(message)) {
    return true
  }

  return false
}
