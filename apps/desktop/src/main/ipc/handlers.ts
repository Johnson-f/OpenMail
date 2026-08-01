import { ipcMain } from 'electron'
import type { MessageWithLabels, SyncStatus } from '@gmail/core'
import type { GmailApi } from '@gmail/gmail'
import { drainOutbox, runBackfill, runIncrementalSync } from '@gmail/sync'
import type { Db } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { getMessage, mailboxCounts } from '../db/messages'
import { effectiveLabels } from '../db/outbox'
import { listAccounts, type Encryptor } from '../auth/tokens'
import { signIn } from '../auth/signin'

export type Deps = {
  db: Db
  encryptor: Encryptor
  gmailFor(accountId: number): GmailApi
}

export function registerIpcHandlers(deps: Deps): void {
  const { db } = deps
  const store = new SqliteMailStore(db)

  ipcMain.handle('auth:signin', async () => {
    const accountId = await signIn(db, deps.encryptor)
    // Kick off the first download immediately; the UI polls sync:status.
    void runBackfill(store, accountId, deps.gmailFor(accountId)).catch((err: unknown) => {
      console.error(`Backfill failed for account ${accountId}:`, err)
    })
    return accountId
  })

  ipcMain.handle('accounts:list', () => listAccounts(db))

  ipcMain.handle('threads:list', (_e, accountId: number, labelId: string, limit: number) =>
    store.listThreads(accountId, labelId, limit),
  )

  ipcMain.handle(
    'thread:messages',
    (_e, accountId: number, threadId: string): MessageWithLabels[] => {
      const ids = db
        .prepare(
          'SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY internal_date',
        )
        .all(accountId, threadId)
        .map((r) => (r as { id: string }).id)

      return ids.flatMap((id) => {
        const m = getMessage(db, accountId, id)
        return m ? [{ ...m, effectiveLabelIds: effectiveLabels(db, accountId, id) }] : []
      })
    },
  )

  ipcMain.handle('mailboxes:counts', (_e, accountId: number, labelIds: string[]) =>
    mailboxCounts(db, accountId, labelIds),
  )

  ipcMain.handle('search:messages', (_e, accountId: number, query: string, limit: number) =>
    store.searchMessages(accountId, query, limit),
  )

  ipcMain.handle(
    'labels:modify',
    (_e, accountId: number, messageId: string, add: string[], remove: string[]) => {
      store.enqueueOutbox(accountId, messageId, add, remove)
      // Return the new effective state so the renderer re-renders instantly,
      // with no round trip to Gmail.
      return store.effectiveLabels(accountId, messageId)
    },
  )

  ipcMain.handle('sync:status', (_e, accountId: number): SyncStatus => {
    const account = db
      .prepare('SELECT backfill_complete AS c, needs_reauth AS r FROM accounts WHERE id = ?')
      .get(accountId) as { c: number; r: number } | undefined
    const fetched = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?')
      .get(accountId) as { n: number }
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE account_id = ? AND status IN ('pending','failed')",
      )
      .get(accountId) as { n: number }
    const lastError = db
      .prepare(
        "SELECT last_error AS e FROM outbox WHERE account_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      .get(accountId) as { e: string | null } | undefined

    return {
      accountId,
      backfillComplete: account?.c === 1,
      backfillFetched: fetched.n,
      pendingUploads: pending.n,
      needsReauth: account?.r === 1,
      lastError: lastError?.e ?? null,
    }
  })

  ipcMain.handle('sync:now', async (_e, accountId: number) => {
    const gmail = deps.gmailFor(accountId)
    // Upload first: a change sent now appears in the history page we are
    // about to read, instead of one sync cycle later.
    await drainOutbox(store, accountId, gmail)
    await runIncrementalSync(store, accountId, gmail)
  })
}
