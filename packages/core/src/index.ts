/**
 * Types shared by every app and package. Zero runtime dependencies —
 * anything imported here must work in Node, Electron's main process, and
 * a browser bundle alike.
 */

export type StoredMessage = {
  id: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  snippet: string
  bodyText: string
  bodyHtml: string
  internalDate: number
  labelIds: string[]
}

export type ThreadSummary = {
  threadId: string
  subject: string
  /** Display name of the most recent sender, falling back to the address. */
  from: string
  snippet: string
  lastMessageAt: number
  messageCount: number
  unread: boolean
  starred: boolean
  hasAttachment: boolean
}

export type MailboxCounts = {
  labelId: string
  name: string
  total: number
  unread: number
}

export type SearchHit = {
  messageId: string
  threadId: string
  subject: string
  snippet: string
}

export type Label = {
  id: string
  name: string
  type: string
}

export type AccountRow = {
  id: number
  email: string
  needsReauth: boolean
}

export type OutboxRow = {
  id: number
  messageId: string
  add: string[]
  remove: string[]
  attempts: number
}

export type SyncStatus = {
  accountId: number
  backfillComplete: boolean
  backfillFetched: number
  pendingUploads: number
  needsReauth: boolean
  lastError: string | null
}

export type MessageWithLabels = StoredMessage & { effectiveLabelIds: string[] }

/**
 * Everything the sync engine needs from storage.
 *
 * The desktop app implements this over SQLite. A future web app implements
 * it over Postgres. Keeping sync code behind this interface is what makes
 * `@gmail/sync` shareable instead of desktop-only.
 */
export type MailStore = {
  upsertMessage(accountId: number, msg: StoredMessage): void
  deleteMessage(accountId: number, messageId: string): void
  getMessage(accountId: number, messageId: string): StoredMessage | null

  upsertLabels(accountId: number, labels: Label[]): void

  getSyncCursor(accountId: number): {
    historyId: string | null
    backfillComplete: boolean
    backfillPageToken: string | null
  }
  setHistoryId(accountId: number, historyId: string): void
  setBackfillPageToken(accountId: number, token: string | null): void
  setBackfillComplete(accountId: number, complete: boolean): void

  pendingOutbox(accountId: number): OutboxRow[]
  markOutboxUploaded(id: number, historyId: string): void
  markOutboxFailed(id: number, error: string): void
  abandonOutbox(id: number, error: string): void
}
