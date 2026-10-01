import type { MailStore } from '@gmail/core'
import { HistoryExpiredError, MessageNotFoundError, type GmailApi, type HistoryChange } from '@gmail/gmail'
import { runBackfill } from './backfill'

export type IncrementalResult = { applied: number; resynced: boolean }

type CollapsedChange = { last: HistoryChange; sawAdded: boolean }

function collapseByMessage(changes: HistoryChange[]): Map<string, CollapsedChange> {
  const collapsed = new Map<string, CollapsedChange>()
  for (const change of changes) {
    const existing = collapsed.get(change.messageId)
    collapsed.set(change.messageId, {
      last: change,
      sawAdded: (existing?.sawAdded ?? false) || change.type === 'messageAdded',
    })
  }
  return collapsed
}

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
      store.beginResync(accountId)
      store.setBackfillComplete(accountId, false)
      store.setBackfillPageToken(accountId, null)
      const profile = await gmail.getProfile()
      store.setHistoryId(accountId, profile.historyId)
      await runBackfill(store, accountId, gmail)
      return { applied: 0, resynced: true }
    }
    throw err
  }

  let applied = 0
  for (const [messageId, { last, sawAdded }] of collapseByMessage(page.changes)) {
    const event = {
      eventKey: `incremental:${accountId}:${page.historyId}:${messageId}`,
      origin: 'incremental' as const,
      historyId: page.historyId,
      payload: { type: last.type !== 'messageDeleted' && sawAdded ? 'messageAdded' : last.type },
    }
    applied += 1
    if (last.type === 'messageDeleted') {
      store.deleteMessage(accountId, messageId, event)
      continue
    }

    // History records carry only ids and label deltas. Rather than applying
    // the delta blind, re-fetch: Gmail's copy is authoritative, and this is
    // the only version that stays correct when several changes to the same
    // message land in one page.
    try {
      store.upsertMessage(accountId, await gmail.getMessage(messageId), event)
    } catch (err) {
      if (!(err instanceof MessageNotFoundError)) throw err
      store.deleteMessage(accountId, messageId, event)
    }
  }

  store.setHistoryId(accountId, page.historyId)

  return { applied, resynced: false }
}
