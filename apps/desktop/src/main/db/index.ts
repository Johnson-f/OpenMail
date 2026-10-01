import Database from 'better-sqlite3'
import schemaSql from './migrations/schema.sql?raw'
import indexSchemaSql from './migrations/index-schema.sql?raw'
import agentSchemaSql from './migrations/agent-schema.sql?raw'
import agent002Sql from './migrations/agent-002-writing-profile.sql?raw'
import agent003Sql from './migrations/agent-003-automation-simulation.sql?raw'
import agent004Sql from './migrations/agent-004-scheduler-retries.sql?raw'
import mail002Sql from './migrations/mail-002-message-metadata.sql?raw'
import mail003Sql from './migrations/mail-003-events.sql?raw'
import mail004Sql from './migrations/mail-004-drafts-and-send-ledger.sql?raw'
import mail005Sql from './migrations/mail-005-sync-epochs-and-counts.sql?raw'
import mail006Sql from './migrations/mail-006-event-cursors.sql?raw'
import index002Sql from './migrations/index-002-fingerprints.sql?raw'
import agent005Sql from './migrations/agent-005-automation-reliability.sql?raw'
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  applyMigrations,
  appliedMigrationVersion,
  type Migration,
} from './migrations/migrations.js'

export type Db = Database.Database

const MAIL_MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-mail-schema', sql: schemaSql },
  { version: 2, name: 'message-metadata-and-attachments', sql: mail002Sql },
  { version: 3, name: 'mail-events-and-sync-errors', sql: mail003Sql },
  { version: 4, name: 'drafts-and-send-ledger', sql: mail004Sql },
  { version: 5, name: 'sync-epochs-and-counts', sql: mail005Sql },
  { version: 6, name: 'event-cursors', sql: mail006Sql },
]
const INDEX_MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-index-schema', sql: indexSchemaSql },
  { version: 2, name: 'fingerprints', sql: index002Sql },
]
const AGENT_MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-agent-schema', sql: agentSchemaSql },
  { version: 2, name: 'writing-profile-edits', sql: agent002Sql },
  { version: 3, name: 'automation-simulations', sql: agent003Sql },
  { version: 4, name: 'scheduler-retries', sql: agent004Sql },
  { version: 5, name: 'automation-reliability', sql: agent005Sql },
]

type OpenOptions = {
  rebuildOnMigrationFailure?: boolean
  backupBeforeMigration?: boolean
}

function configure(db: Db): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}

const SIDECAR_SUFFIXES = ['-wal', '-shm']

const cleanShutdownMarker = (path: string): string => `${path}.clean-shutdown`

/** Written on `before-quit` after the database is closed; its absence at the next open means the last run did not exit cleanly. */
export function markCleanShutdown(path: string): void {
  if (path !== ':memory:') writeFileSync(cleanShutdownMarker(path), String(Date.now()))
}

function removeSidecars(path: string): void {
  for (const suffix of SIDECAR_SUFFIXES) rmSync(`${path}${suffix}`, { force: true })
}

function renameWithSidecars(path: string, target: string): void {
  renameSync(path, target)
  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${target}${suffix}`)
  }
}

export function openManagedDatabase(
  path: string,
  migrations: Migration[],
  opts: OpenOptions = {},
): Db {
  const fileBacked = path !== ':memory:'
  const existed = fileBacked && existsSync(path)
  const shutDownCleanly = fileBacked && existsSync(cleanShutdownMarker(path))
  if (fileBacked) rmSync(cleanShutdownMarker(path), { force: true })

  const backupPath = `${path}.pre-v${migrations.length}`
  let backupCreated = false
  let db: Db | null = null

  try {
    db = new Database(path)
    configure(db)

    if (fileBacked && !shutDownCleanly) {
      const quick = db.pragma('quick_check', { simple: true }) as string
      if (quick !== 'ok') throw new Error(`Database integrity check failed: ${quick}`)
    }

    const needsMigration = appliedMigrationVersion(db) < migrations.length
    if (existed && needsMigration && opts.backupBeforeMigration) {
      db.pragma('wal_checkpoint(TRUNCATE)')
      copyFileSync(path, backupPath)
      backupCreated = true
    }

    applyMigrations(db, migrations)
    return db
  } catch (error) {
    db?.close()
    if (fileBacked && opts.rebuildOnMigrationFailure) {
      if (existsSync(path)) renameWithSidecars(path, `${path}.failed-${Date.now()}`)
      else removeSidecars(path)
      const rebuilt = new Database(path)
      configure(rebuilt)
      applyMigrations(rebuilt, migrations)
      return rebuilt
    }
    if (backupCreated) {
      removeSidecars(path)
      copyFileSync(backupPath, path)
    }
    throw error
  }
}

/**
 * Opens (or creates) a SQLite database at `path` and applies the schema.
 * `path` may be `':memory:'`, which better-sqlite3 gives a fresh, isolated
 * in-memory database for on every call — this is what every test uses.
 */
export function openDatabase(path: string): Db {
  return openManagedDatabase(path, MAIL_MIGRATIONS, { backupBeforeMigration: true })
}

export function openIndexDatabase(path: string): Db {
  return openManagedDatabase(path, INDEX_MIGRATIONS, { rebuildOnMigrationFailure: true })
}

export function openAgentDatabase(path: string): Db {
  return openManagedDatabase(path, AGENT_MIGRATIONS, { backupBeforeMigration: true })
}
