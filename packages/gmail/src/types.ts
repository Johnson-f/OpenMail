import type { DraftRef, Label, OutgoingMessage, SendResult, StoredMessage } from '@gmail/core'

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

export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string, message = `Message ${messageId} was not found`) {
    super(message)
    this.name = 'MessageNotFoundError'
    Object.setPrototypeOf(this, MessageNotFoundError.prototype)
  }
}

/** The provider may have accepted a send but the client did not receive acknowledgement. */
export class UncertainSendError extends Error {
  constructor(message = 'The send result is uncertain', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UncertainSendError'
    Object.setPrototypeOf(this, UncertainSendError.prototype)
  }
}

export type GmailApi = {
  listMessageIds(pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>
  /** @throws MessageNotFoundError */
  getMessage(id: string): Promise<StoredMessage>
  listLabels(): Promise<Label[]>
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  /** @throws HistoryExpiredError */
  listHistory(startHistoryId: string): Promise<HistoryPage>
  modifyMessage(id: string, add: string[], remove: string[]): Promise<void>
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>
  createDraft(message: OutgoingMessage): Promise<DraftRef>
  updateDraft(draftId: string, message: OutgoingMessage): Promise<DraftRef>
  deleteDraft(draftId: string): Promise<void>
  sendDraft(draftId: string): Promise<SendResult>
  /** @throws UncertainSendError when Gmail may have accepted the message. */
  sendMessage(message: OutgoingMessage): Promise<SendResult>
  findByRfcMessageId(messageId: string): Promise<StoredMessage | null>
}
