import type { OutboxRow } from '@gmail/core'
import type { Db } from './index.js'
import { applyLabelChange } from './messages.js'

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

  const addJson = JSON.stringify(add)
  const removeJson = JSON.stringify(remove)
  const tx = db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO outbox (account_id, message_id, add_labels, remove_labels, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`
      )
      .run(accountId, messageId, addJson, removeJson, Date.now())
    const exists = db.prepare(`SELECT 1 FROM messages WHERE account_id = ? AND id = ?`).get(accountId, messageId)
    if (exists) applyLabelChange(db, accountId, messageId, [{ add_labels: addJson, remove_labels: removeJson }])
    return Number(info.lastInsertRowid)
  })
  return tx()
}

/**
 * Labels already include unuploaded local changes: `enqueue` applies them
 * and `upsertMessage` replays them over Gmail's labels.
 */
export function effectiveLabels(db: Db, accountId: number, messageId: string): string[] {
  const rows = db
    .prepare(`SELECT label_id FROM message_labels WHERE account_id = ? AND message_id = ? ORDER BY label_id ASC`)
    .all(accountId, messageId) as { label_id: string }[]
  return rows.map((r) => r.label_id)
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
