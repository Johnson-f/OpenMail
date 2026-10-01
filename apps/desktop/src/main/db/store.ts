import type {
  Label,
  MailEventContext,
  MailStore,
  OutboxRow,
  SearchHit,
  StoredMessage,
  ThreadSummary,
} from '@gmail/core'
import type { Db } from './index.js'
import { beginResync, deleteMessage, getMessage, listThreads, sweepUnseen, upsertMessage } from './messages.js'
import { effectiveLabels, enqueue, pendingRows, markUploaded, markFailed, abandonRow } from './outbox.js'
import { searchMessages } from './search.js'

type AccountCursorRow = {
  history_id: string | null
  backfill_complete: number
  backfill_page_token: string | null
}

/**
 * Thin adapter over the functions in this directory so the sync engine
 * (`@gmail/sync`) never imports better-sqlite3 or writes SQL directly.
 */
export class SqliteMailStore implements MailStore {
  constructor(private readonly db: Db) {}

  upsertMessage(accountId: number, msg: StoredMessage, event?: MailEventContext): void {
    upsertMessage(this.db, accountId, msg, event)
  }

  deleteMessage(accountId: number, messageId: string, event?: MailEventContext): void {
    deleteMessage(this.db, accountId, messageId, event)
  }

  getMessage(accountId: number, messageId: string): StoredMessage | null {
    return getMessage(this.db, accountId, messageId)
  }

  beginResync(accountId: number): void {
    beginResync(this.db, accountId)
  }

  sweepUnseen(accountId: number): void {
    sweepUnseen(this.db, accountId)
  }

  upsertLabels(accountId: number, labels: Label[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type`
    )
    const tx = this.db.transaction((rows: Label[]) => {
      for (const label of rows) stmt.run(accountId, label.id, label.name, label.type)
    })
    tx(labels)
  }

  getSyncCursor(accountId: number): {
    historyId: string | null
    backfillComplete: boolean
    backfillPageToken: string | null
  } {
    const row = this.db
      .prepare(`SELECT history_id, backfill_complete, backfill_page_token FROM accounts WHERE id = ?`)
      .get(accountId) as AccountCursorRow | undefined

    if (!row) {
      return { historyId: null, backfillComplete: false, backfillPageToken: null }
    }
    return {
      historyId: row.history_id,
      backfillComplete: row.backfill_complete === 1,
      backfillPageToken: row.backfill_page_token,
    }
  }

  setHistoryId(accountId: number, historyId: string): void {
    this.db.prepare(`UPDATE accounts SET history_id = ? WHERE id = ?`).run(historyId, accountId)
  }

  setBackfillPageToken(accountId: number, token: string | null): void {
    this.db.prepare(`UPDATE accounts SET backfill_page_token = ? WHERE id = ?`).run(token, accountId)
  }

  setBackfillComplete(accountId: number, complete: boolean): void {
    this.db
      .prepare(`UPDATE accounts SET backfill_complete = ? WHERE id = ?`)
      .run(complete ? 1 : 0, accountId)
  }

  pendingOutbox(accountId: number): OutboxRow[] {
    return pendingRows(this.db, accountId)
  }

  markOutboxUploaded(id: number, historyId: string): void {
    markUploaded(this.db, id, historyId)
  }

  markOutboxFailed(id: number, error: string): void {
    markFailed(this.db, id, error)
  }

  abandonOutbox(id: number, error: string): void {
    abandonRow(this.db, id, error)
  }

  // Extras beyond the shared MailStore interface, used directly by the
  // desktop app's main-process IPC handlers.

  listThreads(accountId: number, labelId: string, limit: number): ThreadSummary[] {
    return listThreads(this.db, accountId, labelId, limit)
  }

  searchMessages(accountId: number, query: string, limit: number): SearchHit[] {
    return searchMessages(this.db, accountId, query, limit)
  }

  enqueueOutbox(accountId: number, messageId: string, add: string[], remove: string[]): number {
    return enqueue(this.db, accountId, messageId, add, remove)
  }

  effectiveLabels(accountId: number, messageId: string): string[] {
    return effectiveLabels(this.db, accountId, messageId)
  }
}
