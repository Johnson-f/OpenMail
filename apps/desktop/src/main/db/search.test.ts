import type { StoredMessage } from '@gmail/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './index.js'
import { upsertMessage } from './messages.js'
import { searchMessages } from './search.js'

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    cc: [],
    subject: 'Quarterly report',
    snippet: 'Attached is the quarterly report',
    bodyText: 'Attached is the quarterly report for review.',
    bodyHtml: '<p>Attached is the quarterly report for review.</p>',
    internalDate: 1000,
    labelIds: ['INBOX'],
    ...overrides,
  }
}

describe('searchMessages', () => {
  let db: Db
  const accountId = 1

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  it('finds a message by a subject word', () => {
    upsertMessage(db, accountId, makeMessage())
    const hits = searchMessages(db, accountId, 'quarterly', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.messageId).toBe('m1')
    expect(hits[0]?.threadId).toBe('t1')
  })

  it('finds a message by a body word', () => {
    upsertMessage(db, accountId, makeMessage())
    const hits = searchMessages(db, accountId, 'review', 10)
    expect(hits).toHaveLength(1)
  })

  it('returns [] for an empty query without touching the database', () => {
    expect(searchMessages(db, accountId, '', 10)).toEqual([])
    expect(searchMessages(db, accountId, '   ', 10)).toEqual([])
  })

  it('treats a stray double quote as literal text, never as a SQL/FTS error', () => {
    upsertMessage(db, accountId, makeMessage())
    expect(() => searchMessages(db, accountId, '"', 10)).not.toThrow()
    expect(() => searchMessages(db, accountId, 'quarterly"', 10)).not.toThrow()
    expect(searchMessages(db, accountId, 'quarterly"', 10)).toHaveLength(1)
  })

  it('treats a bare boolean keyword as a literal word, not an operator', () => {
    upsertMessage(db, accountId, makeMessage({ subject: 'AND this OR that' }))
    expect(() => searchMessages(db, accountId, 'AND', 10)).not.toThrow()
    const hits = searchMessages(db, accountId, 'AND', 10)
    expect(hits).toHaveLength(1)
  })

  it('never raises on other FTS5 syntax characters', () => {
    upsertMessage(db, accountId, makeMessage())
    for (const query of ['*', ':', '^', '-', 'foo*', 'foo:bar', 'foo^2', '-foo', 'NEAR(a b)']) {
      expect(() => searchMessages(db, accountId, query, 10)).not.toThrow()
    }
  })

  it('reflects an edit after a re-upsert', () => {
    upsertMessage(db, accountId, makeMessage({ subject: 'Original subject', bodyText: 'original body' }))
    expect(searchMessages(db, accountId, 'original', 10)).toHaveLength(1)
    expect(searchMessages(db, accountId, 'rewritten', 10)).toHaveLength(0)

    upsertMessage(db, accountId, makeMessage({ subject: 'Rewritten subject', bodyText: 'rewritten body' }))

    expect(searchMessages(db, accountId, 'rewritten', 10)).toHaveLength(1)
    expect(searchMessages(db, accountId, 'original', 10)).toHaveLength(0)
  })

  it('never leaks search hits across accounts', () => {
    upsertMessage(db, 1, makeMessage({ id: 'm1', subject: 'Alpha secrets' }))
    upsertMessage(db, 2, makeMessage({ id: 'm2', subject: 'Alpha secrets' }))

    expect(searchMessages(db, 1, 'alpha', 10)).toHaveLength(1)
    expect(searchMessages(db, 1, 'alpha', 10)[0]?.messageId).toBe('m1')
    expect(searchMessages(db, 2, 'alpha', 10)[0]?.messageId).toBe('m2')
  })

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      upsertMessage(db, accountId, makeMessage({ id: `m${i}`, threadId: `t${i}` }))
    }
    expect(searchMessages(db, accountId, 'quarterly', 2)).toHaveLength(2)
  })
})
