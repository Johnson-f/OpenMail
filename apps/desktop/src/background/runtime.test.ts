import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeGmail } from '@gmail/gmail'
import { openDatabase, type Db } from '../main/db/index'
import { saveAccount } from '../main/auth/tokens'
import { createBackgroundRuntime, type BackgroundRuntime } from './runtime'
import type { BackgroundInit, BackgroundToMain, MainToBackground } from './protocol'

const encryptor = {
  encryptString: (plain: string) => Buffer.from(plain),
  decryptString: (cipher: Buffer) => cipher.toString(),
}

type Harness = {
  runtime: BackgroundRuntime
  sent: BackgroundToMain[]
  next(predicate: (message: BackgroundToMain) => boolean): Promise<BackgroundToMain>
}

function createHarness(gmail: FakeGmail): Harness {
  const sent: BackgroundToMain[] = []
  const waiters: Array<{ predicate: (m: BackgroundToMain) => boolean; resolve: (m: BackgroundToMain) => void }> = []
  const runtime = createBackgroundRuntime({
    send: (message) => {
      sent.push(message)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
    },
    gmailFactory: () => gmail,
    syncIntervalMs: 3_600_000,
    backfillThrottleMs: 0,
  })
  return {
    runtime,
    sent,
    next: (predicate) =>
      new Promise((resolve) => {
        const existing = sent.find(predicate)
        if (existing) resolve(existing)
        else waiters.push({ predicate, resolve })
      }),
  }
}

describe('background runtime', () => {
  let dir: string
  let gmail: FakeGmail
  let accountId: number
  let harness: Harness | null = null
  let inspect: Db

  const init = (): MainToBackground => ({
    type: 'init',
    userDataDir: dir,
    googleClientId: 'id',
    googleClientSecret: 'secret',
    refreshTokens: { [accountId]: 'refresh-token' },
    providerKeys: {},
  } satisfies BackgroundInit & { type: 'init' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openmail-bg-'))
    const mailDb = openDatabase(join(dir, 'mail.db'))
    accountId = saveAccount(mailDb, encryptor, 'a@example.com', 'refresh-token')
    mailDb.close()
    inspect = openDatabase(join(dir, 'mail.db'))
    gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', subject: 'Renewal' })
    gmail.seedMessage({ id: 'm2', subject: 'Invoice' })
  })

  afterEach(() => {
    harness?.runtime.stop()
    harness = null
    inspect.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const request = (id: number, method: string, args: unknown[] = []): MainToBackground =>
    ({ type: 'request', id, method, args }) as MainToBackground

  it('syncs an account into mail.db on request', async () => {
    harness = createHarness(gmail)
    harness.runtime.handle(init())
    await harness.next((m) => m.type === 'ready')

    harness.runtime.handle(request(1, 'syncAccount', [accountId]))
    const response = await harness.next((m) => m.type === 'response' && m.id === 1)

    expect(response).toEqual({ type: 'response', id: 1, result: undefined })
    const ids = inspect.prepare('SELECT id FROM messages WHERE account_id = ? ORDER BY id').all(accountId)
    expect(ids).toEqual([{ id: 'm1' }, { id: 'm2' }])
  })

  it('rebuilds writing profiles in the background', async () => {
    harness = createHarness(gmail)
    harness.runtime.handle(init())
    await harness.next((m) => m.type === 'ready')

    harness.runtime.handle(request(7, 'rebuildWritingProfiles', [accountId]))
    const response = await harness.next((m) => m.type === 'response' && m.id === 7)

    expect(response).toMatchObject({ type: 'response', id: 7 })
    expect((response as { result: Array<{ relationshipKey: string }> }).result.map((p) => p.relationshipKey)).toContain('*')
  })

  it('reports indexing status without a voyage key and toggles provider state', async () => {
    harness = createHarness(gmail)
    harness.runtime.handle(init())
    harness.runtime.handle(request(1, 'syncAccount', [accountId]))
    await harness.next((m) => m.type === 'response' && m.id === 1)

    harness.runtime.handle(request(2, 'indexingStatus'))
    const status = await harness.next((m) => m.type === 'response' && m.id === 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    harness.runtime.handle(request(3, 'indexingStatus'))
    const later = await harness.next((m) => m.type === 'response' && m.id === 3)

    expect(status).toMatchObject({ result: { activeGeneration: null } })
    expect(later).toMatchObject({ result: { needsKey: true } })
  })

  it('treats a removed provider key as missing', async () => {
    harness = createHarness(gmail)
    harness.runtime.handle({ ...(init() as Extract<MainToBackground, { type: 'init' }>), providerKeys: { voyage: 'v' } })
    harness.runtime.handle({ type: 'set-provider-key', provider: 'voyage', key: null })
    harness.runtime.handle(request(1, 'syncAccount', [accountId]))
    await harness.next((m) => m.type === 'response' && m.id === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    harness.runtime.handle(request(2, 'indexingStatus'))
    expect(await harness.next((m) => m.type === 'response' && m.id === 2)).toMatchObject({
      result: { needsKey: true },
    })
  })

  it('rejects unknown methods and requests before init', async () => {
    harness = createHarness(gmail)
    harness.runtime.handle(request(1, 'indexingStatus'))
    expect(await harness.next((m) => m.type === 'response' && m.id === 1)).toMatchObject({
      error: 'Background runtime is not initialized',
    })

    harness.runtime.handle(init())
    harness.runtime.handle(request(2, 'nope'))
    expect(await harness.next((m) => m.type === 'response' && m.id === 2)).toMatchObject({
      error: 'Unknown background method: nope',
    })
  })

  it('records sync errors when a sync fails', async () => {
    harness = createHarness(gmail)
    gmail.getProfile = () => Promise.reject(new Error('boom'))
    harness.runtime.handle(init())
    harness.runtime.handle(request(1, 'syncAccount', [accountId]))

    expect(await harness.next((m) => m.type === 'response' && m.id === 1)).toMatchObject({ error: 'boom' })
    expect(inspect.prepare('SELECT message, error_kind FROM sync_errors').get()).toEqual({
      message: 'boom',
      error_kind: 'transient',
    })
  })

  it('round-trips the protocol over a MessageChannel', async () => {
    harness = createHarness(gmail)
    const { port1: mainPort, port2: backgroundPort } = new MessageChannel()
    const received: BackgroundToMain[] = []
    const runtime = createBackgroundRuntime({
      send: (message) => backgroundPort.postMessage(message),
      gmailFactory: () => gmail,
      syncIntervalMs: 3_600_000,
      backfillThrottleMs: 0,
    })
    backgroundPort.on('message', (message: MainToBackground) => runtime.handle(message))
    const response = new Promise<BackgroundToMain>((resolve) => {
      mainPort.on('message', (message: BackgroundToMain) => {
        received.push(message)
        if (message.type === 'response') resolve(message)
      })
    })

    mainPort.postMessage(init())
    mainPort.postMessage(request(7, 'syncAccount', [accountId]))

    expect(await response).toMatchObject({ type: 'response', id: 7 })
    expect(received[0]).toEqual({ type: 'ready' })
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 })
    runtime.stop()
    mainPort.close()
  })
})
