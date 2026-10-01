import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundInit, BackgroundToMain, MainToBackground } from '../background/protocol'
import { BackgroundHost, type BackgroundChild } from './background-host'

class FakeChild extends EventEmitter {
  readonly posted: MainToBackground[] = []
  killed = false

  postMessage(message: MainToBackground): void {
    this.posted.push(message)
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 1)
    return true
  }

  reply(message: BackgroundToMain): void {
    this.emit('message', message)
  }

  crash(): void {
    this.emit('exit', 1)
  }
}

const initPayload: BackgroundInit = {
  userDataDir: '/tmp/x',
  googleClientId: 'id',
  googleClientSecret: 'secret',
  refreshTokens: { 1: 'token' },
  providerKeys: {},
}

function setup(options: { stopTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const children: FakeChild[] = []
  const host = new BackgroundHost({
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as BackgroundChild
    },
    buildInit: () => initPayload,
    ...options,
  })
  return { host, children }
}

describe('BackgroundHost', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends init on start and correlates responses by id', async () => {
    const { host, children } = setup()
    host.start()
    expect(children[0]!.posted[0]).toEqual({ type: 'init', ...initPayload })

    const first = host.syncAccount(1)
    const second = host.retryFailedIndexing()
    const [req1, req2] = children[0]!.posted.slice(1) as Array<{ id: number }>
    children[0]!.reply({ type: 'response', id: req2!.id, result: 3 })
    children[0]!.reply({ type: 'response', id: req1!.id, result: undefined })

    await expect(second).resolves.toBe(3)
    await expect(first).resolves.toBeUndefined()
  })

  it('rejects with the child error and on timeout', async () => {
    const { host, children } = setup({ requestTimeoutMs: 1_000 })
    host.start()
    const failing = host.runAutomationNow('v1')
    const id = (children[0]!.posted[1] as { id: number }).id
    children[0]!.reply({ type: 'response', id, error: 'nope' })
    await expect(failing).rejects.toThrow('nope')

    const slow = host.indexingStatus()
    const assertion = expect(slow).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('lets a long sync outlive the request timeout and settles it if the child exits', async () => {
    const { host, children } = setup({ requestTimeoutMs: 1_000 })
    host.start()
    let settled = false
    const sync = host.syncAccount(1).finally(() => {
      settled = true
    })
    const rebuild = host.rebuildWritingProfiles(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)

    const syncId = (children[0]!.posted[1] as { id: number }).id
    children[0]!.reply({ type: 'response', id: syncId, result: undefined })
    await expect(sync).resolves.toBeUndefined()

    const assertion = expect(rebuild).rejects.toThrow()
    children[0]!.crash()
    await assertion
  })

  it('rejects when the child is not running', async () => {
    const { host } = setup()
    await expect(host.wakeIndexer()).rejects.toThrow('not running')
  })

  it('restarts with exponential backoff and re-sends init', async () => {
    const { host, children } = setup()
    host.start()
    const pending = host.syncAccount(1)
    const rejected = expect(pending).rejects.toThrow('exited')

    children[0]!.crash()
    await rejected
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(children).toHaveLength(2)
    expect(children[1]!.posted[0]).toEqual({ type: 'init', ...initPayload })

    children[1]!.crash()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(children).toHaveLength(3)
  })

  it('forwards token and key updates', () => {
    const { host, children } = setup()
    host.start()
    host.setRefreshToken(2, 'fresh')
    host.setProviderKey('voyage', null)
    expect(children[0]!.posted.slice(1)).toEqual([
      { type: 'set-refresh-token', accountId: 2, refreshToken: 'fresh' },
      { type: 'set-provider-key', provider: 'voyage', key: null },
    ])
  })

  it('does not restart after stop and kills an unresponsive child', async () => {
    const { host, children } = setup({ stopTimeoutMs: 3_000 })
    host.start()
    const stopping = host.stop()
    expect(children[0]!.posted.at(-1)).toEqual({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(3_000)
    await stopping
    expect(children[0]!.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('stops cleanly when the child exits on shutdown', async () => {
    const { host, children } = setup()
    host.start()
    const stopping = host.stop()
    children[0]!.crash()
    await stopping
    expect(children[0]!.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })
})
