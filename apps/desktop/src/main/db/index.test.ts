import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './index.js'

describe('openDatabase', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  it('creates every expected table', () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)

    for (const table of [
      'accounts',
      'threads',
      'messages',
      'labels',
      'message_labels',
      'attachments',
      'outbox',
    ]) {
      expect(names).toContain(table)
    }
  })

  it('creates the messages_fts virtual table', () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
      .all()
    expect(rows).toHaveLength(1)
  })

  it('enables foreign key enforcement', () => {
    const value = db.pragma('foreign_keys', { simple: true })
    expect(value).toBe(1)
  })

  it('is safe to re-run the schema against an already-initialized db', () => {
    const schemaPath = join(import.meta.dirname, 'schema.sql')
    const schema = readFileSync(schemaPath, 'utf-8')
    expect(() => db.exec(schema)).not.toThrow()
  })

  it('gives a fresh, isolated database for every :memory: call', () => {
    db.prepare(
      `INSERT INTO accounts (email, encrypted_refresh_token, created_at) VALUES (?, ?, ?)`
    ).run('a@example.com', Buffer.from('token'), Date.now())

    const other = openDatabase(':memory:')
    const rows = other.prepare(`SELECT * FROM accounts`).all()
    expect(rows).toHaveLength(0)
  })
})
