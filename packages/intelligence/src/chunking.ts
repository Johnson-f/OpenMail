import { createHash } from 'node:crypto'
import type { StoredMessage } from '@gmail/core'
import { htmlToText, type ExtractionResult } from './extraction'

export type KnowledgeChunk = {
  id: string
  accountId: number
  threadId: string
  messageId: string
  attachmentPartId?: string
  sourceType: 'message' | 'attachment'
  sourceLocation: string
  content: string
  contentHash: string
  internalDate: number
  metadata: Record<string, unknown>
}

export type AttachmentExtraction = {
  partId: string
  filename: string
  mimeType: string
  result: ExtractionResult
}

export function chunkMessage(
  accountId: number,
  message: StoredMessage,
  attachments: AttachmentExtraction[] = [],
  options: { maxCharacters?: number; overlapCharacters?: number } = {},
): KnowledgeChunk[] {
  const maxCharacters = options.maxCharacters ?? 2400
  const overlap = Math.min(options.overlapCharacters ?? 240, Math.floor(maxCharacters / 3))
  const body = removeQuotedHistory(message.bodyText.trim() || htmlFallback(message.bodyHtml))
  const metadata = {
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    messageIdHeader: message.messageIdHeader,
  }
  const chunks = splitText(body, maxCharacters, overlap).map((content, index) =>
    makeChunk({
      accountId,
      message,
      sourceType: 'message',
      sourceLocation: `body:${index + 1}`,
      content: withEnvelope(message, content),
      metadata,
    }),
  )

  for (const attachment of attachments) {
    for (const section of attachment.result.sections) {
      for (const [index, content] of splitText(section.text, maxCharacters, overlap).entries()) {
        chunks.push(
          makeChunk({
            accountId,
            message,
            attachmentPartId: attachment.partId,
            sourceType: 'attachment',
            sourceLocation: `${section.location}:chunk:${index + 1}`,
            content: withEnvelope(message, content, attachment.filename),
            metadata: { ...metadata, filename: attachment.filename, mimeType: attachment.mimeType },
          }),
        )
      }
    }
  }
  return chunks
}

function makeChunk(input: {
  accountId: number
  message: StoredMessage
  attachmentPartId?: string
  sourceType: 'message' | 'attachment'
  sourceLocation: string
  content: string
  metadata: Record<string, unknown>
}): KnowledgeChunk {
  const contentHash = hash(input.content)
  const id = hash(
    [input.accountId, input.message.id, input.attachmentPartId ?? '', input.sourceLocation, contentHash].join(':'),
  )
  return {
    id,
    accountId: input.accountId,
    threadId: input.message.threadId,
    messageId: input.message.id,
    ...(input.attachmentPartId ? { attachmentPartId: input.attachmentPartId } : {}),
    sourceType: input.sourceType,
    sourceLocation: input.sourceLocation,
    content: input.content,
    contentHash,
    internalDate: input.message.internalDate,
    metadata: input.metadata,
  }
}

function withEnvelope(message: StoredMessage, content: string, filename?: string): string {
  const header = [
    `Subject: ${message.subject}`,
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    `Date: ${new Date(message.internalDate).toISOString()}`,
    ...(filename ? [`Attachment: ${filename}`] : []),
  ]
  return `${header.join('\n')}\n\n${content}`.trim()
}

function removeQuotedHistory(text: string): string {
  const markers = [
    /^On .+wrote:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^From:\s.+\nSent:\s.+\nTo:\s/im,
  ]
  let end = text.length
  for (const marker of markers) {
    const match = marker.exec(text)
    if (match?.index !== undefined) end = Math.min(end, match.index)
  }
  return text.slice(0, end).replace(/\n--\s*\n[\s\S]*$/, '').trim()
}

function htmlFallback(html: string): string {
  return htmlToText(html)
}

function splitText(text: string, maxCharacters: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  if (normalized.length <= maxCharacters) return [normalized]
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + maxCharacters, normalized.length)
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf('\n\n', end)
      const sentence = normalized.lastIndexOf('. ', end)
      const candidate = Math.max(paragraph, sentence)
      if (candidate > start + maxCharacters / 2) end = candidate + (candidate === sentence ? 1 : 0)
    }
    chunks.push(normalized.slice(start, end).trim())
    if (end >= normalized.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks.filter(Boolean)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
