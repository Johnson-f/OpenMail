import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  markCleanShutdown,
  openAgentDatabase,
  openDatabase,
  openIndexDatabase,
  openManagedDatabase,
  type Db,
} from './index.js'

describe('openDatabase', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => db.close())

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
    const schemaPath = join(import.meta.dirname, 'migrations', 'schema.sql')
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
    other.close()
  })

  it('records the applied mail migration exactly once', () => {
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'initial-mail-schema' },
      { version: 2, name: 'message-metadata-and-attachments' },
      { version: 3, name: 'mail-events-and-sync-errors' },
      { version: 4, name: 'drafts-and-send-ledger' },
      { version: 5, name: 'sync-epochs-and-counts' },
      { version: 6, name: 'event-cursors' },
    ])
  })
})

describe('AI databases', () => {
  it('opens the rebuildable index schema', () => {
    const db = openIndexDatabase(':memory:')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining(['chunks', 'chunks_fts', 'index_jobs', 'index_generations']))
    db.close()
  })

  it('opens the durable agent schema', () => {
    const db = openAgentDatabase(':memory:')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]).map((row) => row.name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'conversations',
        'action_intents',
        'audit_events',
        'automation_versions',
        'writing_profiles',
      ]),
    )
    db.close()
  })
})

describe('opening a database file safely', () => {
  let dir: string
  let path: string

  const bulkMigration = {
    version: 1,
    name: 'bulk',
    sql: `CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT);
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
          INSERT INTO t (x) SELECT printf('%0100d', i) FROM n;`,
  }
  const addColumn = { version: 2, name: 'add-y', sql: 'ALTER TABLE t ADD COLUMN y TEXT' }
  const brokenMigration = { version: 2, name: 'broken', sql: 'ALTER TABLE t ADD COLUMN z TEXT; SELECT * FROM nope;' }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openmail-db-'))
    path = join(dir, 'test.db')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function createDatabase(migrations = [bulkMigration]): void {
    openManagedDatabase(path, migrations).close()
    markCleanShutdown(path)
  }

  function corruptLastPage(): void {
    const fd = openSync(path, 'r+')
    const size = fstatSync(fd).size
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, size - 4096)
    closeSync(fd)
  }

  it('restores the backup it made when a migration fails, and clears stale sidecars', () => {
    createDatabase()
    const before = readFileSync(path)

    expect(() => openManagedDatabase(path, [bulkMigration, brokenMigration], { backupBeforeMigration: true })).toThrow()

    expect(readFileSync(path).equals(before)).toBe(true)
    expect(existsSync(`${path}.pre-v2`)).toBe(true)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    const db = new Database(path)
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 })
    db.close()
  })

  it('does not restore an older backup when no migration is pending', () => {
    createDatabase()
    rmSync(`${path}.clean-shutdown`)
    writeFileSync(`${path}.pre-v1`, 'stale backup from an earlier launch')
    corruptLastPage()
    const corrupted = readFileSync(path)

    expect(() => openManagedDatabase(path, [bulkMigration], { backupBeforeMigration: true })).toThrow(/integrity/i)

    expect(readFileSync(path).equals(corrupted)).toBe(true)
    expect(readFileSync(`${path}.pre-v1`, 'utf8')).toBe('stale backup from an earlier launch')
  })

  it('names the backup after the target version and overwrites a stale one', () => {
    createDatabase()
    writeFileSync(`${path}.pre-v2`, 'stale')

    openManagedDatabase(path, [bulkMigration, addColumn], { backupBeforeMigration: true }).close()

    expect(readFileSync(`${path}.pre-v2`).subarray(0, 15).toString()).toBe('SQLite format 3')
  })

  it('runs a quick check when the previous run did not shut down cleanly', () => {
    createDatabase()
    corruptLastPage()
    rmSync(`${path}.clean-shutdown`)

    expect(() => openManagedDatabase(path, [bulkMigration])).toThrow(/integrity/i)
  })

  it('skips the check after a clean shutdown and consumes the marker', () => {
    createDatabase()
    corruptLastPage()
    expect(existsSync(`${path}.clean-shutdown`)).toBe(true)

    const db = openManagedDatabase(path, [bulkMigration])

    expect(existsSync(`${path}.clean-shutdown`)).toBe(false)
    db.close()
    expect(() => openManagedDatabase(path, [bulkMigration])).toThrow(/integrity/i)
  })

  it('never writes a marker for in-memory databases', () => {
    expect(() => markCleanShutdown(':memory:')).not.toThrow()
    expect(existsSync(':memory:.clean-shutdown')).toBe(false)
  })

  it('rebuilds a corrupted rebuildable database, keeping the old file aside', () => {
    createDatabase()
    corruptLastPage()
    rmSync(`${path}.clean-shutdown`)

    const db = openManagedDatabase(path, [bulkMigration], { rebuildOnMigrationFailure: true })

    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3000 })
    db.close()
    expect(readdirSync(dir).some((name) => /\.failed-\d+$/.test(name))).toBe(true)
  })
})
