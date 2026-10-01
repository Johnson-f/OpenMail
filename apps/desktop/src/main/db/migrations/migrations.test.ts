import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from './migrations.js'
import schemaSql from './schema.sql?raw'
import mail002Sql from './mail-002-message-metadata.sql?raw'
import mail003Sql from './mail-003-events.sql?raw'
import mail004Sql from './mail-004-drafts-and-send-ledger.sql?raw'
import mail005Sql from './mail-005-sync-epochs-and-counts.sql?raw'
import mail006Sql from './mail-006-event-cursors.sql?raw'

describe('applyMigrations', () => {
  it('applies contiguous migrations once and preserves data', () => {
    const db = new Database(':memory:')
    const migrations = [
      { version: 1, name: 'one', sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)' },
      { version: 2, name: 'two', sql: 'ALTER TABLE example ADD COLUMN extra TEXT' },
    ]

    applyMigrations(db, migrations)
    db.prepare('INSERT INTO example (value, extra) VALUES (?, ?)').run('kept', 'yes')
    applyMigrations(db, migrations)

    expect(db.prepare('SELECT value, extra FROM example').get()).toEqual({ value: 'kept', extra: 'yes' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 2 })
    db.close()
  })

  it('rolls back a failed migration', () => {
    const db = new Database(':memory:')
    applyMigrations(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE stable (id INTEGER)' }])

    expect(() =>
      applyMigrations(db, [
        { version: 1, name: 'one', sql: 'CREATE TABLE stable (id INTEGER)' },
        { version: 2, name: 'bad', sql: 'CREATE TABLE transient (id INTEGER); invalid sql' },
      ]),
    ).toThrow()

    const transient = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transient'")
      .get()
    expect(transient).toBeUndefined()
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 1 })
    db.close()
  })

  it('rejects non-contiguous migration lists', () => {
    const db = new Database(':memory:')
    expect(() => applyMigrations(db, [{ version: 2, name: 'two', sql: 'SELECT 1' }])).toThrow(
      /contiguous/,
    )
    db.close()
  })

  it('seeds event cursors from consumer rows and drops the per-event table', () => {
    const db = new Database(':memory:')
    const upTo5 = [
      { version: 1, name: 'one', sql: schemaSql },
      { version: 2, name: 'two', sql: mail002Sql },
      { version: 3, name: 'three', sql: mail003Sql },
      { version: 4, name: 'four', sql: mail004Sql },
      { version: 5, name: 'five', sql: mail005Sql },
    ]
    applyMigrations(db, upTo5)
    const insert = db.prepare("INSERT INTO mail_event_consumers (consumer, event_id, processed_at) VALUES (?, ?, ?)")
    for (const id of [1, 2, 3, 7]) insert.run('indexer', id, 100 + id)
    insert.run('automation-dispatch', 2, 50)

    applyMigrations(db, [...upTo5, { version: 6, name: 'six', sql: mail006Sql }])

    expect(db.prepare('SELECT consumer, last_event_id FROM event_cursors ORDER BY consumer').all()).toEqual([
      { consumer: 'automation-dispatch', last_event_id: 2 },
      { consumer: 'indexer', last_event_id: 7 },
    ])
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'mail_event_consumers'").get(),
    ).toBeUndefined()
    db.close()
  })
})
