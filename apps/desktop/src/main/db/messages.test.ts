import type { StoredMessage } from '@gmail/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './index.js'
import { deleteMessage, getMessage, listThreads, upsertMessage } from './messages.js'

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    cc: [],
    subject: 'Hello',
    snippet: 'Hello there',
    bodyText: 'Hello there, plain text.',
    bodyHtml: '<p>Hello there, plain text.</p>',
    internalDate: 1000,
    labelIds: ['INBOX', 'UNREAD'],
    ...overrides,
  }
}

describe('messages', () => {
  let db: Db
  const accountId = 1

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  it('round-trips a message with sorted labels', () => {
    upsertMessage(db, accountId, makeMessage({ labelIds: ['UNREAD', 'INBOX'] }))

    const result = getMessage(db, accountId, 'm1')
    expect(result).not.toBeNull()
    expect(result?.id).toBe('m1')
    expect(result?.threadId).toBe('t1')
    expect(result?.to).toEqual(['recipient@example.com'])
    expect(result?.labelIds).toEqual(['INBOX', 'UNREAD'])
  })

  it('returns null for a message that does not exist', () => {
    expect(getMessage(db, accountId, 'missing')).toBeNull()
  })

  it('replaces labels on re-upsert instead of accumulating them', () => {
    upsertMessage(db, accountId, makeMessage({ labelIds: ['INBOX', 'UNREAD'] }))
    upsertMessage(db, accountId, makeMessage({ labelIds: ['INBOX', 'STARRED'] }))

    const result = getMessage(db, accountId, 'm1')
    expect(result?.labelIds).toEqual(['INBOX', 'STARRED'])
  })

  it('keeps the thread last_message_at at the max of all upserts', () => {
    upsertMessage(db, accountId, makeMessage({ id: 'm1', internalDate: 5000 }))
    upsertMessage(db, accountId, makeMessage({ id: 'm2', internalDate: 3000 }))

    const threads = listThreads(db, accountId, 'INBOX', 10)
    expect(threads).toHaveLength(1)
    expect(threads[0]?.lastMessageAt).toBe(5000)
    expect(threads[0]?.messageCount).toBe(2)
  })

  it('deletes a message and its labels', () => {
    upsertMessage(db, accountId, makeMessage())
    deleteMessage(db, accountId, 'm1')

    expect(getMessage(db, accountId, 'm1')).toBeNull()
    const labelRows = db.prepare(`SELECT * FROM message_labels WHERE message_id = ?`).all('m1')
    expect(labelRows).toHaveLength(0)
  })

  it('never leaks messages across accounts', () => {
    upsertMessage(db, 1, makeMessage({ id: 'm1', subject: 'Account 1' }))
    upsertMessage(db, 2, makeMessage({ id: 'm1', subject: 'Account 2' }))

    expect(getMessage(db, 1, 'm1')?.subject).toBe('Account 1')
    expect(getMessage(db, 2, 'm1')?.subject).toBe('Account 2')

    deleteMessage(db, 1, 'm1')
    expect(getMessage(db, 1, 'm1')).toBeNull()
    expect(getMessage(db, 2, 'm1')).not.toBeNull()
  })

  describe('listThreads', () => {
    it('only returns threads that have a message with the given label', () => {
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm1', threadId: 't1', internalDate: 1000, labelIds: ['INBOX'] })
      )
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm2', threadId: 't2', internalDate: 2000, labelIds: ['SENT'] })
      )

      const threads = listThreads(db, accountId, 'INBOX', 10)
      expect(threads.map((t) => t.threadId)).toEqual(['t1'])
    })

    it('orders threads newest first and respects the limit', () => {
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm1', threadId: 't1', internalDate: 1000, labelIds: ['INBOX'] })
      )
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm2', threadId: 't2', internalDate: 3000, labelIds: ['INBOX'] })
      )
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm3', threadId: 't3', internalDate: 2000, labelIds: ['INBOX'] })
      )

      const threads = listThreads(db, accountId, 'INBOX', 2)
      expect(threads.map((t) => t.threadId)).toEqual(['t2', 't3'])
    })

    it('marks a thread unread when any message in it has the UNREAD label', () => {
      upsertMessage(
        db,
        accountId,
        makeMessage({
          id: 'm1',
          threadId: 't1',
          internalDate: 1000,
          labelIds: ['INBOX'],
        })
      )
      upsertMessage(
        db,
        accountId,
        makeMessage({
          id: 'm2',
          threadId: 't1',
          internalDate: 2000,
          labelIds: ['INBOX', 'UNREAD'],
        })
      )

      const threads = listThreads(db, accountId, 'INBOX', 10)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.unread).toBe(true)
      expect(threads[0]?.messageCount).toBe(2)
    })

    it('marks a thread read when no message in it has the UNREAD label', () => {
      upsertMessage(
        db,
        accountId,
        makeMessage({ id: 'm1', threadId: 't1', internalDate: 1000, labelIds: ['INBOX'] })
      )

      const threads = listThreads(db, accountId, 'INBOX', 10)
      expect(threads[0]?.unread).toBe(false)
    })

    it('never leaks threads across accounts', () => {
      upsertMessage(
        db,
        1,
        makeMessage({ id: 'm1', threadId: 't1', internalDate: 1000, labelIds: ['INBOX'] })
      )
      upsertMessage(
        db,
        2,
        makeMessage({ id: 'm1', threadId: 't1', internalDate: 1000, labelIds: ['INBOX'] })
      )

      expect(listThreads(db, 1, 'INBOX', 10)).toHaveLength(1)
      expect(listThreads(db, 2, 'INBOX', 10)).toHaveLength(1)

      deleteMessage(db, 1, 'm1')
      expect(listThreads(db, 1, 'INBOX', 10)).toHaveLength(0)
      expect(listThreads(db, 2, 'INBOX', 10)).toHaveLength(1)
    })
  })
})
