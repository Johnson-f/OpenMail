import { describe, it, expect, beforeEach } from 'vitest'
import { FakeGmail } from '@gmail/gmail'
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
