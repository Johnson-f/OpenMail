import type { StoredMessage } from '@gmail/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './index.js'
import { beginResync, deleteMessage, getMessage, listThreads, mailboxCounts, sweepUnseen, THREAD_PAGE_SQL, upsertMessage } from './messages.js'
import { enqueue } from './outbox.js'

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
    messageIdHeader: 'm1@example.com',
    inReplyTo: '',
    references: [],
    attachments: [],
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

  it('records a transactional mail event once for a stable key', () => {
    const event = { eventKey: 'history:1', origin: 'incremental' as const, historyId: '10' }
    upsertMessage(db, accountId, makeMessage(), event)
    upsertMessage(db, accountId, makeMessage({ subject: 'updated' }), event)

    expect(db.prepare('SELECT event_key, origin FROM mail_events').all()).toEqual([
      { event_key: 'history:1', origin: 'incremental' },
    ])
    expect(getMessage(db, accountId, 'm1')?.subject).toBe('updated')
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

describe('resync sweep', () => {
  let db: Db
  const accountId = 1

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare(`INSERT INTO accounts (id, email, encrypted_refresh_token, created_at) VALUES (1, 'a@x.com', x'00', 0)`).run()
  })

  const eventFor = (key: string) => ({ eventKey: key, origin: 'backfill' as const })

  it('deletes only messages not seen since beginResync', () => {
    upsertMessage(db, accountId, makeMessage({ id: 'old' }))
    upsertMessage(db, accountId, makeMessage({ id: 'kept' }))

    beginResync(db, accountId)
    upsertMessage(db, accountId, makeMessage({ id: 'kept' }), eventFor('k'))
    sweepUnseen(db, accountId)

    expect(getMessage(db, accountId, 'old')).toBeNull()
    expect(getMessage(db, accountId, 'kept')).not.toBeNull()
  })

  it('records reconciliation delete events and abandons the outbox rows', () => {
    upsertMessage(db, accountId, makeMessage({ id: 'old' }))
    const rowId = enqueue(db, accountId, 'old', ['STARRED'], [])

    beginResync(db, accountId)
    sweepUnseen(db, accountId)

    expect(
      db.prepare(`SELECT kind, origin FROM mail_events WHERE event_key = 'resync:1:1:old'`).get(),
    ).toEqual({ kind: 'message_deleted', origin: 'reconciliation' })
    expect(db.prepare(`SELECT status FROM outbox WHERE id = ?`).get(rowId)).toEqual({ status: 'abandoned' })
  })

  it('does nothing without a resync in progress', () => {
    upsertMessage(db, accountId, makeMessage({ id: 'old' }))
    sweepUnseen(db, accountId)
    expect(getMessage(db, accountId, 'old')).not.toBeNull()
  })

  describe('thread paging and aggregates', () => {
    const seed = () => {
      upsertMessage(db, accountId, makeMessage({ id: 'a1', threadId: 'ta', internalDate: 1000, labelIds: ['INBOX', 'UNREAD'], subject: 'A old' }))
      upsertMessage(db, accountId, makeMessage({
        id: 'a2', threadId: 'ta', internalDate: 5000, labelIds: ['INBOX', 'STARRED'], subject: 'A new',
        attachments: [{ partId: '1', filename: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 1, disposition: 'attachment' }],
      }))
      upsertMessage(db, accountId, makeMessage({ id: 'b1', threadId: 'tb', internalDate: 3000, labelIds: ['INBOX'], subject: 'B' }))
      upsertMessage(db, accountId, makeMessage({ id: 'c1', threadId: 'tc', internalDate: 2000, labelIds: ['INBOX', 'UNREAD'], subject: 'C old' }))
      upsertMessage(db, accountId, makeMessage({ id: 'c2', threadId: 'tc', internalDate: 9000, labelIds: ['SENT'], subject: 'C reply' }))
      upsertMessage(db, accountId, makeMessage({ id: 'd1', threadId: 'td', internalDate: 8000, labelIds: ['SENT'], subject: 'D' }))
    }

    it('orders by newest message in the thread, even when it lacks the label', () => {
      seed()
      const threads = listThreads(db, accountId, 'INBOX', 10)
      expect(threads.map((t) => t.threadId)).toEqual(['tc', 'ta', 'tb'])
      expect(threads[0]).toMatchObject({ subject: 'C reply', lastMessageAt: 9000, messageCount: 2, unread: true, starred: false })
      expect(threads[1]).toMatchObject({ subject: 'A new', messageCount: 2, unread: true, starred: true, hasAttachment: true })
      expect(threads[2]).toMatchObject({ messageCount: 1, unread: false, hasAttachment: false })
    })

    it('limits the page after ordering', () => {
      seed()
      expect(listThreads(db, accountId, 'INBOX', 2).map((t) => t.threadId)).toEqual(['tc', 'ta'])
      expect(listThreads(db, accountId, 'NOPE', 5)).toEqual([])
    })

    it('selects the page by probing indexes per thread, never scanning messages', () => {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${THREAD_PAGE_SQL}`)
        .all({ accountId, labelId: 'INBOX', limit: 10 })
        .map((row) => (row as { detail: string }).detail)
        .join('\n')
      expect(plan).toContain('idx_messages_account_thread_date')
      expect(plan).toContain('sqlite_autoindex_message_labels_1')
      expect(plan).not.toMatch(/SCAN (m|ml|messages|message_labels)\b/)
    })

    it('recomputes the thread row when a message is deleted and removes it when empty', () => {
      seed()
      deleteMessage(db, accountId, 'c2')
      expect(db.prepare(`SELECT subject, last_message_at AS at FROM threads WHERE id = 'tc'`).get()).toEqual({
        subject: 'C old',
        at: 2000,
      })
      deleteMessage(db, accountId, 'c1')
      expect(db.prepare(`SELECT 1 FROM threads WHERE id = 'tc'`).get()).toBeUndefined()
    })

    it('counts mailboxes in one grouped query with zero rows for empty labels', () => {
      seed()
      db.prepare(`INSERT INTO labels (account_id, id, name) VALUES (1, 'INBOX', 'Inbox')`).run()
      expect(mailboxCounts(db, accountId, ['INBOX', 'SENT', 'STARRED', 'TRASH'])).toEqual([
        { labelId: 'INBOX', name: 'Inbox', total: 4, unread: 2 },
        { labelId: 'SENT', name: 'SENT', total: 2, unread: 0 },
        { labelId: 'STARRED', name: 'STARRED', total: 1, unread: 0 },
        { labelId: 'TRASH', name: 'TRASH', total: 0, unread: 0 },
      ])
    })
  })
})
