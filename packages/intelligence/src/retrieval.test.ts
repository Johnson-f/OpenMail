import { describe, expect, it } from 'vitest'
import type { EmbeddingProvider, RankedCandidate, RerankProvider, RetrievalCandidate } from './providers'
import { FakeVectorIndex } from './vector-index'
import type { KnowledgeRepository, LexicalMatch, RetrievalScope, StoredChunk } from './retrieval'
import { HybridRetriever, isRecencyQuestion } from './retrieval'

class FakeEmbedding implements EmbeddingProvider {
  readonly model = 'fake'
  readonly dimensions = 2
  embedDocuments(): Promise<number[][]> {
    return Promise.resolve([])
  }
  embedQuery(): Promise<number[]> {
    return Promise.resolve([1, 0])
  }
}

class Repository implements KnowledgeRepository {
  constructor(
    readonly chunks: StoredChunk[],
    readonly generation: { id: number; model: string; dimensions: number } | null = { id: 1, model: 'fake', dimensions: 2 },
  ) {}
  activeGenerationInfo(): { id: number; model: string; dimensions: number } | null {
    return this.generation
  }
  lexicalSearch(_query: string, scope: RetrievalScope): LexicalMatch[] {
    return this.chunks.filter((chunk) => scope.accountIds.includes(chunk.accountId)).map((chunk) => ({ ...chunk, rank: 0 }))
  }
  chunksByRowIds(ids: number[]): StoredChunk[] {
    return this.chunks.filter((chunk) => ids.includes(chunk.rowId))
  }
  chunksForThreads(accountIds: number[], threadIds: string[]): StoredChunk[] {
    return this.chunks.filter(
      (chunk) => accountIds.includes(chunk.accountId) && threadIds.includes(chunk.threadId),
    )
  }
  recentMessageChunks(accountIds: number[], _generationId: number, messageLimit: number): StoredChunk[] {
    return this.chunks
      .filter((chunk) => accountIds.includes(chunk.accountId) && chunk.sourceType === 'message')
      .sort((a, b) => b.internalDate - a.internalDate)
      .slice(0, messageLimit)
  }
}

const reranker: RerankProvider = {
  model: 'fake-rerank',
  rerank: async (_query, candidates, topK): Promise<RankedCandidate[]> =>
    candidates.slice(0, topK).map((candidate, index) => ({ ...candidate, rerankScore: 1 - index / 10 })),
}

function chunk(rowId: number, accountId: number, content: string): StoredChunk {
  return {
    rowId,
    id: `chunk-${rowId}`,
    accountId,
    threadId: `thread-${rowId}`,
    messageId: `message-${rowId}`,
    sourceType: 'message',
    sourceLocation: 'body:1',
    content,
    internalDate: rowId,
    metadata: { subject: content },
  }
}

describe('isRecencyQuestion', () => {
  it.each([
    ['tell me about my last email', true],
    ['what was my latest email?', true],
    ['summarize my most recent emails', true],
    ['who emailed me last', true],
    ['what came in today', true],
    ['show me the newest mail from Bob', true],
    ['what did Bob say about the last invoice deadline', false],
    ['when is the renewal due?', false],
    ['what is the latest version of the contract terms', false],
  ])('%s → %s', (question, expected) => {
    expect(isRecencyQuestion(question)).toBe(expected)
  })
})

describe('HybridRetriever', () => {
  it('puts the newest messages first for a recency question, without duplicates', async () => {
    const chunks = Array.from({ length: 8 }, (_, index) => chunk(index + 1, 1, `message ${index + 1}`))
    const retriever = new HybridRetriever(new Repository(chunks), new FakeVectorIndex(2), new FakeEmbedding(), reranker)
    const result = await retriever.retrieve('tell me about my last email', { accountIds: [1] })
    expect(result.evidence.slice(0, 5).map((item) => item.id)).toEqual(['chunk-8', 'chunk-7', 'chunk-6', 'chunk-5', 'chunk-4'])
    expect(new Set(result.evidence.map((item) => item.id)).size).toBe(result.evidence.length)
    expect(result.context.indexOf('message 8')).toBeLessThan(result.context.indexOf('message 1'))
  })

  it('does not reorder by recency for an ordinary question', async () => {
    const chunks = Array.from({ length: 3 }, (_, index) => chunk(index + 1, 1, `message ${index + 1}`))
    const retriever = new HybridRetriever(new Repository(chunks), new FakeVectorIndex(2), new FakeEmbedding(), reranker)
    const result = await retriever.retrieve('when is the renewal due?', { accountIds: [1] })
    expect(result.evidence[0]?.id).toBe('chunk-1')
  })

  it('returns scoped evidence with stable citations', async () => {
    const chunks = [chunk(1, 1, 'renewal price is $18,000'), chunk(2, 2, 'private account data')]
    const vectors = new FakeVectorIndex(2)
    vectors.upsert([
      { rowId: 1, accountId: 1, generationId: 1, embedding: [1, 0] },
      { rowId: 2, accountId: 2, generationId: 1, embedding: [1, 0] },
    ])
    const retriever = new HybridRetriever(new Repository(chunks), vectors, new FakeEmbedding(), reranker)

    const result = await retriever.retrieve('renewal', { accountIds: [1] })

    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]?.accountId).toBe(1)
    expect(result.evidence[0]?.citationId).toContain('mail:1:message-1')
    expect(result.context).not.toContain('private account data')
  })

  it('falls back to fused results when reranking fails', async () => {
    const chunks = [chunk(1, 1, 'renewal')]
    const vectors = new FakeVectorIndex(2)
    vectors.upsert([{ rowId: 1, accountId: 1, generationId: 1, embedding: [1, 0] }])
    const failing: RerankProvider = {
      model: 'failing',
      rerank: async (): Promise<RankedCandidate[]> => {
        throw new Error('offline')
      },
    }
    const result = await new HybridRetriever(new Repository(chunks), vectors, new FakeEmbedding(), failing).retrieve(
      'renewal',
      { accountIds: [1] },
    )
    expect(result.degraded).toBe(true)
    expect(result.evidence).toHaveLength(1)
  })

  it('requires an explicit account scope', async () => {
    const retriever = new HybridRetriever(new Repository([]), new FakeVectorIndex(2), new FakeEmbedding(), reranker)
    await expect(retriever.retrieve('anything', { accountIds: [] })).rejects.toThrow(/account/)
  })

  it('retrieves an explicitly selected thread even when broad search would not rank it', async () => {
    const target = { ...chunk(1, 1, 'selected thread content'), threadId: 'selected-thread' }
    const unrelated = { ...chunk(2, 1, 'unrelated but vector-nearest content'), threadId: 'other-thread' }
    const repository = new Repository([target, unrelated])
    repository.lexicalSearch = () => []
    const vectors = new FakeVectorIndex(2)
    vectors.upsert([
      { rowId: 1, accountId: 1, generationId: 1, embedding: [0, 1] },
      { rowId: 2, accountId: 1, generationId: 1, embedding: [1, 0] },
    ])
    const retriever = new HybridRetriever(repository, vectors, new FakeEmbedding(), reranker)

    const result = await retriever.retrieve(
      'Summarize this thread',
      { accountIds: [1], threadIds: ['selected-thread'] },
      { candidateLimit: 1 },
    )

    expect(result.evidence.map((item) => item.threadId)).toEqual(['selected-thread'])
    expect(result.context).toContain('selected thread content')
  })

  it('uses keyword search only and marks degraded when the index was built with another model', async () => {
    const repository = new Repository([chunk(1, 1, 'renewal price')], { id: 1, model: 'old-model', dimensions: 2 })
    let embedCalls = 0
    const embedding = new FakeEmbedding()
    embedding.embedQuery = () => {
      embedCalls += 1
      return Promise.resolve([1, 0])
    }
    const result = await new HybridRetriever(repository, new FakeVectorIndex(2), embedding, reranker).retrieve(
      'renewal',
      { accountIds: [1] },
    )
    expect(embedCalls).toBe(0)
    expect(result.degraded).toBe(true)
    expect(result.evidence).toHaveLength(1)
  })

  it('keeps the newest chunks of a thread when truncating, in chronological order', async () => {
    const chunks = [1, 2, 3, 4].map((n) => ({ ...chunk(n, 1, `message ${n}`), threadId: 'long' }))
    const retriever = new HybridRetriever(new Repository(chunks), new FakeVectorIndex(2), new FakeEmbedding(), reranker)
    const result = await retriever.retrieve('summarize', { accountIds: [1], threadIds: ['long'] }, { evidenceLimit: 2 })
    expect(result.evidence.map((item) => item.content)).toEqual(['message 3', 'message 4'])
  })
})
