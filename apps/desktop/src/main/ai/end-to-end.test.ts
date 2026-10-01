import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import {
  ActionApprovalGraph,
  AutomationBuilder,
  AutomationRunGraph,
  PolicyEngine,
  type AutomationSpec,
} from '@gmail/agent'
import type { BrainProvider, EmbeddingProvider, RankedCandidate, RerankProvider } from '@gmail/intelligence'
import { FakeVectorIndex, HybridRetriever } from '@gmail/intelligence'
import { FakeGmail } from '@gmail/gmail'
import { runBackfill } from '@gmail/sync'
import { openAgentDatabase, openDatabase, openIndexDatabase } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { AutomationScheduler } from '../automation/scheduler'
import { ActionService } from './action-service'
import { AgentRuntime as Runtime } from '@gmail/agent'
import { AssistantService } from './assistant-service'
import { AutomationService } from './automation-service'
import { IndexingWorker } from './indexing-worker'
import { SqliteKnowledgeRepository } from './knowledge-repository'
import { MailActionService } from './mail-action-service'

class Embedding implements EmbeddingProvider {
  readonly model = 'fake-voyage'
  readonly dimensions = 2
  embedDocuments(values: string[]): Promise<number[][]> { return Promise.resolve(values.map(() => [1, 0])) }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0]) }
}

const reranker: RerankProvider = {
  model: 'fake-rerank',
  rerank: async (_query, candidates, topK): Promise<RankedCandidate[]> =>
    candidates.slice(0, topK).map((candidate, index) => ({ ...candidate, rerankScore: 1 - index / 10 })),
}

const citingBrain: BrainProvider = {
  async *stream(request) {
    const citation = /\[(mail:[^\]]+)\]/.exec(request.input)?.[1] ?? ''
    yield { type: 'text_delta', delta: `The agreed renewal is $18,000 [${citation}]` }
    yield { type: 'completed', responseId: 'fake-response' }
  },
}

describe('complete local AI story', () => {
  it('syncs, indexes, answers, approves a send, and runs a granted automation', async () => {
    const mailDb = openDatabase(':memory:')
    const indexDb = openIndexDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({
      id: 'renewal',
      threadId: 'renewal-thread',
      from: 'Alice <alice@acme.com>',
      subject: 'Renewal terms',
      bodyText: 'We agreed to renew for $18,000 for two years with priority support.',
      labelIds: ['INBOX'],
    })
    await runBackfill(store, 1, gmail, { throttleMs: 0 })

    const vectors = new FakeVectorIndex(2)
    const indexer = new IndexingWorker({
      mailDb, indexDb, mailStore: store, gmailFor: () => gmail,
      embedding: () => new Embedding(), vectorIndex: vectors,
    })
    await indexer.runOnce()
    expect(indexer.status()).toMatchObject({ indexedChunks: 1, pendingEvents: 0 })

    const retriever = new HybridRetriever(
      new SqliteKnowledgeRepository(indexDb), vectors, new Embedding(), reranker,
    )
    const checkpointer = new MemorySaver()
    const runtime = new Runtime(
      {
        retrieve: (question, accountIds, signal, threadIds) =>
          retriever.retrieve(question, { accountIds, threadIds }, { signal }),
      },
      () => citingBrain,
      checkpointer,
    )
    const assistant = new AssistantService(agentDb, runtime)
    const answer = await assistant.ask({ question: 'What renewal price did we agree?', accountIds: [1] })
    expect(answer.answer).toContain('$18,000')
    expect(answer.evidence[0]?.messageId).toBe('renewal')

    const contextualAnswer = await assistant.ask({
      question: 'Summarize this thread and list any decisions or action items.',
      accountIds: [1],
      threadIds: ['renewal-thread'],
    })
    expect(contextualAnswer.answer).toContain('$18,000')
    expect(contextualAnswer.evidence[0]).toMatchObject({
      threadId: 'renewal-thread',
      messageId: 'renewal',
    })

    const actions = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(checkpointer))
    const mailActions = new MailActionService(mailDb, store, () => gmail, actions)
    const pending = await mailActions.requestSend(1, {
      to: ['alice@acme.com'], subject: 'Re: Renewal terms', bodyText: 'Confirmed.',
      threadId: 'renewal-thread', inReplyTo: 'renewal@fake.local',
    }, answer.conversationId)
    expect(pending.status).toBe('pending')
    await actions.review(pending.intent.id, pending.intent.contentHash, true)
    await expect(mailActions.executeApproved(pending.intent.id)).resolves.toMatchObject({ status: 'sent' })

    const spec: AutomationSpec = {
      automationId: 'automation-1', version: 1, name: 'Archive renewals', accountIds: [1], mailboxIds: ['INBOX'],
      trigger: { type: 'manual' }, conditions: { query: 'renewal', senders: [], recipientDomains: [] },
      actions: [{ kind: 'archive', arguments: { messageIds: ['renewal'] } }],
      limits: { maxPerRun: 50, maxPerDay: 500 }, allowAttachments: false,
      timezone: 'Africa/Lagos', catchUp: 'run_once', enabled: false,
    }
    const automations = new AutomationService(
      mailDb, agentDb, new AutomationBuilder(() => ({ async *stream() {} })),
    )
    const simulation = automations.simulate(spec)
    automations.activate(spec, simulation.id)
    const version = automations.records()[0]!
    const scheduler = new AutomationScheduler(
      mailDb, agentDb, store, actions, mailActions,
      (execute) => new AutomationRunGraph(execute, checkpointer),
      { now: () => Date.now() },
    )
    scheduler.runManual(version.versionId, { accountId: 1, messageId: 'renewal' })
    await scheduler.tick()
    expect(store.pendingOutbox(1).some((row) => row.messageId === 'renewal' && row.remove.includes('INBOX'))).toBe(true)

    mailDb.close(); indexDb.close(); agentDb.close()
  })
})
