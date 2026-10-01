import { google, gmail_v1 } from 'googleapis'
import { splitAddresses, type AttachmentRef, type DraftRef, type Label, type OutgoingMessage, type SendResult, type StoredMessage } from '@gmail/core'
import {
  HistoryExpiredError,
  MessageNotFoundError,
  UncertainSendError,
  type GmailApi,
  type HistoryChange,
  type HistoryPage,
} from './types'
import { buildRawMessage } from './mime'

export { splitAddresses }

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

const UNCERTAIN_SEND_STATUS = new Set([403, 429, 500, 502, 503, 504])
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])
const MAX_ATTEMPTS = 5
const MAX_DELAY_MS = 30_000

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const anyErr = err as { code?: number | string; status?: number; response?: { status?: number } }
  if (typeof anyErr.status === 'number') return anyErr.status
  if (typeof anyErr.response?.status === 'number') return anyErr.response.status
  if (typeof anyErr.code === 'number') return anyErr.code
  if (typeof anyErr.code === 'string' && /^\d+$/.test(anyErr.code)) return Number(anyErr.code)
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorReasons(err: unknown): string[] {
  const errors = (err as { response?: { data?: { error?: { errors?: { reason?: string }[] } } } })?.response?.data
    ?.error?.errors
  return Array.isArray(errors) ? errors.map((e) => e?.reason ?? '') : []
}

function isRetryable(status: number, err: unknown): boolean {
  if (status === 403) return errorReasons(err).some((reason) => RATE_LIMIT_REASONS.has(reason))
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: unknown } })?.response?.headers
  if (!headers || typeof headers !== 'object') return undefined
  const raw =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('retry-after')
      : (headers as Record<string, unknown>)['retry-after'] ?? (headers as Record<string, unknown>)['Retry-After']
  const seconds = Number(raw)
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined
}

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt += 1
      const status = extractStatus(err)
      if (status === undefined || !isRetryable(status, err) || attempt >= MAX_ATTEMPTS) {
        throw err
      }
      const hinted = status === 429 || status === 503 ? retryAfterMs(err) : undefined
      const cap = Math.min(MAX_DELAY_MS, 2 ** attempt * 1000)
      await sleep(hinted !== undefined ? Math.min(MAX_DELAY_MS, hinted) : Math.random() * cap)
    }
  }
}

async function orMessageNotFound<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (extractStatus(err) === 404) throw new MessageNotFoundError(messageId)
    throw err
  }
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  const lower = name.toLowerCase()
  const found = headers.find((h) => (h.name ?? '').toLowerCase() === lower)
  return found?.value ?? ''
}

async function extractMessageParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
  fetchBody: (attachmentId: string) => Promise<string>,
): Promise<{
  text: string
  html: string
  attachments: AttachmentRef[]
}> {
  let text = ''
  let html = ''
  const attachments: AttachmentRef[] = []

  const visit = async (part: gmail_v1.Schema$MessagePart | undefined): Promise<void> => {
    if (!part) return
    const mimeType = part.mimeType ?? ''
    const data = part.body?.data
    const bodyAttachmentId = part.body?.attachmentId
    const dispositionHeader = headerValue(part.headers ?? [], 'Content-Disposition').toLowerCase()
    const isAttachment = Boolean(part.filename) || dispositionHeader.startsWith('attachment')
    const hasContent = Boolean(data || bodyAttachmentId)
    const readBody = async (): Promise<string> =>
      data ? Buffer.from(data, 'base64url').toString('utf-8') : fetchBody(bodyAttachmentId as string)

    if (mimeType === 'text/plain' && !isAttachment && hasContent && !text) {
      text = await readBody()
    } else if (mimeType === 'text/html' && !isAttachment && hasContent && !html) {
      html = await readBody()
    } else if (part.filename || bodyAttachmentId || (isAttachment && data)) {
      const contentId = headerValue(part.headers ?? [], 'Content-ID').replace(/[<>]/g, '') || undefined
      attachments.push({
        partId: part.partId ?? '',
        filename: part.filename ?? '',
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
        attachmentId: bodyAttachmentId ?? undefined,
        contentId,
        disposition: dispositionHeader.startsWith('inline') || contentId ? 'inline' : 'attachment',
        inlineData: data ?? undefined,
      })
    }
    for (const child of part.parts ?? []) await visit(child)
  }

  await visit(payload)
  return { text, html, attachments }
}

function parseReferences(value: string): string[] {
  const matches = value.match(/<([^>]+)>/g)
  if (matches) return matches.map((ref) => ref.slice(1, -1))
  return value.split(/\s+/).map((ref) => ref.replace(/[<>]/g, '')).filter(Boolean)
}

async function schemaToStoredMessage(
  msg: gmail_v1.Schema$Message,
  fetchBody: (attachmentId: string) => Promise<string>,
): Promise<StoredMessage> {
  const headers = msg.payload?.headers ?? []
  const { text, html, attachments } = await extractMessageParts(msg.payload, fetchBody)
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    from: headerValue(headers, 'From'),
    to: splitAddresses(headerValue(headers, 'To')),
    cc: splitAddresses(headerValue(headers, 'Cc')),
    subject: headerValue(headers, 'Subject'),
    snippet: msg.snippet ?? '',
    bodyText: text,
    bodyHtml: html,
    internalDate: Number(msg.internalDate ?? 0),
    labelIds: msg.labelIds ?? [],
    messageIdHeader: headerValue(headers, 'Message-ID').replace(/[<>]/g, ''),
    inReplyTo: headerValue(headers, 'In-Reply-To').replace(/[<>]/g, ''),
    references: parseReferences(headerValue(headers, 'References')),
    attachments,
  }
}

function draftRef(draft: gmail_v1.Schema$Draft): DraftRef {
  return {
    id: draft.id ?? '',
    messageId: draft.message?.id ?? '',
    threadId: draft.message?.threadId ?? '',
  }
}

export class GoogleGmail implements GmailApi {
  private readonly gmail: gmail_v1.Gmail

  constructor(auth: OAuth2Client, gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth })) {
    this.gmail = gmail
  }

  static forRefreshToken(clientId: string, clientSecret: string, refreshToken: string): GoogleGmail {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken })
    return new GoogleGmail(auth)
  }

  async listMessageIds(pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
    const res = await withBackoff(() =>
      this.gmail.users.messages.list({ userId: 'me', pageToken, maxResults: 500 }),
    )
    const ids = (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    return { ids, nextPageToken: res.data.nextPageToken ?? undefined }
  }

  async getMessage(id: string): Promise<StoredMessage> {
    const res = await orMessageNotFound(id, () =>
      withBackoff(() => this.gmail.users.messages.get({ userId: 'me', id, format: 'full' })),
    )
    return schemaToStoredMessage(res.data, async (attachmentId) =>
      Buffer.from(await this.getAttachment(id, attachmentId)).toString('utf-8'),
    )
  }

  async listLabels(): Promise<Label[]> {
    const res = await withBackoff(() => this.gmail.users.labels.list({ userId: 'me' }))
    return (res.data.labels ?? []).map((l) => ({
      id: l.id ?? '',
      name: l.name ?? '',
      type: l.type ?? 'user',
    }))
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    const res = await withBackoff(() => this.gmail.users.getProfile({ userId: 'me' }))
    return {
      emailAddress: res.data.emailAddress ?? '',
      historyId: res.data.historyId ?? '',
    }
  }

  async listHistory(startHistoryId: string): Promise<HistoryPage> {
    const changes: HistoryChange[] = []
    let pageToken: string | undefined
    let historyId = startHistoryId

    try {
      do {
        const res = await withBackoff(() =>
          this.gmail.users.history.list({ userId: 'me', startHistoryId, pageToken }),
        )

        for (const record of res.data.history ?? []) {
          for (const added of record.messagesAdded ?? []) {
            const messageId = added.message?.id
            const threadId = added.message?.threadId
            if (messageId && threadId) changes.push({ type: 'messageAdded', messageId, threadId })
          }
          for (const deleted of record.messagesDeleted ?? []) {
            const messageId = deleted.message?.id
            if (messageId) changes.push({ type: 'messageDeleted', messageId })
          }
          for (const labelAdded of record.labelsAdded ?? []) {
            const messageId = labelAdded.message?.id
            if (messageId && labelAdded.labelIds) {
              changes.push({ type: 'labelAdded', messageId, labelIds: labelAdded.labelIds })
            }
          }
          for (const labelRemoved of record.labelsRemoved ?? []) {
            const messageId = labelRemoved.message?.id
            if (messageId && labelRemoved.labelIds) {
              changes.push({ type: 'labelRemoved', messageId, labelIds: labelRemoved.labelIds })
            }
          }
        }

        pageToken = res.data.nextPageToken ?? undefined
        if (res.data.historyId) historyId = res.data.historyId
      } while (pageToken)
    } catch (err) {
      if (extractStatus(err) === 404) {
        throw new HistoryExpiredError()
      }
      throw err
    }

    return { changes, historyId }
  }

  async modifyMessage(id: string, add: string[], remove: string[]): Promise<void> {
    await orMessageNotFound(id, () =>
      withBackoff(() =>
        this.gmail.users.messages.modify({
          userId: 'me',
          id,
          requestBody: { addLabelIds: add, removeLabelIds: remove },
        }),
      ),
    )
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const res = await orMessageNotFound(messageId, () =>
      withBackoff(() =>
        this.gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
      ),
    )
    return Buffer.from(res.data.data ?? '', 'base64url')
  }

  async createDraft(message: OutgoingMessage): Promise<DraftRef> {
    const res = await withBackoff(() =>
      this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: buildRawMessage(message), threadId: message.threadId } },
      }),
    )
    return draftRef(res.data)
  }

  async updateDraft(draftId: string, message: OutgoingMessage): Promise<DraftRef> {
    const res = await withBackoff(() =>
      this.gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message: { raw: buildRawMessage(message), threadId: message.threadId } },
      }),
    )
    return draftRef(res.data)
  }

  async deleteDraft(draftId: string): Promise<void> {
    await withBackoff(() => this.gmail.users.drafts.delete({ userId: 'me', id: draftId }))
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const before = await withBackoff(() =>
      this.gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' }),
    )
    const rfcMessageId = headerValue(before.data.message?.payload?.headers ?? [], 'Message-ID').replace(/[<>]/g, '')
    try {
      const res = await this.gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } })
      return {
        messageId: res.data.id ?? '',
        threadId: res.data.threadId ?? '',
        rfcMessageId,
      }
    } catch (error) {
      const status = extractStatus(error)
      if (status === undefined || UNCERTAIN_SEND_STATUS.has(status)) {
        throw new UncertainSendError('Gmail may have accepted the draft send', { cause: error })
      }
      throw error
    }
  }

  async sendMessage(message: OutgoingMessage): Promise<SendResult> {
    try {
      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: buildRawMessage(message), threadId: message.threadId },
      })
      return {
        messageId: res.data.id ?? '',
        threadId: res.data.threadId ?? '',
        rfcMessageId: message.messageId.replace(/[<>]/g, ''),
      }
    } catch (error) {
      const status = extractStatus(error)
      if (status === undefined || UNCERTAIN_SEND_STATUS.has(status)) {
        throw new UncertainSendError('Gmail may have accepted the message send', { cause: error })
      }
      throw error
    }
  }

  async findByRfcMessageId(messageId: string): Promise<StoredMessage | null> {
    const clean = messageId.replace(/[<>]/g, '')
    const list = await withBackoff(() =>
      this.gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:${clean}`, maxResults: 1 }),
    )
    const id = list.data.messages?.[0]?.id
    return id ? this.getMessage(id) : null
  }
}
