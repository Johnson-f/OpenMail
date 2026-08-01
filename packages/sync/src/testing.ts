import type { Label, MailStore, OutboxRow, StoredMessage } from '@gmail/core'

type Account = {
  historyId: string | null
  backfillComplete: boolean
  backfillPageToken: string | null
}

/**
 * In-memory MailStore for testing the sync engine without SQLite.
 *
 * This package deliberately never imports a database driver — sync talks to
 * the MailStore interface so the same code can run over SQLite on desktop
 * and Postgres on the web. This fake is what proves that boundary holds.
 */
export class FakeMailStore implements MailStore {
  private accounts = new Map<number, Account>()
  private messages = new Map<string, StoredMessage>()
  private labels = new Map<number, Label[]>()
  private outbox: (OutboxRow & { accountId: number; status: string })[] = []
  private nextOutboxId = 1

  constructor(accountIds: number[] = [1]) {
    for (const id of accountIds) {
      this.accounts.set(id, {
        historyId: null,
        backfillComplete: false,
        backfillPageToken: null,
      })
    }
  }

  private key(accountId: number, messageId: string): string {
    return `${accountId}:${messageId}`
  }

  private account(accountId: number): Account {
    const a = this.accounts.get(accountId)
    if (!a) throw new Error(`FakeMailStore: no account ${accountId}`)
    return a
  }

  upsertMessage(accountId: number, msg: StoredMessage): void {
    this.messages.set(this.key(accountId, msg.id), {
      ...msg,
      labelIds: [...msg.labelIds],
    })
  }

  deleteMessage(accountId: number, messageId: string): void {
    this.messages.delete(this.key(accountId, messageId))
  }

  getMessage(accountId: number, messageId: string): StoredMessage | null {
    const m = this.messages.get(this.key(accountId, messageId))
    return m ? { ...m, labelIds: [...m.labelIds] } : null
  }

  upsertLabels(accountId: number, labels: Label[]): void {
    this.labels.set(accountId, [...labels])
  }

  getLabels(accountId: number): Label[] {
    return this.labels.get(accountId) ?? []
  }

  messageCount(accountId: number): number {
    return [...this.messages.keys()].filter((k) => k.startsWith(`${accountId}:`)).length
  }

  getSyncCursor(accountId: number): Account {
    return { ...this.account(accountId) }
  }

  setHistoryId(accountId: number, historyId: string): void {
    this.account(accountId).historyId = historyId
  }

  setBackfillPageToken(accountId: number, token: string | null): void {
    this.account(accountId).backfillPageToken = token
  }

  setBackfillComplete(accountId: number, complete: boolean): void {
    this.account(accountId).backfillComplete = complete
  }

  enqueue(accountId: number, messageId: string, add: string[], remove: string[]): number {
    const id = this.nextOutboxId++
    this.outbox.push({ id, accountId, messageId, add, remove, attempts: 0, status: 'pending' })
    return id
  }

  pendingOutbox(accountId: number): OutboxRow[] {
    return this.outbox
      .filter((r) => r.accountId === accountId && (r.status === 'pending' || r.status === 'failed'))
      .sort((a, b) => a.id - b.id)
      .map(({ id, messageId, add, remove, attempts }) => ({ id, messageId, add, remove, attempts }))
  }

  private row(id: number): (OutboxRow & { accountId: number; status: string }) | undefined {
    return this.outbox.find((r) => r.id === id)
  }

  markOutboxUploaded(id: number, historyId: string): void {
    const r = this.row(id)
    if (r) {
      r.status = 'uploaded'
      this.uploadedAt.set(id, historyId)
    }
  }

  markOutboxFailed(id: number, _error: string): void {
    const r = this.row(id)
    if (r) {
      r.status = 'failed'
      r.attempts += 1
    }
  }

  abandonOutbox(id: number, _error: string): void {
    const r = this.row(id)
    if (r) {
      r.status = 'abandoned'
      r.attempts += 1
    }
  }

  readonly uploadedAt = new Map<number, string>()

  statusOf(id: number): string | undefined {
    return this.row(id)?.status
  }
}
