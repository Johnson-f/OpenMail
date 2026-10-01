import { randomBytes } from 'node:crypto'
import type { OutgoingAttachment, OutgoingMessage } from '@gmail/core'

const CRLF = '\r\n'

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

const isAscii = (value: string): boolean => /^[\x20-\x7E]*$/.test(value)

function encodedWords(value: string): string {
  const words: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const char of value) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (chunkBytes + bytes > 36) {
      words.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += char
    chunkBytes += bytes
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

function encodeHeader(value: string): string {
  const clean = cleanHeader(value)
  return isAscii(clean) ? clean : encodedWords(clean)
}

function encodeAddress(value: string): string {
  const clean = cleanHeader(value)
  if (isAscii(clean)) return clean
  const match = /^(.*?)\s*<([^>]*)>$/.exec(clean)
  if (!match) return clean
  const name = (match[1] ?? '').replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')
  return `${encodedWords(name)} <${match[2]}>`
}

function encodeAddressList(values: string[]): string {
  return values.map(encodeAddress).join(`,${CRLF} `)
}

function base64Lines(data: Uint8Array): string {
  return Buffer.from(data).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd()
}

const QP_LINE_LIMIT = 76

function qpTokens(line: string): string[] {
  const tokens: string[] = []
  for (const byte of Buffer.from(line, 'utf8')) {
    const literal = byte === 0x20 || byte === 0x09 || (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d)
    tokens.push(literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
  }
  const last = tokens[tokens.length - 1]
  if (last === ' ' || last === '\t') tokens[tokens.length - 1] = `=${last === ' ' ? '20' : '09'}`
  return tokens
}

function qpLine(line: string): string[] {
  const tokens = qpTokens(line)
  const out: string[] = []
  let current = ''
  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1
    const limit = isLast ? QP_LINE_LIMIT : QP_LINE_LIMIT - 1
    if (current.length + token.length > limit) {
      let carried = ''
      if (current.endsWith(' ') || current.endsWith('\t')) {
        carried = current.slice(-1)
        current = current.slice(0, -1)
      }
      out.push(`${current}=`)
      current = carried
    }
    current += token
  })
  out.push(current)
  return out
}

function quotedPrintable(value: string): string {
  return value
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .flatMap(qpLine)
    .join(CRLF)
}

function quotedFilename(value: string): string {
  return cleanHeader(value).replace(/["\\]/g, '\\$&')
}

function rfc2231Value(value: string): string {
  return [...Buffer.from(cleanHeader(value), 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
}

function parameter(name: string, value: string): string {
  return isAscii(cleanHeader(value))
    ? `${name}="${quotedFilename(value)}"`
    : `${name}*=UTF-8''${rfc2231Value(value)}`
}

function attachmentPart(boundary: string, attachment: OutgoingAttachment): string {
  const disposition = attachment.disposition ?? (attachment.contentId ? 'inline' : 'attachment')
  const headers = [
    `--${boundary}`,
    `Content-Type: ${cleanHeader(attachment.mimeType)};${CRLF} ${parameter('name', attachment.filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition};${CRLF} ${parameter('filename', attachment.filename)}`,
  ]
  if (attachment.contentId) headers.push(`Content-ID: <${cleanHeader(attachment.contentId).replace(/[<>]/g, '')}>`)
  return [...headers, '', base64Lines(attachment.data)].join(CRLF)
}

export function buildRawMessage(message: OutgoingMessage): string {
  if (message.to.length === 0 && (message.cc?.length ?? 0) === 0 && (message.bcc?.length ?? 0) === 0) {
    throw new Error('At least one recipient is required')
  }
  if (!message.messageId.trim()) throw new Error('A stable Message-ID is required')

  const messageId = cleanHeader(message.messageId).replace(/[<>]/g, '')
  const headers = [
    ...(message.from ? [`From: ${encodeAddress(message.from)}`] : []),
    `To: ${encodeAddressList(message.to)}`,
    ...(message.cc?.length ? [`Cc: ${encodeAddressList(message.cc)}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${encodeAddressList(message.bcc)}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
  ]
  if (message.inReplyTo) headers.push(`In-Reply-To: <${cleanHeader(message.inReplyTo).replace(/[<>]/g, '')}>`)
  if (message.references?.length) {
    headers.push(`References: ${message.references.map((ref) => `<${cleanHeader(ref).replace(/[<>]/g, '')}>`).join(' ')}`)
  }

  const hasHtml = Boolean(message.bodyHtml)
  const attachments = message.attachments ?? []
  const mixedBoundary = `openmail-mixed-${randomBytes(12).toString('hex')}`
  const altBoundary = `openmail-alt-${randomBytes(12).toString('hex')}`
  const parts: string[] = []

  if (attachments.length > 0) headers.push(`Content-Type: multipart/mixed;${CRLF} boundary="${mixedBoundary}"`)
  else if (hasHtml) headers.push(`Content-Type: multipart/alternative;${CRLF} boundary="${altBoundary}"`)
  else {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable')
  }

  if (attachments.length > 0) {
    if (hasHtml) {
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: multipart/alternative;${CRLF} boundary="${altBoundary}"`,
        '',
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(message.bodyText),
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(message.bodyHtml ?? ''),
        `--${altBoundary}--`,
      )
    } else {
      parts.push(
        `--${mixedBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(message.bodyText),
      )
    }
    for (const attachment of attachments) parts.push(attachmentPart(mixedBoundary, attachment))
    parts.push(`--${mixedBoundary}--`)
  } else if (hasHtml) {
    parts.push(
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(message.bodyText),
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(message.bodyHtml ?? ''),
      `--${altBoundary}--`,
    )
  } else {
    parts.push(quotedPrintable(message.bodyText))
  }

  return Buffer.from([...headers, '', ...parts].join(CRLF), 'utf8').toString('base64url')
}
