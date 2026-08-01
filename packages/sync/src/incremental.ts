import type { MailStore } from '@gmail/core'
import { HistoryExpiredError, type GmailApi } from '@gmail/gmail'
import { runBackfill } from './backfill'

export type IncrementalResult = { applied: number; resynced: boolean }

export async function runIncrementalSync(
  store: MailStore,
  accountId: number,
  gmail: GmailApi,
): Promise<IncrementalResult> {
  const cursor = store.getSyncCursor(accountId)
  if (!cursor.backfillComplete || !cursor.historyId) {
    throw new Error('Cannot sync incrementally before backfill has completed')
  }

  let page
  try {
    page = await gmail.listHistory(cursor.historyId)
  } catch (err) {
    if (err instanceof HistoryExpiredError) {
      // Gmail keeps history for roughly 30 days. Past that the delta path is
      // gone and the only correct move is to start over.
      store.setBackfillComplete(accountId, false)
      store.setBackfillPageToken(accountId, null)
      await runBackfill(store, accountId, gmail)
      return { applied: 0, resynced: true }
    }
    throw err
  }

  let applied = 0
  for (const change of page.changes) {
    if (change.type === 'messageDeleted') {
      store.deleteMessage(accountId, change.messageId)
      applied += 1
      continue
    }

    // History records carry only ids and label deltas. Rather than applying
    // the delta blind, re-fetch: Gmail's copy is authoritative, and this is
    // the only version that stays correct when several changes to the same
    // message land in one page.
    store.upsertMessage(accountId, await gmail.getMessage(change.messageId))
    applied += 1
  }

  store.setHistoryId(accountId, page.historyId)

  return { applied, resynced: false }
}
