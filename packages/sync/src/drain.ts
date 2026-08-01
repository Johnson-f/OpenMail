import type { MailStore } from '@gmail/core'
import type { GmailApi } from '@gmail/gmail'

export type DrainOptions = { maxAttempts?: number }
export type DrainResult = { uploaded: number; failed: number }

/**
 * Upload queued label changes to Gmail.
 *
 * Uploads are sequential on purpose: two concurrent modifies against the
 * same message would race, and Gmail messages carry no etag, so there is no
 * conditional write available to detect it.
 */
export async function drainOutbox(
  store: MailStore,
  accountId: number,
  gmail: GmailApi,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const maxAttempts = opts.maxAttempts ?? 5
  let uploaded = 0
  let failed = 0

  for (const row of store.pendingOutbox(accountId)) {
    try {
      await gmail.modifyMessage(row.messageId, row.add, row.remove)
      // Record the cursor at upload time: history records do not say which
      // client made a change, so this is how a replay of our own write is
      // told apart from a genuinely remote one.
      const { historyId } = await gmail.getProfile()
      store.markOutboxUploaded(row.id, historyId)
      uploaded += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (row.attempts + 1 >= maxAttempts) store.abandonOutbox(row.id, message)
      else store.markOutboxFailed(row.id, message)
      failed += 1
    }
  }

  return { uploaded, failed }
}
