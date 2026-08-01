import Database from 'better-sqlite3'
// `?raw` inlines the file's contents at build time. Reading it from disk at
// runtime instead would pass every test (Vitest resolves against source) and
// then fail in the packaged app, where the .sql file is not copied into out/.
import schemaSql from './schema.sql?raw'

export type Db = Database.Database

/**
 * Opens (or creates) a SQLite database at `path` and applies the schema.
 * `path` may be `':memory:'`, which better-sqlite3 gives a fresh, isolated
 * in-memory database for on every call — this is what every test uses.
 */
export function openDatabase(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(schemaSql)

  return db
}
