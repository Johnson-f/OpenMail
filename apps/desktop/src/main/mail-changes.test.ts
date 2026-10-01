import type { StoredMessage } from '@gmail/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from './db/index'
import { upsertMessage } from './db/messages'
import { enqueue } from './db/outbox'
import { MailChangeNotifier } from './mail-changes'

const message: StoredMessage = {
  id: 'm1',
  threadId: 't1',
  from: 'a@example.com',
  to: ['b@example.com'],
  cc: [],
  subject: 'Hi',
  snippet: '',
  bodyText: 'hi',
  bodyHtml: '',
  internalDate: 1,
  labelIds: ['INBOX'],
  messageIdHeader: 'm1@example.com',
  inReplyTo: '',
  references: [],
  attachments: [],
}

describe('MailChangeNotifier', () => {
  let db: Db
  let notify: ReturnType<typeof vi.fn<() => void>>
  let notifier: MailChangeNotifier

  beforeEach(() => {
    vi.useFakeTimers()
    db = openDatabase(':memory:')
    notify = vi.fn<() => void>()
    notifier = new MailChangeNotifier(db, notify)
    notifier.start()
  })

  afterEach(() => {
    notifier.stop()
    vi.useRealTimers()
  })

  it('does not notify when nothing changed', () => {
    vi.advanceTimersByTime(5000)
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies once, debounced, after an upsert recorded as a mail event', () => {
    upsertMessage(db, 1, message, { eventKey: 'e1', origin: 'incremental' })
    vi.advanceTimersByTime(1000)
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(notify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('notifies after an outbox enqueue', () => {
    notifier.check()
    enqueue(db, 1, 'm1', ['STARRED'], [])
    vi.advanceTimersByTime(1250)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('coalesces several changes within the debounce window', () => {
    enqueue(db, 1, 'm1', ['STARRED'], [])
    notifier.check()
    enqueue(db, 1, 'm1', [], ['STARRED'])
    notifier.check()
    vi.advanceTimersByTime(250)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
