import type { OutboxRow } from '@gmail/core'
import type { Db } from './index.js'

export function enqueue(
  db: Db,
  accountId: number,
  messageId: string,
  add: string[],
  remove: string[]
): number {
  if (add.length === 0 && remove.length === 0) {
    throw new Error('enqueue requires at least one label to add or remove')
  }
  if (add.some((label) => remove.includes(label))) {
    throw new Error('add and remove label sets must not overlap')
  }

  const info = db
    .prepare(
      `INSERT INTO outbox (account_id, message_id, add_labels, remove_labels, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`
    )
    .run(accountId, messageId, JSON.stringify(add), JSON.stringify(remove), Date.now())

  return Number(info.lastInsertRowid)
}

/**
 * The conflict rule: start from the stored labels, then replay every
 * pending/failed outbox row for this message in id order (removes then
 * adds). Incremental sync overwrites `message_labels` with Gmail's state at
 * any moment; because local changes are replayed on top rather than merged
 * into that row, a sync can never clobber a change that hasn't uploaded
 * yet. This is only safe because Gmail label ops are idempotent set
 * operations. Abandoned rows are excluded — they are no longer replayed.
 */
export function effectiveLabels(db: Db, accountId: number, messageId: string): string[] {
  const storedRows = db
    .prepare(`SELECT label_id FROM message_labels WHERE account_id = ? AND message_id = ?`)
    .all(accountId, messageId) as { label_id: string }[]
  const labels = new Set(storedRows.map((r) => r.label_id))

  const outboxRows = db
    .prepare(
      `SELECT add_labels, remove_labels FROM outbox
       WHERE account_id = ? AND message_id = ? AND status IN ('pending', 'failed')
       ORDER BY id ASC`
    )
    .all(accountId, messageId) as { add_labels: string; remove_labels: string }[]

  for (const row of outboxRows) {
    const removes: string[] = JSON.parse(row.remove_labels)
    const adds: string[] = JSON.parse(row.add_labels)
    for (const label of removes) labels.delete(label)
    for (const label of adds) labels.add(label)
  }

  return Array.from(labels).sort()
}

type OutboxTableRow = {
  id: number
  message_id: string
  add_labels: string
  remove_labels: string
  attempts: number
}

export function pendingRows(db: Db, accountId: number): OutboxRow[] {
  const rows = db
    .prepare(
      `SELECT id, message_id, add_labels, remove_labels, attempts FROM outbox
       WHERE account_id = ? AND status IN ('pending', 'failed')
       ORDER BY id ASC`
    )
    .all(accountId) as OutboxTableRow[]

  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    add: JSON.parse(r.add_labels),
    remove: JSON.parse(r.remove_labels),
    attempts: r.attempts,
  }))
}

export function markUploaded(db: Db, id: number, historyId: string): void {
  db.prepare(`UPDATE outbox SET status = 'uploaded', uploaded_at_history_id = ? WHERE id = ?`).run(
    historyId,
    id
  )
}

export function markFailed(db: Db, id: number, error: string): void {
  db.prepare(
    `UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`
  ).run(error, id)
}

export function abandonRow(db: Db, id: number, error: string): void {
  db.prepare(
    `UPDATE outbox SET status = 'abandoned', attempts = attempts + 1, last_error = ? WHERE id = ?`
  ).run(error, id)
}
