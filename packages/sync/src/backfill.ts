import type { MailStore, StoredMessage } from '@gmail/core'
import { MessageNotFoundError, type GmailApi } from '@gmail/gmail'

export type BackfillOptions = {
  onProgress?: (fetched: number) => void
  signal?: AbortSignal
  /** Pause after each fetch within a worker, on top of the rate limit. */
  throttleMs?: number
  /** Concurrent message fetches within a page. Defaults to 8. */
  concurrency?: number
  /** Message fetches per second across all workers. Defaults to 40. */
  maxPerSecond?: number
}

export type BackfillResult = { fetched: number; complete: boolean }

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_PER_SECOND = 40

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** messages.get costs 5 quota units against Gmail's 250 units/user/second. */
class TokenBucket {
  private tokens: number
  private lastRefill = Date.now()

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond
  }

  async take(): Promise<void> {
    if (!Number.isFinite(this.perSecond) || this.perSecond <= 0) return
    for (;;) {
      const now = Date.now()
      this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.lastRefill) / 1000) * this.perSecond)
      this.lastRefill = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000))
    }
  }
}

export async function runBackfill(
  store: MailStore,
  accountId: number,
  gmail: GmailApi,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const throttleMs = opts.throttleMs ?? 0
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const bucket = new TokenBucket(opts.maxPerSecond ?? DEFAULT_MAX_PER_SECOND)
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

  const land = (message: StoredMessage): void => {
    store.upsertMessage(accountId, message, {
      eventKey: `backfill:${accountId}:${message.id}:${message.internalDate}`,
      origin: 'backfill',
      historyId: store.getSyncCursor(accountId).historyId ?? undefined,
    })
    fetched += 1
    opts.onProgress?.(fetched)
  }

  const fetchPage = async (ids: string[]): Promise<void> => {
    let next = 0
    let failure: { error: unknown } | null = null
    const worker = async (): Promise<void> => {
      while (!failure && !opts.signal?.aborted && next < ids.length) {
        const id = ids[next++] as string
        try {
          await bucket.take()
          land(await gmail.getMessage(id))
        } catch (error) {
          if (error instanceof MessageNotFoundError) continue
          failure ??= { error }
          return
        }
        if (throttleMs > 0) await sleep(throttleMs)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
    if (failure) throw (failure as { error: unknown }).error
  }

  for (;;) {
    if (opts.signal?.aborted) return { fetched, complete: false }

    const page = await gmail.listMessageIds(pageToken)
    await fetchPage(page.ids)
    if (opts.signal?.aborted) return { fetched, complete: false }

    // Checkpoint only once a whole page has landed. Re-fetching at most one
    // page after a crash is cheap; a torn mid-page cursor is not.
    pageToken = page.nextPageToken
    store.setBackfillPageToken(accountId, pageToken ?? null)

    if (!pageToken) break
  }

  // Every message still in Gmail was stamped with the current epoch on the
  // way in, so this only removes mail a resync no longer saw. Running it on
  // every completed backfill also finishes a resync that was interrupted.
  store.sweepUnseen(accountId)
  store.setBackfillComplete(accountId, true)
  store.setBackfillPageToken(accountId, null)

  return { fetched, complete: true }
}
