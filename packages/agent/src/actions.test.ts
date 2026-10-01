import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { ActionApprovalGraph, PolicyEngine, actionHash, createActionIntent, effectiveKind, labelChangesFor } from './actions'

function chat(kind: Parameters<typeof createActionIntent>[0]['kind'], args: Record<string, unknown> = {}) {
  return createActionIntent({
    kind,
    accountId: 1,
    arguments: args,
    initiator: { type: 'chat', conversationId: 'c1' },
    source: 'user_request',
  })
}

describe('PolicyEngine', () => {
  const policy = new PolicyEngine()

  it('allows drafting and small reversible actions but asks for sensitive and bulk actions', () => {
    expect(policy.decide(chat('create_draft')).result).toBe('allow')
    expect(policy.decide(chat('archive', { messageIds: Array.from({ length: 20 }, (_, i) => `m${i}`) })).result).toBe(
      'allow',
    )
    expect(policy.decide(chat('archive', { messageIds: Array.from({ length: 21 }, (_, i) => `m${i}`) })).result).toBe(
      'ask',
    )
    expect(policy.decide(chat('trash')).result).toBe('ask')
    expect(policy.decide(chat('send')).result).toBe('ask')
  })

  it('allows only actions inside an exact automation grant', () => {
    const intent = createActionIntent({
      kind: 'send',
      accountId: 1,
      arguments: { to: ['known@example.com'], attachments: [] },
      initiator: { type: 'automation', automationVersionId: 'v1' },
      source: 'automation_spec',
    })
    const grant = {
      accountIds: [1],
      tools: ['send' as const],
      recipientDomains: ['example.com'],
      recipients: [],
      allowAttachments: false,
      maxPerRun: 5,
      maxPerDay: 20,
      usedThisRun: 0,
      usedToday: 0,
      expiresAt: Date.now() + 60_000,
    }
    expect(policy.decide(intent, grant).result).toBe('allow')
    expect(policy.decide({ ...intent, arguments: { to: ['outside@other.com'] } }, grant).result).toBe('deny')
    expect(policy.decide({ ...intent, arguments: { to: ['known@example.com'], attachments: [{}] } }, grant).result).toBe(
      'deny',
    )
  })

  it('judges label changes by their effect, not their declared kind', () => {
    expect(policy.decide(chat('modify_labels', { messageIds: ['m1'], add: ['TRASH'], remove: [] })).result).toBe('ask')
    expect(policy.decide(chat('modify_labels', { messageIds: ['m1'], add: ['SPAM'], remove: ['INBOX'] })).result).toBe('ask')
    expect(policy.decide(chat('modify_labels', { messageIds: ['m1'], add: ['INBOX'], remove: ['TRASH'] })).result).toBe('ask')
    expect(policy.decide(chat('modify_labels', { messageIds: ['m1'], add: ['STARRED'], remove: [] })).result).toBe('allow')
  })

  it('denies an automation whose label grant is used to trash or spam', () => {
    const grant = {
      accountIds: [1],
      tools: ['modify_labels' as const],
      recipientDomains: [],
      recipients: [],
      allowAttachments: false,
      maxPerRun: 5,
      maxPerDay: 20,
      usedThisRun: 0,
      usedToday: 0,
      expiresAt: Date.now() + 60_000,
    }
    const automation = (args: Record<string, unknown>) =>
      createActionIntent({
        kind: 'modify_labels',
        accountId: 1,
        arguments: args,
        initiator: { type: 'automation', automationVersionId: 'v1' },
        source: 'automation_spec',
      })
    expect(policy.decide(automation({ messageIds: ['m1'], add: ['SPAM'] }), grant).result).toBe('deny')
    expect(policy.decide(automation({ messageIds: ['m1'], add: ['Label_7'] }), grant).result).toBe('allow')
  })

  it('maps every mailbox action to one label delta', () => {
    expect(labelChangesFor('archive', {})).toEqual({ add: [], remove: ['INBOX'] })
    expect(labelChangesFor('trash', {})).toEqual({ add: ['TRASH'], remove: ['INBOX'] })
    expect(labelChangesFor('spam', {})).toEqual({ add: ['SPAM'], remove: ['INBOX'] })
    expect(labelChangesFor('restore', {})).toEqual({ add: ['INBOX'], remove: ['TRASH', 'SPAM'] })
    expect(labelChangesFor('modify_labels', { add: ['A'], remove: ['B', 3] })).toEqual({ add: ['A'], remove: ['B'] })
    expect(() => labelChangesFor('send', {})).toThrow()
    expect(effectiveKind({ kind: 'archive', arguments: {} })).toBe('archive')
  })

  it('creates stable hashes independent of object key order', () => {
    expect(actionHash({ b: 2, a: 1 })).toBe(actionHash({ a: 1, b: 2 }))
  })
})

describe('ActionApprovalGraph', () => {
  it('persists an interrupt and resumes an exact action decision', async () => {
    const graph = new ActionApprovalGraph(new MemorySaver())
    const intent = chat('send', { to: ['a@example.com'] })
    await expect(graph.start(intent, { result: 'ask', reason: 'send' })).resolves.toBe('pending')
    await expect(graph.resume(intent.id, true)).resolves.toBe('approved')
  })

  it('does not interrupt allow or deny decisions', async () => {
    const graph = new ActionApprovalGraph(new MemorySaver())
    await expect(graph.start(chat('create_draft'), { result: 'allow', reason: 'draft' })).resolves.toBe('approved')
    await expect(graph.start(chat('trash'), { result: 'deny', reason: 'scope' })).resolves.toBe('denied')
  })
})
