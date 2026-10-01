import type { StoredMessage } from '@gmail/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './index.js'
import { listThreads, mailboxCounts, upsertMessage } from './messages.js'
import {
  abandonRow,
  effectiveLabels,
  enqueue,
  markFailed,
  markUploaded,
  pendingRows,
} from './outbox.js'

function msgWithLabels(labelIds: string[], overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    cc: [],
    subject: 'Hello',
    snippet: 'Hello there',
    bodyText: 'Hello there',
    bodyHtml: '<p>Hello there</p>',
    internalDate: 1000,
    labelIds,
    messageIdHeader: 'm1@example.com',
    inReplyTo: '',
    references: [],
    attachments: [],
    ...overrides,
  }
}

describe('outbox', () => {
  let db: Db
  const accountId = 1

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  describe('enqueue', () => {
    it('throws when add and remove are both empty', () => {
      expect(() => enqueue(db, accountId, 'm1', [], [])).toThrow()
    })

    it('throws when add and remove overlap', () => {
      expect(() => enqueue(db, accountId, 'm1', ['STARRED'], ['STARRED'])).toThrow()
    })

    it('returns an increasing row id', () => {
      const id1 = enqueue(db, accountId, 'm1', ['STARRED'], [])
      const id2 = enqueue(db, accountId, 'm1', [], ['INBOX'])
      expect(id2).toBeGreaterThan(id1)
    })
  })

  describe('effectiveLabels', () => {
    it('is exactly the stored labels when there is nothing pending', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'UNREAD'])
    })

    it('applies pending adds and removes on top of the stored labels', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      enqueue(db, accountId, 'm1', ['STARRED'], ['UNREAD'])
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'STARRED'])
    })

    it('replays multiple rows in id order, removes then adds within a row', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      enqueue(db, accountId, 'm1', ['UNREAD'], [])
      enqueue(db, accountId, 'm1', [], ['UNREAD'])
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX'])
    })

    // The whole point of this design: incremental sync can overwrite
    // message_labels with Gmail's state at any moment, but a local change
    // that hasn't uploaded yet is replayed on top, so it never gets lost.
    it('survives a sync that rewrote the stored row', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      enqueue(db, accountId, 'm1', [], ['INBOX'])

      // Simulate incremental sync overwriting with Gmail's state, which
      // still has INBOX because our change has not uploaded yet.
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD', 'STARRED']))

      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['STARRED', 'UNREAD'])
    })

    it('stops replaying abandoned rows, so the next sync returns to Gmail state', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      const id = enqueue(db, accountId, 'm1', ['STARRED'], [])
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'STARRED'])

      abandonRow(db, id, 'gave up')
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'STARRED'])

      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX'])
    })

    it('applies the change when it is enqueued, in the same step as the outbox row', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      enqueue(db, accountId, 'm1', [], ['INBOX'])

      const stored = db.prepare(`SELECT label_id FROM message_labels WHERE message_id = 'm1'`).all()
      expect(stored).toEqual([{ label_id: 'UNREAD' }])
    })

    it('replays a change enqueued before the message was stored', () => {
      enqueue(db, accountId, 'm1', [], ['INBOX'])
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['UNREAD'])
    })

    it('keeps replaying a failed row after a sync', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      const id = enqueue(db, accountId, 'm1', [], ['INBOX'])
      markFailed(db, id, 'network')
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      expect(effectiveLabels(db, accountId, 'm1')).toEqual([])
    })

    it('still replays failed rows (they are retried, not abandoned)', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      const id = enqueue(db, accountId, 'm1', ['STARRED'], [])
      markFailed(db, id, 'network error')
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'STARRED'])
    })

    it('stops replaying uploaded rows', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      const id = enqueue(db, accountId, 'm1', ['STARRED'], [])
      markUploaded(db, id, 'h123')
      // Simulate the follow-up sync that picks up the now-uploaded change.
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'STARRED']))
      expect(effectiveLabels(db, accountId, 'm1')).toEqual(['INBOX', 'STARRED'])
    })

    it('never leaks pending changes across accounts', () => {
      upsertMessage(db, 1, msgWithLabels(['INBOX']))
      upsertMessage(db, 2, msgWithLabels(['INBOX']))
      enqueue(db, 1, 'm1', ['STARRED'], [])

      expect(effectiveLabels(db, 1, 'm1')).toEqual(['INBOX', 'STARRED'])
      expect(effectiveLabels(db, 2, 'm1')).toEqual(['INBOX'])
    })
  })

  describe('local-first lists', () => {
    it('drops an archived thread from the inbox immediately and keeps it out across a stale sync', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      expect(listThreads(db, accountId, 'INBOX', 10).map((t) => t.threadId)).toEqual(['t1'])

      const id = enqueue(db, accountId, 'm1', [], ['INBOX'])

      expect(listThreads(db, accountId, 'INBOX', 10)).toEqual([])
      expect(mailboxCounts(db, accountId, ['INBOX'])[0]).toMatchObject({ total: 0, unread: 0 })

      upsertMessage(db, accountId, msgWithLabels(['INBOX', 'UNREAD']))
      expect(listThreads(db, accountId, 'INBOX', 10)).toEqual([])

      markUploaded(db, id, 'h1')
      upsertMessage(db, accountId, msgWithLabels(['UNREAD']))
      expect(listThreads(db, accountId, 'INBOX', 10)).toEqual([])
    })

    it('returns the thread to the inbox when the archive is abandoned and Gmail state is re-read', () => {
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      const id = enqueue(db, accountId, 'm1', [], ['INBOX'])
      abandonRow(db, id, 'gave up')
      upsertMessage(db, accountId, msgWithLabels(['INBOX']))
      expect(listThreads(db, accountId, 'INBOX', 10)).toHaveLength(1)
    })
  })

  describe('pendingRows', () => {
    it('returns pending and failed rows oldest first, excluding uploaded/abandoned', () => {
      const id1 = enqueue(db, accountId, 'm1', ['A'], [])
      const id2 = enqueue(db, accountId, 'm1', ['B'], [])
      const id3 = enqueue(db, accountId, 'm1', ['C'], [])
      markUploaded(db, id1, 'h1')
      markFailed(db, id2, 'oops')
      const id4 = enqueue(db, accountId, 'm1', ['D'], [])
      abandonRow(db, id4, 'nope')

      const rows = pendingRows(db, accountId)
      expect(rows.map((r) => r.id)).toEqual([id2, id3])
      expect(rows[0]?.attempts).toBe(1)
    })

    it('never leaks rows across accounts', () => {
      enqueue(db, 1, 'm1', ['A'], [])
      enqueue(db, 2, 'm1', ['B'], [])
      expect(pendingRows(db, 1)).toHaveLength(1)
      expect(pendingRows(db, 2)).toHaveLength(1)
    })
  })

  describe('markUploaded / markFailed / abandonRow', () => {
    it('markUploaded records status and history id', () => {
      const id = enqueue(db, accountId, 'm1', ['A'], [])
      markUploaded(db, id, 'h999')
      const row = db.prepare(`SELECT status, uploaded_at_history_id FROM outbox WHERE id = ?`).get(id) as {
        status: string
        uploaded_at_history_id: string
      }
      expect(row.status).toBe('uploaded')
      expect(row.uploaded_at_history_id).toBe('h999')
    })

    it('markFailed increments attempts each call', () => {
      const id = enqueue(db, accountId, 'm1', ['A'], [])
      markFailed(db, id, 'err1')
      markFailed(db, id, 'err2')
      const row = db.prepare(`SELECT status, attempts, last_error FROM outbox WHERE id = ?`).get(id) as {
        status: string
        attempts: number
        last_error: string
      }
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(2)
      expect(row.last_error).toBe('err2')
    })

    it('abandonRow sets status abandoned and increments attempts', () => {
      const id = enqueue(db, accountId, 'm1', ['A'], [])
      markFailed(db, id, 'err1')
      abandonRow(db, id, 'giving up')
      const row = db.prepare(`SELECT status, attempts, last_error FROM outbox WHERE id = ?`).get(id) as {
        status: string
        attempts: number
        last_error: string
      }
      expect(row.status).toBe('abandoned')
      expect(row.attempts).toBe(2)
      expect(row.last_error).toBe('giving up')
    })
  })
})
