import type { StoredMessage, Label } from '@gmail/core'

export type HistoryChange =
  | { type: 'messageAdded'; messageId: string; threadId: string }
  | { type: 'messageDeleted'; messageId: string }
  | { type: 'labelAdded'; messageId: string; labelIds: string[] }
  | { type: 'labelRemoved'; messageId: string; labelIds: string[] }

export type HistoryPage = { changes: HistoryChange[]; historyId: string }

/** Thrown when startHistoryId is older than Gmail retains (HTTP 404). */
export class HistoryExpiredError extends Error {
  constructor(message = 'History cursor has expired') {
    super(message)
    this.name = 'HistoryExpiredError'
    Object.setPrototypeOf(this, HistoryExpiredError.prototype)
  }
}

export type GmailApi = {
  listMessageIds(pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>
  getMessage(id: string): Promise<StoredMessage>
  listLabels(): Promise<Label[]>
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  /** @throws HistoryExpiredError */
  listHistory(startHistoryId: string): Promise<HistoryPage>
  modifyMessage(id: string, add: string[], remove: string[]): Promise<void>
}
