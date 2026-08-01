import { google, gmail_v1 } from 'googleapis'
import type { StoredMessage, Label } from '@gmail/core'
import { HistoryExpiredError, type GmailApi, type HistoryChange, type HistoryPage } from './types'

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504])
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

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt += 1
      const status = extractStatus(err)
      if (status === undefined || !RETRYABLE_STATUS.has(status) || attempt >= MAX_ATTEMPTS) {
        throw err
      }
      const cap = Math.min(MAX_DELAY_MS, 2 ** attempt * 1000)
      const delay = Math.random() * cap
      await sleep(delay)
    }
  }
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  const lower = name.toLowerCase()
  const found = headers.find((h) => (h.name ?? '').toLowerCase() === lower)
  return found?.value ?? ''
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

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): { text: string; html: string } {
  let text = ''
  let html = ''

  const visit = (part: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!part || (text && html)) return
    const mimeType = part.mimeType ?? ''
    const data = part.body?.data
    if (mimeType === 'text/plain' && data && !text) {
      text = Buffer.from(data, 'base64url').toString('utf-8')
    } else if (mimeType === 'text/html' && data && !html) {
      html = Buffer.from(data, 'base64url').toString('utf-8')
    }
    for (const child of part.parts ?? []) {
      visit(child)
      if (text && html) return
    }
  }

  visit(payload)
  return { text, html }
}

export class GoogleGmail implements GmailApi {
  private readonly gmail: gmail_v1.Gmail

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth })
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
    const res = await withBackoff(() => this.gmail.users.messages.get({ userId: 'me', id, format: 'full' }))
    const msg = res.data
    const headers = msg.payload?.headers ?? []
    const { text, html } = extractBodies(msg.payload)

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
    }
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
    await withBackoff(() =>
      this.gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds: add, removeLabelIds: remove },
      }),
    )
  }
}
