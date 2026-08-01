import type { MailStore } from '@gmail/core'
import type { GmailApi } from '@gmail/gmail'

export type BackfillOptions = {
  onProgress?: (fetched: number) => void
  signal?: AbortSignal
  /** Pause between message fetches, to stay under Gmail's quota. */
  throttleMs?: number
}

export type BackfillResult = { fetched: number; complete: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runBackfill(
  store: MailStore,
  accountId: number,
  gmail: GmailApi,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const throttleMs = opts.throttleMs ?? 20
  const cursor = store.getSyncCursor(accountId)

  if (cursor.backfillComplete) return { fetched: 0, complete: true }

  // Capture the cursor BEFORE downloading anything. Anything that changes
  // during the backfill then shows up in the first incremental pass rather
  // than being silently missed.
  if (!cursor.historyId) {
    const profile = await gmail.getProfile()
    store.setHistoryId(accountId, profile.historyId)
  }

  store.upsertLabels(accountId, await gmail.listLabels())

  let pageToken = cursor.backfillPageToken ?? undefined
  let fetched = 0

  for (;;) {
    if (opts.signal?.aborted) return { fetched, complete: false }

    const page = await gmail.listMessageIds(pageToken)

    for (const id of page.ids) {
      if (opts.signal?.aborted) return { fetched, complete: false }
      store.upsertMessage(accountId, await gmail.getMessage(id))
      fetched += 1
      opts.onProgress?.(fetched)
      if (throttleMs > 0) await sleep(throttleMs)
    }

    // Checkpoint only once a whole page has landed. Re-fetching at most one
    // page after a crash is cheap; a torn mid-page cursor is not.
    pageToken = page.nextPageToken
    store.setBackfillPageToken(accountId, pageToken ?? null)

    if (!pageToken) break
  }

  store.setBackfillComplete(accountId, true)
  store.setBackfillPageToken(accountId, null)

  return { fetched, complete: true }
}
