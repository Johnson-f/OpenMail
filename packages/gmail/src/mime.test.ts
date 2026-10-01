import { describe, expect, it } from 'vitest'
import { buildRawMessage } from './mime'

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

describe('buildRawMessage', () => {
  it('builds a threaded text message with a stable Message-ID', () => {
    const raw = decode(
      buildRawMessage({
        from: 'Me <me@example.com>',
        to: ['You <you@example.com>'],
        cc: ['Team <team@example.com>'],
        subject: 'Re: Agreement',
        bodyText: 'Confirmed.',
        messageId: 'operation-1@openmail.local',
        inReplyTo: 'original@example.com',
        references: ['first@example.com', 'original@example.com'],
      }),
    )

    expect(raw).toContain('Message-ID: <operation-1@openmail.local>')
    expect(raw).toContain('In-Reply-To: <original@example.com>')
    expect(raw).toContain('References: <first@example.com> <original@example.com>')
    expect(raw).toContain('Confirmed.')
  })

  it('builds alternative bodies and attachments', () => {
    const raw = decode(
      buildRawMessage({
        to: ['you@example.com'],
        subject: 'Résumé',
        bodyText: 'Plain',
        bodyHtml: '<strong>HTML</strong>',
        messageId: 'operation-2@openmail.local',
        attachments: [
          {
            filename: 'invoice.txt',
            mimeType: 'text/plain',
            data: Buffer.from('invoice body'),
          },
        ],
      }),
    )

    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('filename="invoice.txt"')
    expect(raw).toContain(Buffer.from('invoice body').toString('base64'))
    expect(raw).toContain('Subject: =?UTF-8?B?')
  })

  it('rejects header injection and messages without recipients', () => {
    expect(() =>
      buildRawMessage({
        to: [],
        subject: 'none',
        bodyText: '',
        messageId: 'none@example.com',
      }),
    ).toThrow(/recipient/)

    const raw = decode(
      buildRawMessage({
        to: ['victim@example.com\r\nBcc: attacker@example.com'],
        subject: 'safe',
        bodyText: '',
        messageId: 'safe@example.com',
      }),
    )
    expect(raw).not.toContain('\r\nBcc: attacker@example.com')
    expect(raw).toContain('victim@example.com Bcc: attacker@example.com')
  })
})

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = []
  const unwrapped = value.replace(/=\r\n/g, '')
  for (let i = 0; i < unwrapped.length; i += 1) {
    const char = unwrapped[i] as string
    if (char === '=') {
      bytes.push(parseInt(unwrapped.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(...Buffer.from(char, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

function bodyOf(raw: string): string {
  return raw.slice(raw.indexOf('\r\n\r\n') + 4)
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/\r\n /g, ' ')
    .replace(/(=\?UTF-8\?B\?[^?]+\?=) (?==\?UTF-8)/g, '$1')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'))
}

describe('quoted-printable bodies', () => {
  const body = [
    'Line with trailing space ',
    'Tab at end\t',
    `${'word '.repeat(40)}end`,
    'x'.repeat(200),
    'Caf\u00e9 \u00fcber na\u00efve \u65e5\u672c\u8a9e '.repeat(12),
    'a = b',
    '',
    'last',
  ].join('\n')

  it('keeps every line within 78 bytes including CRLF and round-trips', () => {
    const raw = decode(
      buildRawMessage({ to: ['you@example.com'], subject: 'qp', bodyText: body, messageId: 'qp@example.com' }),
    )
    const encoded = bodyOf(raw)

    for (const line of encoded.split('\r\n')) expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(78)
    expect(encoded).not.toMatch(/[ \t]\r\n/)
    expect(encoded).not.toMatch(/[ \t]$/)
    expect(encoded).not.toMatch(/(?<!\r)\n/)
    expect(decodeQuotedPrintable(encoded)).toBe(body.replace(/\n/g, '\r\n'))
  })

  it('normalises bare LF and CR line endings to CRLF', () => {
    const raw = decode(
      buildRawMessage({ to: ['you@example.com'], subject: 'qp', bodyText: 'a\nb\rc\r\nd', messageId: 'qp@example.com' }),
    )
    expect(bodyOf(raw)).toBe('a\r\nb\r\nc\r\nd')
  })

  it('wraps html and attachment-bearing parts too', () => {
    const raw = decode(
      buildRawMessage({
        to: ['you@example.com'],
        subject: 'qp',
        bodyText: 'x'.repeat(300),
        bodyHtml: `<p>${'y'.repeat(300)}</p>`,
        messageId: 'qp@example.com',
        attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(500, 7) }],
      }),
    )
    for (const line of raw.split('\r\n')) expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(78)
  })
})

describe('headers and filenames', () => {
  it('encodes only the display name of a non-ASCII address', () => {
    const raw = decode(
      buildRawMessage({
        from: 'Jos\u00e9 <jose@x.com>',
        to: ['Zo\u00eb <z@x.com>', 'plain@x.com'],
        subject: 's',
        bodyText: 'b',
        messageId: 'h@example.com',
      }),
    )
    const to = /^To: ((?:.|\r\n )*)$/m.exec(raw)?.[1] as string

    expect(to).toContain(' <z@x.com>')
    expect(to).toContain('plain@x.com')
    expect(to).not.toMatch(/=\?UTF-8\?B\?[^?]*\?=[^ ]*z@x\.com/)
    expect(decodeEncodedWords(to)).toBe('Zo\u00eb <z@x.com>, plain@x.com')
    expect(raw).toMatch(/^From: =\?UTF-8\?B\?[^?]+\?= <jose@x\.com>$/m)
  })

  it('folds long encoded subjects into short encoded words', () => {
    const subject = '\u65e5\u672c\u8a9e'.repeat(30)
    const raw = decode(buildRawMessage({ to: ['a@x.com'], subject, bodyText: 'b', messageId: 'h@example.com' }))
    const header = /^Subject: ((?:.|\r\n )*)$/m.exec(raw)?.[1] as string

    for (const line of `Subject: ${header}`.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    expect(decodeEncodedWords(header)).toBe(subject)
  })

  it('escapes quotes and backslashes in ASCII filenames', () => {
    const raw = decode(
      buildRawMessage({
        to: ['a@x.com'],
        subject: 's',
        bodyText: 'b',
        messageId: 'f@example.com',
        attachments: [{ filename: 'a"b\\c.pdf', mimeType: 'application/pdf', data: Buffer.from('x') }],
      }),
    )
    expect(raw).toContain('filename="a\\"b\\\\c.pdf"')
    expect(raw).toContain('name="a\\"b\\\\c.pdf"')
  })

  it('uses RFC 2231 for non-ASCII filenames', () => {
    const raw = decode(
      buildRawMessage({
        to: ['a@x.com'],
        subject: 's',
        bodyText: 'b',
        messageId: 'f@example.com',
        attachments: [{ filename: 'r\u00e9sum\u00e9 1.pdf', mimeType: 'application/pdf', data: Buffer.from('x') }],
      }),
    )
    const encoded = /filename\*=UTF-8''(\S+)/.exec(raw)?.[1] as string
    expect(encoded).toBe('r%C3%A9sum%C3%A9%201.pdf')
    expect(decodeURIComponent(encoded)).toBe('r\u00e9sum\u00e9 1.pdf')
    expect(raw).not.toContain('=?UTF-8?B?cs')
  })
})
