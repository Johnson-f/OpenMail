import { describe, expect, it } from 'vitest'
import type { BrainProvider, Evidence, RetrievalResult } from '@gmail/intelligence'
import { AgentRuntime, type AssistantToolHandler } from './conversation'

const evidence: Evidence = {
  rowId: 1,
  id: 'c1',
  accountId: 1,
  threadId: 't1',
  messageId: 'm1',
  sourceType: 'message',
  sourceLocation: 'body:1',
  content: 'Renewal price is $18,000.',
  internalDate: 1,
  metadata: {},
  citationId: 'mail:1:m1:body:body%3A1',
  score: 1,
}

function result(items: Evidence[] = [evidence]): RetrievalResult {
  return {
    evidence: items,
    context: items.map((item) => `[${item.citationId}]\n${item.content}`).join('\n'),
    degraded: false,
    generationId: 1,
  }
}

function brain(answer: string): BrainProvider {
  return {
    async *stream() {
      yield { type: 'text_delta' as const, delta: answer }
      yield { type: 'completed' as const, responseId: 'r1' }
    },
  }
}

describe('AgentRuntime', () => {
  it('returns grounded cited answers', async () => {
    const runtime = new AgentRuntime(
      { retrieve: async () => result() },
      () => brain(`The renewal price is $18,000 [${evidence.citationId}]`),
    )
    const answer = await runtime.ask({ conversationId: 'conversation-1', question: 'What price?', accountIds: [1] })
    expect(answer.answer).toContain('$18,000')
    expect(answer.evidence).toHaveLength(1)
    expect(answer.verified).toBe(true)
  })

  it('answers greetings conversationally without searching the mailbox', async () => {
    let retrievalCalls = 0
    const runtime = new AgentRuntime(
      {
        retrieve: async () => {
          retrievalCalls += 1
          return result([])
        },
      },
      () => brain('Hey! How can I help?'),
    )
    const answer = await runtime.ask({ conversationId: 'greeting', question: 'Hey', accountIds: [1] })
    expect(answer.answer).toBe('Hey! How can I help?')
    expect(answer.evidence).toEqual([])
    expect(retrievalCalls).toBe(0)
  })

  it('abstains on mailbox questions without calling the brain when evidence is empty', async () => {
    let brainCalls = 0
    const runtime = new AgentRuntime(
      { retrieve: async () => result([]) },
      () => {
        brainCalls += 1
        return brain('should not run')
      },
    )
    const answer = await runtime.ask({
      conversationId: 'c',
      question: 'What did Alice say about the renewal?',
      accountIds: [1],
    })
    expect(answer.answer).toMatch(/couldn't find enough/i)
    expect(brainCalls).toBe(0)
  })

  it('says how to widen the search when a selected thread has no evidence', async () => {
    const runtime = new AgentRuntime({ retrieve: async () => result([]) }, () => brain('should not run'))
    const answer = await runtime.ask({
      conversationId: 'c',
      question: 'tell me about my last email',
      accountIds: [1],
      threadIds: ['t1'],
    })
    expect(answer.answer).toMatch(/Remove the thread context/)
  })

  it('routes action requests through registered permission-controlled tools', async () => {
    const tools: AssistantToolHandler = {
      definitions: [
        {
          name: 'create_draft',
          description: 'Create a Gmail draft',
          parameters: { type: 'object', properties: { to: { type: 'array' } } },
        },
      ],
      execute: async (call, context) => ({
        callId: call.id,
        name: call.name,
        status: 'completed',
        message: `Draft saved for account ${context.accountIds[0]}`,
      }),
    }
    const actionBrain: BrainProvider = {
      async *stream(request) {
        expect(request.tools?.map((tool) => tool.name)).toContain('create_draft')
        yield {
          type: 'tool_call',
          id: 'tool-1',
          name: 'create_draft',
          arguments: JSON.stringify({ to: ['alice@example.com'], subject: 'Renewal', bodyText: 'Confirmed.' }),
        }
        yield { type: 'completed', responseId: 'r-action' }
      },
    }
    const runtime = new AgentRuntime(
      { retrieve: async () => result([]) },
      () => actionBrain,
      undefined,
      tools,
    )

    const answer = await runtime.ask({
      conversationId: 'action',
      question: 'Draft an email to Alice about the renewal',
      accountIds: [1],
    })

    expect(answer.answer).toBe('Draft saved for account 1')
    expect(answer.actions).toEqual([
      {
        callId: 'tool-1',
        name: 'create_draft',
        status: 'completed',
        message: 'Draft saved for account 1',
      },
    ])
  })

  it('retries once with a corrective instruction when the first answer has no citation', async () => {
    const instructions: string[] = []
    const retryBrain: BrainProvider = {
      async *stream(request) {
        instructions.push(request.instructions)
        yield {
          type: 'text_delta' as const,
          delta: instructions.length === 1 ? 'The price is $18,000.' : `The price is $18,000 [${evidence.citationId}]`,
        }
        yield { type: 'completed' as const, responseId: 'r' }
      },
    }
    const runtime = new AgentRuntime({ retrieve: async () => result() }, () => retryBrain)
    const answer = await runtime.ask({ conversationId: 'c1', question: 'Price?', accountIds: [1] })
    expect(instructions).toHaveLength(2)
    expect(instructions[1]).toMatch(/did not cite/)
    expect(answer.answer).toContain(`[${evidence.citationId}]`)
    expect(answer.verified).toBe(true)
  })

  it('returns an unverified answer instead of throwing when citations never appear', async () => {
    let calls = 0
    const runtime = new AgentRuntime({ retrieve: async () => result() }, () => ({
      async *stream() {
        calls += 1
        yield { type: 'text_delta' as const, delta: 'The price is $18,000.' }
        yield { type: 'completed' as const, responseId: 'r' }
      },
    }))
    const answer = await runtime.ask({ conversationId: 'c1', question: 'Price?', accountIds: [1] })
    expect(calls).toBe(2)
    expect(answer.verified).toBe(false)
    expect(answer.answer).toBe('The price is $18,000.')
  })

  it('strips unknown citations and keeps valid ones', async () => {
    const runtime = new AgentRuntime(
      { retrieve: async () => result() },
      () => brain(`Price is $18,000 [${evidence.citationId}] and more [mail:9:unknown]`),
    )
    const answer = await runtime.ask({ conversationId: 'c1', question: 'Price?', accountIds: [1] })
    expect(answer.answer).not.toContain('unknown')
    expect(answer.answer).toContain(evidence.citationId)
    expect(answer.verified).toBe(true)
    const onlyUnknown = new AgentRuntime({ retrieve: async () => result() }, () => brain('Price [mail:9:unknown]'))
    const unverified = await onlyUnknown.ask({ conversationId: 'c2', question: 'Price?', accountIds: [1] })
    expect(unverified.answer).toBe('Price')
    expect(unverified.verified).toBe(false)
  })

  it('gives follow-up turns history and the previous evidence, without leaking earlier actions', async () => {
    const contexts: Array<{ referencedMessageIds?: string[] }> = []
    const inputs: string[] = []
    const tools: AssistantToolHandler = {
      definitions: [{ name: 'archive_messages', description: 'Archive', parameters: { type: 'object', properties: {} } }],
      execute: async (call, context) => {
        contexts.push(context)
        return { callId: call.id, name: call.name, status: 'completed', message: 'Archived' }
      },
    }
    const turnBrain: BrainProvider = {
      async *stream(request) {
        inputs.push(request.input)
        if (request.tools?.length) {
          yield { type: 'tool_call' as const, id: 'tool-1', name: 'archive_messages', arguments: '{}' }
        } else {
          yield { type: 'text_delta' as const, delta: `Price [${evidence.citationId}]` }
        }
        yield { type: 'completed' as const, responseId: 'r' }
      },
    }
    const runtime = new AgentRuntime({ retrieve: async () => result() }, () => turnBrain, undefined, tools)
    const first = await runtime.ask({ conversationId: 'c', question: 'What did Alice quote for the price?', accountIds: [1] })
    expect(first.actions).toEqual([])

    const second = await runtime.ask({
      conversationId: 'c',
      question: 'archive them',
      accountIds: [1],
      history: [
        { role: 'user', text: 'What did Alice quote for the price?' },
        { role: 'assistant', text: first.answer },
      ],
      referencedMessageIds: first.evidence.map((item) => item.messageId),
    })
    expect(contexts[0]?.referencedMessageIds).toEqual(['m1'])
    expect(inputs[1]).toContain('Conversation so far:')
    expect(inputs[1]).toContain('User: What did Alice quote for the price?')
    expect(second.actions).toHaveLength(1)

    const third = await runtime.ask({ conversationId: 'c', question: 'What did Alice quote for the price now?', accountIds: [1] })
    expect(third.actions).toEqual([])
    expect(inputs[2]).not.toContain('Conversation so far:')
  })

  it('requires explicit account scope before retrieval', async () => {
    const runtime = new AgentRuntime({ retrieve: async () => result() }, () => brain('unused'))
    await expect(runtime.ask({ conversationId: 'c', question: 'Anything', accountIds: [] })).rejects.toThrow(/scope/)
  })

  it('passes explicit thread context to mailbox retrieval', async () => {
    let receivedThreadIds: string[] | undefined
    const runtime = new AgentRuntime(
      {
        retrieve: async (_question, _accountIds, _signal, threadIds) => {
          receivedThreadIds = threadIds
          return result()
        },
      },
      () => brain(`The renewal price is $18,000 [${evidence.citationId}]`),
    )

    await runtime.ask({
      conversationId: 'thread-context',
      question: 'Summarize this thread',
      accountIds: [1],
      threadIds: ['thread-123'],
    })

    expect(receivedThreadIds).toEqual(['thread-123'])
  })
})
