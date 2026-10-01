import { describe, it, expect, beforeEach } from 'vitest'
import { FakeGmail, MessageNotFoundError } from '@gmail/gmail'
import type { StoredMessage } from '@gmail/core'
import { FakeMailStore } from './testing'
import { runBackfill } from './backfill'
import { runIncrementalSync } from './incremental'
import { drainOutbox } from './drain'

const ACCOUNT = 1

describe('runBackfill', () => {
  let store: FakeMailStore
  let gmail: FakeGmail

  beforeEach(() => {
    store = new FakeMailStore([ACCOUNT])
    gmail = new FakeGmail({ pageSize: 2 })
  })

  it('downloads every message across pages', async () => {
    for (const id of ['m1', 'm2', 'm3']) gmail.seedMessage({ id, subject: `s-${id}` })

    const result = await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    expect(result).toEqual({ fetched: 3, complete: true })
    expect(store.getMessage(ACCOUNT, 'm2')?.subject).toBe('s-m2')
  })

  it('records a starting cursor so incremental sync can take over', async () => {
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    const cursor = store.getSyncCursor(ACCOUNT)
    expect(cursor.historyId).toBeTruthy()
    expect(cursor.backfillComplete).toBe(true)
  })

  it('stores the label catalog', async () => {
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    expect(store.getLabels(ACCOUNT).map((l) => l.id)).toContain('INBOX')
  })

  it('emits stable backfill events for downstream consumers', async () => {
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    expect(store.events).toHaveLength(1)
    expect(store.events[0]?.event.origin).toBe('backfill')
    expect(store.events[0]?.event.eventKey).toMatch(/^backfill:/)
  })

  it('resumes from the checkpoint instead of restarting', async () => {
    for (const id of ['m1', 'm2', 'm3', 'm4']) gmail.seedMessage({ id })

    const controller = new AbortController()
    const partial = await runBackfill(store, ACCOUNT, gmail, {
      throttleMs: 0,
      onProgress: (n) => {
        if (n >= 2) controller.abort()
      },
      signal: controller.signal,
    })

    expect(partial.complete).toBe(false)
    expect(store.getSyncCursor(ACCOUNT).backfillComplete).toBe(false)

    const resumed = await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    expect(resumed.complete).toBe(true)
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      expect(store.getMessage(ACCOUNT, id)).not.toBeNull()
    }
  })

  it('does nothing once backfill is complete', async () => {
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    gmail.seedMessage({ id: 'm2' })
    const again = await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    expect(again).toEqual({ fetched: 0, complete: true })
    expect(store.getMessage(ACCOUNT, 'm2')).toBeNull()
  })
})

describe('runIncrementalSync', () => {
  let store: FakeMailStore
  let gmail: FakeGmail

  beforeEach(async () => {
    store = new FakeMailStore([ACCOUNT])
    gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
  })

  it('applies a remote label removal', async () => {
    gmail.remoteModify('m1', [], ['INBOX'])

    const result = await runIncrementalSync(store, ACCOUNT, gmail)

    expect(result.applied).toBe(1)
    expect(store.getMessage(ACCOUNT, 'm1')?.labelIds).not.toContain('INBOX')
  })

  it('applies a remote label addition', async () => {
    gmail.remoteModify('m1', ['STARRED'], [])
    await runIncrementalSync(store, ACCOUNT, gmail)
    expect(store.getMessage(ACCOUNT, 'm1')?.labelIds).toContain('STARRED')
  })

  it('advances the cursor so the same change is not applied twice', async () => {
    gmail.remoteModify('m1', ['STARRED'], [])
    await runIncrementalSync(store, ACCOUNT, gmail)

    expect((await runIncrementalSync(store, ACCOUNT, gmail)).applied).toBe(0)
  })

  it('downloads a message that newly appeared in the mailbox', async () => {
    gmail.seedMessage({ id: 'm2', subject: 'new mail', labelIds: [] })
    // Real delivery arrives with INBOX applied, which is what puts it in the
    // history feed. The fake logs history only for label changes, so this
    // mirrors production rather than working around the fake.
    gmail.remoteModify('m2', ['INBOX'], [])

    await runIncrementalSync(store, ACCOUNT, gmail)

    expect(store.getMessage(ACCOUNT, 'm2')?.subject).toBe('new mail')
  })

  it('falls back to a full re-sync when the cursor has expired', async () => {
    gmail.expireHistoryBefore('999999')

    const result = await runIncrementalSync(store, ACCOUNT, gmail)

    expect(result.resynced).toBe(true)
    expect(store.getMessage(ACCOUNT, 'm1')).not.toBeNull()
    expect(store.getSyncCursor(ACCOUNT).backfillComplete).toBe(true)
    await expect(runIncrementalSync(store, ACCOUNT, gmail)).resolves.toEqual({ applied: 0, resynced: false })
  })

  it('refuses to run before backfill has completed', async () => {
    const fresh = new FakeMailStore([ACCOUNT])
    await expect(runIncrementalSync(fresh, ACCOUNT, gmail)).rejects.toThrow(/backfill/i)
  })
})

describe('drainOutbox', () => {
  let store: FakeMailStore
  let gmail: FakeGmail

  beforeEach(async () => {
    store = new FakeMailStore([ACCOUNT])
    gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
  })

  it('uploads a pending row and clears it from the queue', async () => {
    store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])

    const result = await drainOutbox(store, ACCOUNT, gmail)

    expect(result).toEqual({ uploaded: 1, failed: 0 })
    expect(store.pendingOutbox(ACCOUNT)).toEqual([])
    expect((await gmail.getMessage('m1')).labelIds).not.toContain('INBOX')
  })

  it('records the history cursor at upload time', async () => {
    const id = store.enqueue(ACCOUNT, 'm1', ['STARRED'], [])
    await drainOutbox(store, ACCOUNT, gmail)
    expect(store.uploadedAt.get(id)).toBeTruthy()
  })

  it('keeps a row queued when the upload fails', async () => {
    store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])
    gmail.failNextModify(new Error('network down'))

    expect(await drainOutbox(store, ACCOUNT, gmail)).toEqual({ uploaded: 0, failed: 1 })
    expect(store.pendingOutbox(ACCOUNT)).toHaveLength(1)
  })

  it('retries a previously failed row on the next drain', async () => {
    store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])
    gmail.failNextModify(new Error('network down'))
    await drainOutbox(store, ACCOUNT, gmail)

    expect(await drainOutbox(store, ACCOUNT, gmail)).toEqual({ uploaded: 1, failed: 0 })
    expect(store.pendingOutbox(ACCOUNT)).toEqual([])
  })

  it('does not duplicate the action when a retry succeeds', async () => {
    store.enqueue(ACCOUNT, 'm1', ['STARRED'], [])
    gmail.failNextModify(new Error('network down'))
    await drainOutbox(store, ACCOUNT, gmail)
    await drainOutbox(store, ACCOUNT, gmail)

    const labels = (await gmail.getMessage('m1')).labelIds
    expect(labels.filter((l) => l === 'STARRED')).toHaveLength(1)
  })

  it('abandons a row that has failed too many times', async () => {
    const id = store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])
    for (let i = 0; i < 4; i++) {
      gmail.failNextModify(new Error('permanent'))
      await drainOutbox(store, ACCOUNT, gmail, { maxAttempts: 3 })
    }

    expect(store.statusOf(id)).toBe('abandoned')
    expect(store.pendingOutbox(ACCOUNT)).toEqual([])
  })

  it('is a no-op with an empty queue', async () => {
    expect(await drainOutbox(store, ACCOUNT, gmail)).toEqual({ uploaded: 0, failed: 0 })
  })
})

class GoneOnFetchGmail extends FakeGmail {
  readonly gone = new Set<string>()

  override async getMessage(id: string): Promise<StoredMessage> {
    if (this.gone.has(id)) throw new MessageNotFoundError(id)
    return super.getMessage(id)
  }
}

class ConcurrencyProbeGmail extends FakeGmail {
  inFlight = 0
  peak = 0

  override async getMessage(id: string): Promise<StoredMessage> {
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await super.getMessage(id)
    } finally {
      this.inFlight -= 1
    }
  }
}

describe('deleted messages', () => {
  it('advances the history cursor past a message added then permanently deleted', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    const before = store.getSyncCursor(ACCOUNT).historyId

    const sent = await gmail.sendMessage({ to: ['a@x.com'], subject: 's', bodyText: 'b', messageId: 'op@x.com' })
    gmail.deleteMessagePermanently(sent.messageId)

    await expect(runIncrementalSync(store, ACCOUNT, gmail)).resolves.toMatchObject({ resynced: false })

    expect(store.getSyncCursor(ACCOUNT).historyId).not.toBe(before)
    expect(store.getSyncCursor(ACCOUNT).historyId).toBe((await gmail.getProfile()).historyId)
    expect(store.getMessage(ACCOUNT, sent.messageId)).toBeNull()
  })

  it('deletes locally when the message disappears between history and fetch', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new GoneOnFetchGmail()
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    gmail.remoteModify('m1', ['STARRED'], [])
    gmail.gone.add('m1')
    await runIncrementalSync(store, ACCOUNT, gmail)

    expect(store.getMessage(ACCOUNT, 'm1')).toBeNull()
    expect(store.getSyncCursor(ACCOUNT).historyId).toBe((await gmail.getProfile()).historyId)
  })

  it('fetches a message once per page and keys events by message', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    store.events.length = 0

    gmail.remoteModify('m1', ['STARRED'], [])
    gmail.remoteModify('m1', [], ['STARRED'])
    gmail.remoteModify('m1', ['UNREAD'], [])
    const result = await runIncrementalSync(store, ACCOUNT, gmail)

    expect(result.applied).toBe(1)
    expect(store.events).toHaveLength(1)
    const historyId = store.getSyncCursor(ACCOUNT).historyId
    expect(store.events[0]?.event.eventKey).toBe(`incremental:${ACCOUNT}:${historyId}:m1`)
    expect(store.events[0]?.event.payload).toEqual({ type: 'labelAdded' })
  })

  it('reports arrival when any change in the page was messageAdded', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    store.events.length = 0

    const sent = await gmail.sendMessage({ to: ['a@x.com'], subject: 's', bodyText: 'b', messageId: 'op@x.com' })
    gmail.remoteModify(sent.messageId, ['STARRED'], [])
    await runIncrementalSync(store, ACCOUNT, gmail)

    expect(store.events.map((e) => e.event.payload)).toEqual([{ type: 'messageAdded' }])
  })

  it('skips a message deleted between list and get during backfill', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new GoneOnFetchGmail({ pageSize: 2 })
    for (const id of ['m1', 'm2', 'm3']) gmail.seedMessage({ id })
    gmail.gone.add('m2')

    const result = await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    expect(result).toEqual({ fetched: 2, complete: true })
    expect(store.getMessage(ACCOUNT, 'm2')).toBeNull()
    expect(store.getMessage(ACCOUNT, 'm3')).not.toBeNull()
  })

  it('abandons an outbox row whose message is gone, without retries', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    const rowId = store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])
    gmail.deleteMessagePermanently('m1')

    expect(await drainOutbox(store, ACCOUNT, gmail)).toEqual({ uploaded: 0, failed: 1 })

    expect(store.statusOf(rowId)).toBe('abandoned')
    expect(store.getMessage(ACCOUNT, 'm1')).toBeNull()
  })

  it('returns local labels to Gmail state when a row is abandoned', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    store.enqueue(ACCOUNT, 'm1', [], ['INBOX'])
    expect(store.getMessage(ACCOUNT, 'm1')?.labelIds).toEqual([])

    for (let i = 0; i < 2; i++) {
      gmail.failNextModify(new Error('permanent'))
      await drainOutbox(store, ACCOUNT, gmail, { maxAttempts: 2 })
    }

    expect(store.getMessage(ACCOUNT, 'm1')?.labelIds).toEqual(['INBOX'])
  })
})

describe('backfill throughput', () => {
  it('never exceeds the concurrency limit and still fetches everything', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new ConcurrencyProbeGmail({ pageSize: 500 })
    for (let i = 0; i < 1000; i++) gmail.seedMessage({ id: `m${i}` })

    const result = await runBackfill(store, ACCOUNT, gmail, { maxPerSecond: Infinity })

    expect(result).toEqual({ fetched: 1000, complete: true })
    expect(gmail.peak).toBeGreaterThan(1)
    expect(gmail.peak).toBeLessThanOrEqual(8)
  })

  it('honours a custom concurrency', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new ConcurrencyProbeGmail()
    for (let i = 0; i < 40; i++) gmail.seedMessage({ id: `m${i}` })

    await runBackfill(store, ACCOUNT, gmail, { concurrency: 3, maxPerSecond: Infinity })

    expect(gmail.peak).toBe(3)
  })

  it('rate limits fetches with a token bucket', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    for (let i = 0; i < 60; i++) gmail.seedMessage({ id: `m${i}` })

    const started = Date.now()
    await runBackfill(store, ACCOUNT, gmail, { maxPerSecond: 50 })

    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('does not checkpoint a page that failed part way', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new GoneOnFetchGmail({ pageSize: 2 })
    for (const id of ['m1', 'm2', 'm3', 'm4']) gmail.seedMessage({ id })
    gmail.getMessage = async (id) => {
      if (id === 'm3') throw new Error('boom')
      return FakeGmail.prototype.getMessage.call(gmail, id)
    }

    await expect(runBackfill(store, ACCOUNT, gmail, { maxPerSecond: Infinity })).rejects.toThrow('boom')

    expect(store.getSyncCursor(ACCOUNT).backfillPageToken).toBe('2')
    expect(store.getSyncCursor(ACCOUNT).backfillComplete).toBe(false)
  })
})

describe('resync after expired history', () => {
  it('removes messages deleted remotely during the expired window', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'keep' })
    gmail.seedMessage({ id: 'gone' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    store.events.length = 0

    gmail.deleteMessagePermanently('gone')
    gmail.expireHistoryBefore('999999')
    const result = await runIncrementalSync(store, ACCOUNT, gmail)

    expect(result.resynced).toBe(true)
    expect(store.getMessage(ACCOUNT, 'keep')).not.toBeNull()
    expect(store.getMessage(ACCOUNT, 'gone')).toBeNull()
    const deletion = store.events.find((e) => e.messageId === 'gone')
    expect(deletion?.event.origin).toBe('reconciliation')
    expect(deletion?.event.eventKey).toBe(`resync:${ACCOUNT}:1:gone`)
  })

  it('abandons pending outbox rows of swept messages', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'gone' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })
    const rowId = store.enqueue(ACCOUNT, 'gone', [], ['INBOX'])

    gmail.deleteMessagePermanently('gone')
    gmail.expireHistoryBefore('999999')
    await runIncrementalSync(store, ACCOUNT, gmail)

    expect(store.statusOf(rowId)).toBe('abandoned')
  })

  it('finishes the sweep when an interrupted resync resumes', async () => {
    const store = new FakeMailStore([ACCOUNT])
    const gmail = new FakeGmail({ pageSize: 1 })
    gmail.seedMessage({ id: 'a' })
    gmail.seedMessage({ id: 'gone' })
    gmail.seedMessage({ id: 'b' })
    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    gmail.deleteMessagePermanently('gone')
    gmail.expireHistoryBefore('999999')
    const original = gmail.getMessage.bind(gmail)
    let failed = false
    gmail.getMessage = async (id: string) => {
      if (id === 'b' && !failed) {
        failed = true
        throw new Error('network down')
      }
      return original(id)
    }
    await expect(runIncrementalSync(store, ACCOUNT, gmail)).rejects.toThrow('network down')
    expect(store.getMessage(ACCOUNT, 'gone')).not.toBeNull()

    await runBackfill(store, ACCOUNT, gmail, { throttleMs: 0 })

    expect(store.getMessage(ACCOUNT, 'gone')).toBeNull()
    expect(store.getMessage(ACCOUNT, 'a')).not.toBeNull()
    expect(store.getMessage(ACCOUNT, 'b')).not.toBeNull()
  })
})
