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
  messageIdHeader: string
  inReplyTo: string
  references: string[]
  attachments: AttachmentRef[]
}

export type AttachmentRef = {
  partId: string
  filename: string
  mimeType: string
  sizeBytes: number
  attachmentId?: string
  contentId?: string
  disposition: 'attachment' | 'inline'
  inlineData?: string
}

export type OutgoingAttachment = {
  filename: string
  mimeType: string
  data: Uint8Array
  contentId?: string
  disposition?: 'attachment' | 'inline'
}

export type OutgoingMessage = {
  from?: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  messageId: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: OutgoingAttachment[]
}

export type DraftRef = {
  id: string
  messageId: string
  threadId: string
}

export type SendResult = {
  messageId: string
  threadId: string
  rfcMessageId: string
}

export type MailEventOrigin = 'backfill' | 'incremental' | 'local_action' | 'reconciliation'

export type MailEventContext = {
  eventKey: string
  origin: MailEventOrigin
  historyId?: string
  payload?: Record<string, unknown>
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
  from: string
  internalDate: number
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
  upsertMessage(accountId: number, msg: StoredMessage, event?: MailEventContext): void
  deleteMessage(accountId: number, messageId: string, event?: MailEventContext): void
  getMessage(accountId: number, messageId: string): StoredMessage | null

  /** Starts a full resync: upserts from now on are stamped with a new epoch. */
  beginResync(accountId: number): void
  /** Deletes messages not seen since `beginResync`, as reconciliation events. */
  sweepUnseen(accountId: number): void

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

/**
 * Split an address header on commas that actually separate addresses.
 *
 * A naive `.split(',')` corrupts the very common `"Doe, John" <j@x.com>`
 * into two bogus recipients. Commas are only separators when they sit
 * outside a quoted display name and outside an angle-bracketed address.
 */
export function splitAddresses(value: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  let inAngles = false
  let escaped = false

  for (const ch of value) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inQuotes) {
      current += ch
      escaped = true
      continue
    }
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch === '<') inAngles = true
    else if (!inQuotes && ch === '>') inAngles = false

    if (ch === ',' && !inQuotes && !inAngles) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)

  return out.map((s) => s.trim()).filter(Boolean)
}
