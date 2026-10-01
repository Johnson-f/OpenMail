import type { DraftRef, Label, OutgoingMessage, SendResult, StoredMessage } from '@gmail/core'
import {
  HistoryExpiredError,
  MessageNotFoundError,
  UncertainSendError,
  type GmailApi,
  type HistoryChange,
  type HistoryPage,
} from './types'

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
  private readonly attachments = new Map<string, Uint8Array>()
  private readonly drafts = new Map<string, OutgoingMessage>()
  private readonly pageSize: number

  private clock = 1
  private expiredBefore = 0
  private pendingModifyError: Error | null = null
  private pendingSendError: Error | null = null
  private pendingSendAfterAcceptError: Error | null = null
  private sends = 0
  private profileEmail = 'fake.user@example.com'
  private nextDraft = 1
  private nextMessage = 1

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
      messageIdHeader: `<${over.id}@fake.local>`.replace(/[<>]/g, ''),
      inReplyTo: '',
      references: [],
      attachments: [],
    }
    const msg: StoredMessage = { ...defaults, ...over }
    if (!this.messages.has(msg.id)) this.messageOrder.push(msg.id)
    this.messages.set(msg.id, msg)
  }

  seedAttachment(messageId: string, attachmentId: string, data: Uint8Array): void {
    this.attachments.set(`${messageId}:${attachmentId}`, new Uint8Array(data))
  }

  /** Simulates a label change made by another client (phone, web Gmail, etc). */
  remoteModify(id: string, add: string[], remove: string[]): void {
    this.applyModify(id, add, remove)
  }

  expireHistoryBefore(historyId: string): void {
    this.expiredBefore = Number(historyId)
    // Gmail's current profile cursor is always valid even when older history
    // has fallen out of retention. Keep the fake's current cursor at or past
    // the expiry boundary so a full resync can establish a usable cursor.
    this.clock = Math.max(this.clock, this.expiredBefore)
  }

  /** Makes exactly the next modifyMessage call throw `err`, then recovers. */
  failNextModify(err: Error): void {
    this.pendingModifyError = err
  }

  failNextSend(err: Error): void {
    this.pendingSendError = err
  }

  /** The next send is stored, then reported as uncertain, as if the acknowledgement was lost. */
  failNextSendAfterAccept(err: Error): void {
    this.pendingSendAfterAcceptError = err
  }

  get sendCount(): number {
    return this.sends
  }

  /** Simulates "Delete forever", draft replacement, or Trash/Spam purge. */
  deleteMessagePermanently(id: string): void {
    if (!this.messages.delete(id)) throw new MessageNotFoundError(id)
    const index = this.messageOrder.indexOf(id)
    if (index >= 0) this.messageOrder.splice(index, 1)
    this.clock += 1
    this.history.push({ historyId: this.clock, change: { type: 'messageDeleted', messageId: id } })
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
    if (!msg) throw new MessageNotFoundError(id)
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

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const data = this.attachments.get(`${messageId}:${attachmentId}`)
    if (!data) throw new MessageNotFoundError(messageId, `FakeGmail: no attachment '${attachmentId}' on '${messageId}'`)
    return new Uint8Array(data)
  }

  async createDraft(message: OutgoingMessage): Promise<DraftRef> {
    const id = `draft-${this.nextDraft++}`
    this.drafts.set(id, this.copyOutgoing(message))
    return { id, messageId: `draft-message-${id}`, threadId: message.threadId ?? `thread-${id}` }
  }

  async updateDraft(draftId: string, message: OutgoingMessage): Promise<DraftRef> {
    if (!this.drafts.has(draftId)) throw new Error(`FakeGmail: no draft '${draftId}'`)
    this.drafts.set(draftId, this.copyOutgoing(message))
    return { id: draftId, messageId: `draft-message-${draftId}`, threadId: message.threadId ?? `thread-${draftId}` }
  }

  async deleteDraft(draftId: string): Promise<void> {
    if (!this.drafts.delete(draftId)) throw new Error(`FakeGmail: no draft '${draftId}'`)
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const message = this.drafts.get(draftId)
    if (!message) throw new Error(`FakeGmail: no draft '${draftId}'`)
    const result = await this.sendMessage(message)
    this.drafts.delete(draftId)
    return result
  }

  async sendMessage(message: OutgoingMessage): Promise<SendResult> {
    if (this.pendingSendError) {
      const cause = this.pendingSendError
      this.pendingSendError = null
      throw new UncertainSendError('FakeGmail send result is uncertain', { cause })
    }
    this.sends += 1
    const id = `sent-${this.nextMessage++}`
    const threadId = message.threadId ?? id
    const stored: StoredMessage = {
      id,
      threadId,
      from: message.from ?? this.profileEmail,
      to: [...message.to],
      cc: [...(message.cc ?? [])],
      subject: message.subject,
      snippet: message.bodyText.slice(0, 120),
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml ?? '',
      internalDate: Date.now(),
      labelIds: ['SENT'],
      messageIdHeader: message.messageId.replace(/[<>]/g, ''),
      inReplyTo: message.inReplyTo?.replace(/[<>]/g, '') ?? '',
      references: (message.references ?? []).map((ref) => ref.replace(/[<>]/g, '')),
      attachments: (message.attachments ?? []).map((attachment, index) => ({
        partId: `part-${index + 1}`,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.data.byteLength,
        contentId: attachment.contentId,
        disposition: attachment.disposition ?? (attachment.contentId ? 'inline' : 'attachment'),
      })),
    }
    this.messageOrder.push(id)
    this.messages.set(id, stored)
    this.clock += 1
    this.history.push({ historyId: this.clock, change: { type: 'messageAdded', messageId: id, threadId } })
    if (this.pendingSendAfterAcceptError) {
      const cause = this.pendingSendAfterAcceptError
      this.pendingSendAfterAcceptError = null
      throw new UncertainSendError('FakeGmail accepted the send but the acknowledgement was lost', { cause })
    }
    return { messageId: id, threadId, rfcMessageId: stored.messageIdHeader }
  }

  async findByRfcMessageId(messageId: string): Promise<StoredMessage | null> {
    const clean = messageId.replace(/[<>]/g, '')
    const found = [...this.messages.values()].find((message) => message.messageIdHeader === clean)
    return found ? this.copyMessage(found) : null
  }

  private applyModify(id: string, add: string[], remove: string[]): void {
    const msg = this.messages.get(id)
    if (!msg) throw new MessageNotFoundError(id)

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
      references: [...msg.references],
      attachments: msg.attachments.map((attachment) => ({ ...attachment })),
    }
  }

  private copyOutgoing(message: OutgoingMessage): OutgoingMessage {
    return {
      ...message,
      to: [...message.to],
      cc: [...(message.cc ?? [])],
      bcc: [...(message.bcc ?? [])],
      references: [...(message.references ?? [])],
      attachments: (message.attachments ?? []).map((attachment) => ({
        ...attachment,
        data: new Uint8Array(attachment.data),
      })),
    }
  }
}
