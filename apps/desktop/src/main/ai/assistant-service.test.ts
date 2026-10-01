import { describe, expect, it } from 'vitest'
import { openAgentDatabase } from '../db/index'
import { AssistantService } from './assistant-service'
import { AgentRuntime } from '@gmail/agent'

describe('AssistantService', () => {
  it('persists conversations and account scope around a grounded answer', async () => {
    const db = openAgentDatabase(':memory:')
    const service = new AssistantService(db, {
      ask: async () => ({ answer: 'Answer [mail:1:m1:body:body%3A1]', evidence: [], degraded: false }),
    })

    const result = await service.ask({ question: 'What happened?', accountIds: [1] })

    expect(result.conversationId).toBeTruthy()
    expect(service.listConversations()).toEqual([
      {
        id: result.conversationId,
        title: 'What happened?',
        accountIds: [1],
        updatedAt: expect.any(Number),
      },
    ])
    expect(db.prepare('SELECT role FROM conversation_messages ORDER BY created_at, rowid').all()).toEqual([
      { role: 'user' },
      { role: 'assistant' },
    ])
    db.close()
  })

  it('persists a conversational greeting without requiring mailbox evidence', async () => {
    const db = openAgentDatabase(':memory:')
    let retrievalCalls = 0
    const runtime = new AgentRuntime(
      {
        retrieve: async () => {
          retrievalCalls += 1
          throw new Error('conversation should not retrieve mail')
        },
      },
      () => ({
        async *stream() {
          yield { type: 'text_delta' as const, delta: 'Hey! What can I help you with?' }
          yield { type: 'completed' as const, responseId: 'greeting-response' }
        },
      }),
    )
    const service = new AssistantService(db, runtime)

    const result = await service.ask({ question: 'Hey', accountIds: [1] })

    expect(result).toMatchObject({
      answer: 'Hey! What can I help you with?',
      evidence: [],
      intent: 'conversation',
    })
    expect(retrievalCalls).toBe(0)
    expect(
      JSON.parse(
        (db
          .prepare("SELECT content_json FROM conversation_messages WHERE role = 'assistant'")
          .get() as { content_json: string }).content_json,
      ),
    ).toMatchObject({ intent: 'conversation' })
    db.close()
  })

  it('passes recent history and previous evidence message ids to the runtime', async () => {
    const db = openAgentDatabase(':memory:')
    const evidenceItem = (messageId: string) => ({ messageId, citationId: `mail:1:${messageId}` })
    let call = 0
    const requests: Array<{ history?: unknown; referencedMessageIds?: string[] }> = []
    const service = new AssistantService(db, {
      ask: async (request) => {
        requests.push(request)
        call += 1
        return {
          answer: `Answer ${call} ${'x'.repeat(3000)}`,
          evidence: [evidenceItem('m1'), evidenceItem('m1'), evidenceItem('m2')] as never,
          degraded: false,
        }
      },
    })

    const first = await service.ask({ question: 'Question 1', accountIds: [1] })
    expect(requests[0]).toMatchObject({ history: [], referencedMessageIds: [] })
    await service.ask({ conversationId: first.conversationId, question: 'archive them', accountIds: [1] })

    expect(requests[1]?.referencedMessageIds).toEqual(['m1', 'm2'])
    const history = requests[1]?.history as Array<{ role: string; text: string }>
    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(history[0]?.text).toBe('Question 1')
    expect(history[1]?.text).toHaveLength(2000)
    expect(service.conversationMessages(first.conversationId)).toHaveLength(4)

    for (let i = 0; i < 8; i += 1) {
      await service.ask({ conversationId: first.conversationId, question: `More ${i}`, accountIds: [1] })
    }
    expect((requests.at(-1)?.history as unknown[]).length).toBe(12)
    db.close()
  })
})
