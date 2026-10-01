import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { ActionApprovalGraph, PolicyEngine, createActionIntent } from '@gmail/agent'
import { openAgentDatabase } from '../db/index'
import { ActionService } from './action-service'

describe('ActionService', () => {
  it('persists, audits and resumes an exact pending action', async () => {
    const db = openAgentDatabase(':memory:')
    const service = new ActionService(db, new PolicyEngine(), new ActionApprovalGraph(new MemorySaver()))
    const intent = createActionIntent({
      kind: 'send',
      accountId: 1,
      arguments: { to: ['a@example.com'], subject: 'Hello', bodyText: 'Hi' },
      initiator: { type: 'chat', conversationId: 'c1' },
      source: 'user_request',
    })

    await expect(service.propose(intent)).resolves.toMatchObject({ status: 'pending' })
    expect(service.listPending()).toHaveLength(1)
    await expect(service.review(intent.id, 'wrong', true)).rejects.toThrow(/changed/)
    await expect(service.review(intent.id, intent.contentHash, true)).resolves.toBe('approved')
    expect(service.listPending()).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count).toBeGreaterThan(1)
    db.close()
  })

  it('lets exactly one of two concurrent reviews approve', async () => {
    const db = openAgentDatabase(':memory:')
    const service = new ActionService(db, new PolicyEngine(), new ActionApprovalGraph(new MemorySaver()))
    const intent = createActionIntent({
      kind: 'send',
      accountId: 1,
      arguments: { to: ['a@example.com'], subject: 'Hello', bodyText: 'Hi' },
      initiator: { type: 'chat', conversationId: 'c1' },
      source: 'user_request',
    })
    await service.propose(intent)
    const settled = await Promise.allSettled([
      service.review(intent.id, intent.contentHash, true),
      service.review(intent.id, intent.contentHash, true),
    ])
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1)
    db.close()
  })

  it('refuses to approve an expired intent and marks it expired when listing', async () => {
    const db = openAgentDatabase(':memory:')
    const service = new ActionService(db, new PolicyEngine(), new ActionApprovalGraph(new MemorySaver()))
    const intent = createActionIntent({
      kind: 'send',
      accountId: 1,
      arguments: { to: ['a@example.com'], subject: 'Hello', bodyText: 'Hi' },
      initiator: { type: 'chat', conversationId: 'c1' },
      source: 'user_request',
    })
    await service.propose(intent)
    db.prepare('UPDATE action_intents SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, intent.id)
    await expect(service.review(intent.id, intent.contentHash, true)).rejects.toThrow(/expired/)
    expect(service.status(intent.id)).toBe('pending')
    expect(service.listPending()).toHaveLength(0)
    expect(service.status(intent.id)).toBe('expired')
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'expired'").get()).toEqual({ count: 1 })
    db.close()
  })
})
