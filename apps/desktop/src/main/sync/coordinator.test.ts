import { describe, expect, it, vi } from 'vitest'
import { FakeGmail } from '@gmail/gmail'
import { FakeMailStore } from '@gmail/sync'
import { SyncCoordinator } from './coordinator'

describe('SyncCoordinator', () => {
  it('resumes an incomplete backfill and catches up incrementally', async () => {
    const store = new FakeMailStore([1])
    const gmail = new FakeGmail({ pageSize: 1 })
    gmail.seedMessage({ id: 'm1' })
    const coordinator = new SyncCoordinator({
      listAccounts: () => [{ id: 1, email: 'a@example.com', needsReauth: false }],
      gmailFor: () => gmail,
      store,
      onError: vi.fn(),
      backfillThrottleMs: 0,
    })

    await coordinator.runAll()

    expect(store.getSyncCursor(1).backfillComplete).toBe(true)
    expect(store.getMessage(1, 'm1')).not.toBeNull()
  })

  it('deduplicates overlapping runs for one account', async () => {
    const store = new FakeMailStore([1])
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1' })
    let profileCalls = 0
    const original = gmail.getProfile.bind(gmail)
    gmail.getProfile = async () => {
      profileCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return original()
    }
    const coordinator = new SyncCoordinator({
      listAccounts: () => [{ id: 1, email: 'a@example.com', needsReauth: false }],
      gmailFor: () => gmail,
      store,
      onError: vi.fn(),
      backfillThrottleMs: 0,
    })

    await Promise.all([coordinator.runAccount(1), coordinator.runAccount(1)])

    expect(profileCalls).toBe(1)
  })

  it('isolates account failures', async () => {
    const store = new FakeMailStore([1, 2])
    const good = new FakeGmail()
    good.seedMessage({ id: 'good' })
    const bad = new FakeGmail()
    bad.getProfile = async () => {
      throw new Error('revoked')
    }
    const onError = vi.fn()
    const coordinator = new SyncCoordinator({
      listAccounts: () => [
        { id: 1, email: 'bad@example.com', needsReauth: false },
        { id: 2, email: 'good@example.com', needsReauth: false },
      ],
      gmailFor: (id) => (id === 1 ? bad : good),
      store,
      onError,
      backfillThrottleMs: 0,
    })

    await coordinator.runAll()

    expect(onError).toHaveBeenCalledWith(1, expect.any(Error))
    expect(store.getMessage(2, 'good')).not.toBeNull()
  })
})
