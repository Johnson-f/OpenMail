import type { Db } from './index'

export const INDEXER_CONSUMER = 'indexer'
export const AUTOMATION_CONSUMER = 'automation-dispatch'
const KNOWN_CONSUMERS = [INDEXER_CONSUMER, AUTOMATION_CONSUMER]

export type CursorEvent = {
  id: number
  event_key: string
  account_id: number
  message_id: string
  thread_id: string | null
  kind: string
  origin: string
  payload_json: string
  created_at: number
}

export function readCursor(db: Db, consumer: string): number {
  const row = db.prepare('SELECT last_event_id FROM event_cursors WHERE consumer = ?').get(consumer) as
    | { last_event_id: number }
    | undefined
  return row?.last_event_id ?? 0
}

export function advanceCursor(db: Db, consumer: string, eventId: number, now = Date.now()): void {
  db.prepare(
    `INSERT INTO event_cursors (consumer, last_event_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(consumer) DO UPDATE SET
       last_event_id = MAX(last_event_id, excluded.last_event_id), updated_at = excluded.updated_at`,
  ).run(consumer, eventId, now)
}

export function eventsAfter(db: Db, consumer: string, limit: number): CursorEvent[] {
  return db
    .prepare(
      `SELECT id, event_key, account_id, message_id, thread_id, kind, origin, payload_json, created_at
       FROM mail_events WHERE id > ? ORDER BY id LIMIT ?`,
    )
    .all(readCursor(db, consumer), limit) as CursorEvent[]
}

export function pendingCount(db: Db, consumer: string): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM mail_events WHERE id > ?').get(readCursor(db, consumer)) as {
    count: number
  }).count
}

export function pruneEvents(db: Db, olderThanMs: number, now = Date.now()): number {
  const floor = Math.min(...KNOWN_CONSUMERS.map((consumer) => readCursor(db, consumer)))
  if (floor <= 0) return 0
  return Number(db.prepare('DELETE FROM mail_events WHERE id <= ? AND created_at < ?').run(floor, now - olderThanMs).changes)
}
