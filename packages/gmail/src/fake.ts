import type { StoredMessage, Label } from '@gmail/core'
import { HistoryExpiredError, type GmailApi, type HistoryChange, type HistoryPage } from './types'

type HistoryEntry = { historyId: number; change: HistoryChange }

const DEFAULT_LABELS: Label[] = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  { id: 'STARRED', name: 'STARRED', type: 'system' },
  { id: 'TRASH', name: 'TRASH', type: 'system' },
  { id: 'SENT', name: 'SENT', type: 'system' },
]

/** In-memory GmailApi test double. See CLAUDE task spec for required behaviors. */
export class FakeGmail implements GmailApi {
  private readonly messages = new Map<string, StoredMessage>()
  private readonly messageOrder: string[] = []
  private readonly labels: Label[] = DEFAULT_LABELS.map((l) => ({ ...l }))
  private readonly history: HistoryEntry[] = []
  private readonly pageSize: number

  private clock = 1
  private expiredBefore = 0
  private pendingModifyError: Error | null = null
  private profileEmail = 'fake.user@example.com'

  constructor(opts: { pageSize?: number } = {}) {
    this.pageSize = opts.pageSize ?? 100
  }

  seedMessage(over: Partial<StoredMessage> & { id: string }): void {
    const defaults: StoredMessage = {
      id: over.id,
      threadId: over.id,
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      cc: [],
      subject: '',
      snippet: '',
      bodyText: '',
      bodyHtml: '',
      internalDate: Date.now(),
      labelIds: ['INBOX'],
    }
    const msg: StoredMessage = { ...defaults, ...over }
    if (!this.messages.has(msg.id)) this.messageOrder.push(msg.id)
    this.messages.set(msg.id, msg)
  }

  /** Simulates a label change made by another client (phone, web Gmail, etc). */
  remoteModify(id: string, add: string[], remove: string[]): void {
    this.applyModify(id, add, remove)
  }

  expireHistoryBefore(historyId: string): void {
    this.expiredBefore = Number(historyId)
  }

  /** Makes exactly the next modifyMessage call throw `err`, then recovers. */
  failNextModify(err: Error): void {
    this.pendingModifyError = err
  }

  async listMessageIds(pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
    const offset = pageToken ? Number(pageToken) : 0
    const slice = this.messageOrder.slice(offset, offset + this.pageSize)
    const nextOffset = offset + slice.length
    const nextPageToken = nextOffset < this.messageOrder.length ? String(nextOffset) : undefined
    return { ids: slice, nextPageToken }
  }

  async getMessage(id: string): Promise<StoredMessage> {
    const msg = this.messages.get(id)
    if (!msg) throw new Error(`FakeGmail: no such message '${id}'`)
    return this.copyMessage(msg)
  }

  async listLabels(): Promise<Label[]> {
    return this.labels.map((l) => ({ ...l }))
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    return { emailAddress: this.profileEmail, historyId: String(this.clock) }
  }

  async listHistory(startHistoryId: string): Promise<HistoryPage> {
    const start = Number(startHistoryId)
    if (start < this.expiredBefore) {
      throw new HistoryExpiredError()
    }
    const changes = this.history.filter((entry) => entry.historyId > start).map((entry) => entry.change)
    return { changes, historyId: String(this.clock) }
  }

  async modifyMessage(id: string, add: string[], remove: string[]): Promise<void> {
    if (this.pendingModifyError) {
      const err = this.pendingModifyError
      this.pendingModifyError = null
      throw err
    }
    this.applyModify(id, add, remove)
  }

  private applyModify(id: string, add: string[], remove: string[]): void {
    const msg = this.messages.get(id)
    if (!msg) throw new Error(`FakeGmail: no such message '${id}'`)

    const current = new Set(msg.labelIds)
    const actuallyAdded = add.filter((l) => !current.has(l))
    const actuallyRemoved = remove.filter((l) => current.has(l))

    // Real Gmail records history only for labels that actually flip state.
    // A remove of an already-absent label (or add of an already-present one)
    // is a silent no-op — no history entry, no clock tick.
    if (actuallyAdded.length === 0 && actuallyRemoved.length === 0) return

    for (const l of actuallyAdded) current.add(l)
    for (const l of actuallyRemoved) current.delete(l)
    msg.labelIds = Array.from(current)

    this.clock += 1
    if (actuallyAdded.length > 0) {
      this.history.push({
        historyId: this.clock,
        change: { type: 'labelAdded', messageId: id, labelIds: actuallyAdded },
      })
    }
    if (actuallyRemoved.length > 0) {
      this.history.push({
        historyId: this.clock,
        change: { type: 'labelRemoved', messageId: id, labelIds: actuallyRemoved },
      })
    }
  }

  private copyMessage(msg: StoredMessage): StoredMessage {
    return {
      ...msg,
      to: [...msg.to],
      cc: [...msg.cc],
      labelIds: [...msg.labelIds],
    }
  }
}
