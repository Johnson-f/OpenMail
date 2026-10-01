import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@gmail/core'
import { chunkMessage } from './chunking'

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['me@example.com'],
    cc: [],
    subject: 'Renewal',
    snippet: '',
    bodyText: 'We agreed to renew at $18,000.\n\nOn Monday Alice wrote:\n> Previous quoted history',
    bodyHtml: '',
    internalDate: Date.UTC(2026, 8, 1),
    labelIds: ['INBOX'],
    messageIdHeader: 'm1@example.com',
    inReplyTo: '',
    references: [],
    attachments: [],
    ...overrides,
  }
}

describe('chunkMessage', () => {
  it('creates stable provenance-rich chunks without duplicated quoted history', () => {
    const first = chunkMessage(1, message())
    const second = chunkMessage(1, message())
    expect(first).toEqual(second)
    expect(first).toHaveLength(1)
    expect(first[0]?.content).toContain('$18,000')
    expect(first[0]?.content).not.toContain('Previous quoted history')
    expect(first[0]).toMatchObject({ accountId: 1, messageId: 'm1', sourceType: 'message' })
  })

  it('preserves attachment locations and splits long sections', () => {
    const chunks = chunkMessage(
      1,
      message({ bodyText: '' }),
      [
        {
          partId: 'a1',
          filename: 'terms.pdf',
          mimeType: 'application/pdf',
          result: {
            status: 'readable',
            sections: [{ location: 'page:2', text: 'terms '.repeat(100) }],
          },
        },
      ],
      { maxCharacters: 120, overlapCharacters: 10 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.sourceLocation.startsWith('page:2'))).toBe(true)
    expect(chunks.every((chunk) => chunk.attachmentPartId === 'a1')).toBe(true)
  })

  it('strips CSS, scripts and head content from HTML-only messages and omits labels from metadata', () => {
    const chunks = chunkMessage(
      1,
      message({
        bodyText: '',
        bodyHtml:
          '<html><head><title>News</title><style>.hero{color:red}</style></head><body><style>p{margin:0}</style><script>track()</script><p>Fish &amp; chips sale</p></body></html>',
      }),
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toContain('Fish & chips sale')
    expect(chunks[0]?.content).not.toMatch(/color:red|margin|track\(\)/)
    expect(chunks[0]?.metadata).not.toHaveProperty('labels')
  })
})
