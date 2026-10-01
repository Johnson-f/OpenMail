import { describe, expect, it, vi } from 'vitest'
import { FakeGmail } from '@gmail/gmail'
import { openDatabase } from '../db/index'
import { IPC_CHANNELS } from './contract'
import { registerIpcHandlers, type Deps } from './handlers'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function setup(overrides: Partial<Deps> = {}) {
  const listeners = new Map<string, Listener>()
  const db = openDatabase(':memory:')
  db.prepare("INSERT INTO accounts (email, encrypted_refresh_token, created_at) VALUES ('a@b.com', x'00', 0)").run()
  const deps: Deps = {
    db,
    encryptor: { encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    gmailFor: () => new FakeGmail(),
    ...overrides,
  }
  registerIpcHandlers(deps, { handle: (channel, listener) => void listeners.set(channel, listener as Listener) })
  const invoke = async (channel: string, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener({}, ...args)
  }
  return { db, listeners, invoke }
}

describe('registerIpcHandlers', () => {
  it('registers exactly the declared channels', () => {
    const { listeners } = setup()
    expect([...listeners.keys()].sort()).toEqual([...IPC_CHANNELS].sort())
  })

  it('rejects malformed arguments before any service runs', async () => {
    const enqueue = vi.fn()
    const requestSend = vi.fn()
    const resend = vi.fn()
    const review = vi.fn()
    const setStatus = vi.fn()
    const { invoke } = setup({
      mailActionService: { requestSend, resend } as unknown as Deps['mailActionService'],
      actionService: { review } as unknown as Deps['actionService'],
      automationService: { setStatus } as unknown as Deps['automationService'],
    })
    const malformed: Array<[string, unknown[]]> = [
      ['labels:modify', [1, 'm1', 'INBOX', []]],
      ['labels:modify', [1, 'm1', Array.from({ length: 51 }, () => 'L'), []]],
      ['labels:modify', ['1', 'm1', [], ['INBOX']]],
      ['threads:list', [1, 'INBOX', 10_000]],
      ['threads:list', [1, 'INBOX', 50, 'extra']],
      ['mailboxes:counts', [1, 'INBOX']],
      ['search:messages', [1, 42, 10]],
      ['send:request', [1, { to: 'x@y.com', subject: 's', bodyText: 'b' }]],
      ['send:request', [1, { to: ['x@y.com'], subject: 's', bodyText: 'b' }, undefined, 'not-a-uuid']],
      ['drafts:delete', [1, '../../etc']],
      ['actions:review', ['intent', 'hash', 'yes']],
      ['actions:resend', [{}]],
      ['automations:set-status', ['v1', 'deleted']],
      ['automations:build', ['archive newsletters', 1, 'Mars/Olympus']],
      ['providers:set-key', ['openai', 'key']],
      ['assistant:ask', [{ question: '', accountIds: [1] }]],
    ]
    for (const [channel, args] of malformed) {
      await expect(invoke(channel, ...args), channel).rejects.toThrow()
    }
    expect(enqueue).not.toHaveBeenCalled()
    expect(requestSend).not.toHaveBeenCalled()
    expect(resend).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('passes well-formed arguments through', async () => {
    const requestSend = vi.fn().mockResolvedValue({ status: 'pending' })
    const { invoke, db } = setup({ mailActionService: { requestSend } as unknown as Deps['mailActionService'] })
    const message = { to: ['x@y.com'], subject: 's', bodyText: 'b' }
    await invoke('send:request', 1, message, undefined, undefined)
    expect(requestSend).toHaveBeenCalledWith(1, message, undefined, undefined)
    await expect(invoke('threads:list', 1, 'INBOX', 50)).resolves.toEqual([])
    await expect(invoke('labels:modify', 1, 'missing', [], ['INBOX'])).resolves.toEqual([])
    db.close()
  })
})
