import type Database from 'better-sqlite3'

export type Migration = {
  version: number
  name: string
  sql: string
}

type AppliedRow = { version: number; name: string }

export function appliedMigrationVersion(db: Database.Database): number {
  const hasTable = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { found: number } | undefined
  if (!hasTable) return 0
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
    version: number
  }
  return row.version
}

export function applyMigrations(db: Database.Database, migrations: Migration[]): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (let i = 0; i < ordered.length; i += 1) {
    const expected = i + 1
    if (ordered[i]?.version !== expected) {
      throw new Error(`Migrations must be contiguous from 1; expected ${expected}`)
    }
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  )

  const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as AppliedRow[]
  for (const row of applied) {
    const migration = ordered.find((item) => item.version === row.version)
    if (!migration || migration.name !== row.name) {
      throw new Error(`Applied migration ${row.version}:${row.name} does not match this build`)
    }
  }

  const run = db.transaction((migration: Migration) => {
    db.exec(migration.sql)
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      Date.now(),
    )
  })

  const current = applied.at(-1)?.version ?? 0
  for (const migration of ordered) {
    if (migration.version > current) run(migration)
  }
}
