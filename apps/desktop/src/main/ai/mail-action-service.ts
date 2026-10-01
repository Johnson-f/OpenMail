import { randomUUID } from 'node:crypto'
import { createActionIntent, type ActionIntent } from '@gmail/agent'
import type { DraftRef, OutgoingMessage, SendResult } from '@gmail/core'
import { UncertainSendError, type GmailApi } from '@gmail/gmail'
import type { Db } from '../db/index'
import type { SqliteMailStore } from '../db/store'
import type { ActionService, PendingAction } from './action-service'
import type { AutomationGrant } from '@gmail/agent'

export type ComposeAttachment = { filename: string; mimeType: string; dataBase64: string; contentId?: string }
export type ComposeMessage = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: ComposeAttachment[]
}

export type SendExecution = {
  status: 'sent' | 'uncertain' | 'failed' | 'in_progress'
  result?: SendResult
  error?: string
}

export type NotSentSend = { intent: ActionIntent; error: string | null; updatedAt: number }

const NOT_SENT_AFTER_MS = 15 * 60_000

type LedgerRow = {
  operation_id: string
  action_intent_id: string
  account_id: number
  rfc_message_id: string
  status: string
  gmail_message_id: string | null
  gmail_thread_id: string | null
  updated_at: number
}

export class MailActionService {
  constructor(
    private readonly db: Db,
    private readonly store: SqliteMailStore,
    private readonly gmailFor: (accountId: number) => GmailApi,
    private readonly actions: ActionService,
  ) {}

  async saveDraft(accountId: number, localDraftId: string | undefined, input: ComposeMessage): Promise<{
    localDraftId: string
    remote: DraftRef
  }> {
    const id = localDraftId ?? randomUUID()
    const existing = this.db
      .prepare('SELECT gmail_draft_id FROM local_drafts WHERE id = ? AND account_id = ?')
      .get(id, accountId) as { gmail_draft_id: string | null } | undefined
    const message = toOutgoing(input, `draft-${id}@openmail.local`)
    const gmail = this.gmailFor(accountId)
    const remote = existing?.gmail_draft_id
      ? await gmail.updateDraft(existing.gmail_draft_id, message)
      : await gmail.createDraft(message)
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO local_drafts (id, account_id, gmail_draft_id, message_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           gmail_draft_id = excluded.gmail_draft_id,
           message_json = excluded.message_json,
           status = 'draft',
           updated_at = excluded.updated_at`,
      )
      .run(id, accountId, remote.id, JSON.stringify(input), now, now)
    return { localDraftId: id, remote }
  }

  async deleteDraft(accountId: number, localDraftId: string): Promise<void> {
    const row = this.db
      .prepare('SELECT gmail_draft_id FROM local_drafts WHERE id = ? AND account_id = ?')
      .get(localDraftId, accountId) as { gmail_draft_id: string | null } | undefined
    if (row?.gmail_draft_id) await this.gmailFor(accountId).deleteDraft(row.gmail_draft_id)
    this.db.prepare('DELETE FROM local_drafts WHERE id = ? AND account_id = ?').run(localDraftId, accountId)
  }

  async requestSend(
    accountId: number,
    input: ComposeMessage,
    conversationId = 'compose',
    localDraftId?: string,
  ): Promise<PendingAction> {
    const operationId = randomUUID()
    const message = toOutgoing(input, `${operationId}@openmail.local`)
    const intent = createActionIntent({
      kind: 'send',
      accountId,
      arguments: { operationId, message: serializeOutgoing(message), ...(localDraftId ? { localDraftId } : {}) },
      initiator: { type: 'chat', conversationId },
      source: 'user_request',
    })
    return this.actions.propose(intent)
  }

  async requestAutomationSend(
    accountId: number,
    input: ComposeMessage,
    automationVersionId: string,
    grant: AutomationGrant,
    operationId: string = randomUUID(),
  ): Promise<PendingAction> {
    const message = toOutgoing(input, `${operationId}@openmail.local`)
    const intent = createActionIntent({
      kind: 'send',
      accountId,
      arguments: { operationId, message: serializeOutgoing(message), to: message.to, cc: message.cc ?? [], bcc: message.bcc ?? [], attachments: message.attachments ?? [] },
      initiator: { type: 'automation', automationVersionId },
      source: 'automation_spec',
    })
    return this.actions.propose(intent, grant)
  }

  async executeApproved(intentId: string): Promise<SendExecution> {
    const intent = this.actions.getIntent(intentId)
    if (!intent || intent.kind !== 'send') throw new Error('Approved send intent was not found')
    const actionStatus = this.actions.status(intentId)
    const operationId = String(intent.arguments.operationId)
    const message = deserializeOutgoing(intent.arguments.message)
    if (actionStatus !== 'approved') {
      const existing = this.ledgerRow(operationId)
      if (!existing || !['completed', 'uncertain', 'failed'].includes(actionStatus ?? '')) {
        throw new Error('Send intent is not approved')
      }
      return this.existingExecution(intentId, existing, message)
    }

    const now = Date.now()
    const claim = this.db
      .prepare(
        `INSERT INTO send_ledger
         (operation_id, action_intent_id, account_id, rfc_message_id, content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET status = 'sending', updated_at = excluded.updated_at
         WHERE send_ledger.status = 'failed'`,
      )
      .run(operationId, intent.id, intent.accountId, message.messageId, intent.contentHash, now, now)
    if (claim.changes !== 1) {
      const existing = this.ledgerRow(operationId)
      if (!existing) throw new Error('Send could not be claimed')
      return this.existingExecution(intentId, existing, message)
    }
    try {
      const result = await this.gmailFor(intent.accountId).sendMessage(message)
      this.db
        .prepare(
          `UPDATE send_ledger SET status = 'sent', gmail_message_id = ?, gmail_thread_id = ?,
             last_error = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(result.messageId, result.threadId, Date.now(), operationId)
      await this.storeSentMessage(intent.accountId, result.messageId, operationId)
      await this.discardSentDraft(intent.accountId, intent.arguments.localDraftId)
      this.actions.recordExecution(intentId, 'completed', { gmailMessageId: result.messageId })
      return { status: 'sent', result }
    } catch (error) {
      const uncertain = error instanceof UncertainSendError
      const messageText = error instanceof Error ? error.message : String(error)
      this.db
        .prepare('UPDATE send_ledger SET status = ?, last_error = ?, updated_at = ? WHERE operation_id = ?')
        .run(uncertain ? 'uncertain' : 'failed', messageText, Date.now(), operationId)
      this.actions.recordExecution(intentId, uncertain ? 'uncertain' : 'failed', { error: messageText })
      return { status: uncertain ? 'uncertain' : 'failed', error: messageText }
    }
  }

  recoverInterrupted(): number {
    const rows = this.db.prepare("SELECT * FROM send_ledger WHERE status = 'sending'").all() as LedgerRow[]
    const error = 'The app stopped while this send was in progress'
    for (const row of rows) {
      this.db
        .prepare("UPDATE send_ledger SET status = 'uncertain', last_error = ?, updated_at = ? WHERE operation_id = ? AND status = 'sending'")
        .run(error, Date.now(), row.operation_id)
      this.actions.recordExecution(row.action_intent_id, 'uncertain', { error })
    }
    return rows.length
  }

  async reconcilePending(accountId: number, now = Date.now()): Promise<void> {
    const rows = this.db
      .prepare("SELECT operation_id FROM send_ledger WHERE status = 'uncertain' AND account_id = ?")
      .all(accountId) as Array<{ operation_id: string }>
    let firstError: unknown
    for (const row of rows) {
      try {
        await this.reconcileUncertain(row.operation_id, now)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  async reconcileUncertain(operationId: string, now = Date.now()): Promise<SendExecution> {
    const row = this.ledgerRow(operationId)
    if (!row || row.status !== 'uncertain') throw new Error('Send is not awaiting reconciliation')
    const found = await this.gmailFor(row.account_id).findByRfcMessageId(row.rfc_message_id)
    if (!found) {
      if (now - row.updated_at < NOT_SENT_AFTER_MS) {
        return { status: 'uncertain', error: 'Message is not visible in Sent yet' }
      }
      const error = 'Gmail has no record of this message; it was not sent'
      this.db
        .prepare("UPDATE send_ledger SET status = 'not_sent', last_error = ?, updated_at = ? WHERE operation_id = ? AND status = 'uncertain'")
        .run(error, now, operationId)
      this.actions.recordExecution(row.action_intent_id, 'failed', { error })
      return { status: 'failed', error }
    }
    this.db
      .prepare(
        `UPDATE send_ledger SET status = 'sent', gmail_message_id = ?, gmail_thread_id = ?,
           last_error = NULL, updated_at = ? WHERE operation_id = ?`,
      )
      .run(found.id, found.threadId, now, operationId)
    this.actions.recordExecution(row.action_intent_id, 'completed', { gmailMessageId: found.id })
    await this.storeSentMessage(row.account_id, found.id, operationId)
    return {
      status: 'sent',
      result: { messageId: found.id, threadId: found.threadId, rfcMessageId: row.rfc_message_id },
    }
  }

  listNotSent(): NotSentSend[] {
    const rows = this.db
      .prepare("SELECT action_intent_id, last_error, updated_at FROM send_ledger WHERE status IN ('not_sent', 'failed') ORDER BY updated_at")
      .all() as Array<{ action_intent_id: string; last_error: string | null; updated_at: number }>
    return rows.flatMap((row) => {
      const intent = this.actions.getIntent(row.action_intent_id)
      return intent ? [{ intent, error: row.last_error, updatedAt: row.updated_at }] : []
    })
  }

  async resend(intentId: string): Promise<PendingAction> {
    const intent = this.actions.getIntent(intentId)
    if (!intent || intent.kind !== 'send') throw new Error('Send intent was not found')
    const claimed = this.db
      .prepare(
        "UPDATE send_ledger SET status = 'resent', last_error = status, updated_at = ? WHERE action_intent_id = ? AND status IN ('not_sent', 'failed')",
      )
      .run(Date.now(), intentId)
    if (claimed.changes !== 1) throw new Error('Only a send that did not go out can be sent again')
    try {
      const localDraftId = typeof intent.arguments.localDraftId === 'string' ? intent.arguments.localDraftId : undefined
      return await this.requestSend(intent.accountId, composeFromIntent(intent), 'compose', localDraftId)
    } catch (error) {
      this.db
        .prepare("UPDATE send_ledger SET status = last_error WHERE action_intent_id = ? AND status = 'resent'")
        .run(intentId)
      throw error
    }
  }

  private async discardSentDraft(accountId: number, localDraftId: unknown): Promise<void> {
    if (typeof localDraftId !== 'string') return
    try {
      await this.deleteDraft(accountId, localDraftId)
    } catch (error) {
      console.error(`Could not delete draft ${localDraftId} after sending:`, error)
    }
  }

  private ledgerRow(operationId: string): LedgerRow | undefined {
    return this.db.prepare('SELECT * FROM send_ledger WHERE operation_id = ?').get(operationId) as LedgerRow | undefined
  }

  private existingExecution(intentId: string, existing: LedgerRow, message: OutgoingMessage): SendExecution {
    if (existing.status === 'sent') {
      this.actions.recordExecution(intentId, 'completed', { result: 'already_sent' })
      return {
        status: 'sent',
        result: {
          messageId: existing.gmail_message_id ?? '',
          threadId: existing.gmail_thread_id ?? '',
          rfcMessageId: message.messageId,
        },
      }
    }
    if (existing.status === 'sending') return { status: 'in_progress', error: 'Send is already in progress' }
    if (existing.status === 'uncertain') return { status: 'uncertain', error: 'Send requires reconciliation' }
    return { status: 'failed', error: `Send is ${existing.status}` }
  }

  private async storeSentMessage(accountId: number, gmailMessageId: string, operationId: string): Promise<void> {
    try {
      const stored = await this.gmailFor(accountId).getMessage(gmailMessageId)
      this.store.upsertMessage(accountId, stored, {
        eventKey: `local-send:${operationId}`,
        origin: 'local_action',
      })
    } catch {
      // Gmail sync will fetch the accepted message; the verified send result remains authoritative.
    }
  }
}

function composeFromIntent(intent: ActionIntent): ComposeMessage {
  const message = intent.arguments.message as Record<string, unknown>
  const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)
  return {
    to: stringArray(message.to),
    cc: stringArray(message.cc),
    bcc: stringArray(message.bcc),
    subject: String(message.subject ?? ''),
    bodyText: String(message.bodyText ?? ''),
    bodyHtml: optionalString(message.bodyHtml),
    threadId: optionalString(message.threadId),
    inReplyTo: optionalString(message.inReplyTo),
    references: stringArray(message.references),
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((raw) => {
          const attachment = raw as Record<string, unknown>
          return {
            filename: String(attachment.filename ?? ''),
            mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
            dataBase64: String(attachment.dataBase64 ?? ''),
            contentId: optionalString(attachment.contentId),
          }
        })
      : [],
  }
}

function toOutgoing(input: ComposeMessage, messageId: string): OutgoingMessage {
  return {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    messageId,
    threadId: input.threadId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data: Buffer.from(attachment.dataBase64, 'base64'),
      contentId: attachment.contentId,
    })),
  }
}

function serializeOutgoing(message: OutgoingMessage): Record<string, unknown> {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      dataBase64: Buffer.from(attachment.data).toString('base64'),
      data: undefined,
    })),
  }
}

function deserializeOutgoing(value: unknown): OutgoingMessage {
  if (!value || typeof value !== 'object') throw new Error('Send intent has no message')
  const input = value as Record<string, unknown>
  return {
    to: stringArray(input.to),
    cc: stringArray(input.cc),
    bcc: stringArray(input.bcc),
    subject: String(input.subject ?? ''),
    bodyText: String(input.bodyText ?? ''),
    bodyHtml: typeof input.bodyHtml === 'string' ? input.bodyHtml : undefined,
    messageId: String(input.messageId ?? ''),
    threadId: typeof input.threadId === 'string' ? input.threadId : undefined,
    inReplyTo: typeof input.inReplyTo === 'string' ? input.inReplyTo : undefined,
    references: stringArray(input.references),
    attachments: Array.isArray(input.attachments)
      ? input.attachments.map((raw) => {
          const attachment = raw as Record<string, unknown>
          return {
            filename: String(attachment.filename ?? ''),
            mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
            data: Buffer.from(String(attachment.dataBase64 ?? ''), 'base64'),
            contentId: typeof attachment.contentId === 'string' ? attachment.contentId : undefined,
          }
        })
      : [],
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
