import type { EmbeddingProvider, RerankProvider, RetrievalCandidate } from './providers'
import type { VectorIndex } from './vector-index'

export type RetrievalScope = {
  accountIds: number[]
  threadIds?: string[]
  after?: number
  before?: number
  sourceTypes?: Array<'message' | 'attachment'>
}

export type StoredChunk = {
  rowId: number
  id: string
  accountId: number
  threadId: string
  messageId: string
  attachmentPartId?: string
  sourceType: 'message' | 'attachment'
  sourceLocation: string
  content: string
  internalDate: number
  metadata: Record<string, unknown>
}

export type LexicalMatch = StoredChunk & { rank: number }

export interface KnowledgeRepository {
  activeGenerationInfo(): { id: number; model: string; dimensions: number } | null
  lexicalSearch(query: string, scope: RetrievalScope, generationId: number, limit: number): LexicalMatch[]
  chunksByRowIds(rowIds: number[]): StoredChunk[]
  chunksForThreads(accountIds: number[], threadIds: string[], generationId: number): StoredChunk[]
  /** The first body chunk of each of the newest messages, newest first. */
  recentMessageChunks(accountIds: number[], generationId: number, messageLimit: number): StoredChunk[]
}

const RECENCY_WORD = /\b(?:last|latest|newest|most\s+recent|recent|recently|today|yesterday|this\s+(?:morning|afternoon|week))\b/i
const MAIL_WORD = /\b(?:e-?mails?|mail|messages?|inbox|threads?|emailed|wrote|sent|received|came\s+in|got)\b/i
const RECENT_MESSAGE_LIMIT = 5

/**
 * Relevance ranking cannot answer "my last email": every message is equally
 * about nothing in particular. Such questions need the newest mail itself.
 */
export function isRecencyQuestion(query: string): boolean {
  return RECENCY_WORD.test(query) && MAIL_WORD.test(query)
}

export type Evidence = StoredChunk & {
  citationId: string
  score: number
  rerankScore?: number
}

export type RetrievalResult = {
  evidence: Evidence[]
  context: string
  degraded: boolean
  generationId: number | null
}

export class HybridRetriever {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly vectorIndex: VectorIndex,
    private readonly embedding: EmbeddingProvider,
    private readonly reranker: RerankProvider,
  ) {}

  async retrieve(
    query: string,
    scope: RetrievalScope,
    opts: { candidateLimit?: number; evidenceLimit?: number; maxContextCharacters?: number; signal?: AbortSignal } = {},
  ): Promise<RetrievalResult> {
    if (scope.accountIds.length === 0) throw new Error('At least one account is required for retrieval')
    const generation = this.repository.activeGenerationInfo()
    if (!generation) return { evidence: [], context: '', degraded: false, generationId: null }
    const generationId = generation.id
    if (scope.threadIds?.length) {
      const direct = this.repository
        .chunksForThreads(scope.accountIds, scope.threadIds, generationId)
        .filter((chunk) => matchesScope(chunk, scope))
      const limit = opts.evidenceLimit ?? 100
      const newest = [...direct].sort(compareChronologically).slice(-limit)
      const evidence = newest.map((chunk) => ({
        ...chunk,
        citationId: citationId(chunk),
        score: 1,
      }))
      return {
        evidence,
        context: buildContext(evidence, opts.maxContextCharacters ?? 24_000),
        degraded: false,
        generationId,
      }
    }
    const candidateLimit = opts.candidateLimit ?? 50
    const evidenceLimit = opts.evidenceLimit ?? 12
    const recent: Evidence[] = isRecencyQuestion(query)
      ? this.repository
          .recentMessageChunks(scope.accountIds, generationId, RECENT_MESSAGE_LIMIT)
          .filter((chunk) => matchesScope(chunk, scope))
          .map((chunk) => ({ ...chunk, citationId: citationId(chunk), score: 1 }))
      : []
    const modelMismatch =
      generation.model !== this.embedding.model || generation.dimensions !== this.embedding.dimensions
    const lexical = this.repository.lexicalSearch(query, scope, generationId, candidateLimit)
    let vector: VectorChunk[] = []
    if (!modelMismatch) {
      const queryVector = await this.embedding.embedQuery(query, opts.signal)
      const vectorMatches = this.vectorIndex.search(queryVector, {
        accountIds: scope.accountIds,
        generationId,
        limit: candidateLimit,
      })
      const vectorChunks = this.repository.chunksByRowIds(vectorMatches.map((match) => match.rowId))
      const byRow = new Map(vectorChunks.map((chunk) => [chunk.rowId, chunk]))
      vector = vectorMatches.flatMap((match) => {
        const chunk = byRow.get(match.rowId)
        return chunk ? [{ ...chunk, distance: match.distance }] : []
      })
    }
    const fused = fuse(lexical, vector).filter((candidate) => matchesScope(candidate, scope))

    let degraded = modelMismatch
    let ranked: Array<RetrievalCandidate & { rerankScore?: number }>
    try {
      ranked = await this.reranker.rerank(
        query,
        fused.map(toCandidate),
        Math.min(evidenceLimit, fused.length),
        opts.signal,
      )
    } catch {
      degraded = true
      ranked = fused.slice(0, evidenceLimit).map(toCandidate)
    }
    const chunks = new Map(fused.map((chunk) => [chunk.id, chunk]))
    const recentIds = new Set(recent.map((item) => item.id))
    const relevant: Evidence[] = ranked.flatMap((rankedCandidate) => {
      const chunk = chunks.get(rankedCandidate.id)
      return chunk && !recentIds.has(chunk.id)
        ? [
            {
              ...chunk,
              citationId: citationId(chunk),
              score: rankedCandidate.score,
              ...('rerankScore' in rankedCandidate && typeof rankedCandidate.rerankScore === 'number'
                ? { rerankScore: rankedCandidate.rerankScore }
                : {}),
            },
          ]
        : []
    })
    const evidence = [...recent, ...relevant]
    return {
      evidence,
      context: buildContext(evidence, opts.maxContextCharacters ?? 24_000),
      degraded,
      generationId,
    }
  }
}

function compareChronologically(a: StoredChunk, b: StoredChunk): number {
  return (
    a.internalDate - b.internalDate ||
    a.messageId.localeCompare(b.messageId) ||
    a.sourceType.localeCompare(b.sourceType) ||
    a.sourceLocation.localeCompare(b.sourceLocation)
  )
}

type VectorChunk = StoredChunk & { distance: number }
type FusedChunk = StoredChunk & { fusedScore: number }

function fuse(lexical: LexicalMatch[], vector: VectorChunk[]): FusedChunk[] {
  const scores = new Map<string, { chunk: StoredChunk; score: number }>()
  lexical.forEach((chunk, index) => {
    scores.set(chunk.id, { chunk, score: 1 / (60 + index + 1) })
  })
  vector.forEach((chunk, index) => {
    const current = scores.get(chunk.id)
    scores.set(chunk.id, { chunk, score: (current?.score ?? 0) + 1 / (60 + index + 1) })
  })
  return [...scores.values()]
    .map(({ chunk, score }) => ({ ...chunk, fusedScore: score }))
    .sort((a, b) => b.fusedScore - a.fusedScore || b.internalDate - a.internalDate)
}

function toCandidate(chunk: FusedChunk): RetrievalCandidate {
  return { id: chunk.id, content: chunk.content, score: chunk.fusedScore, metadata: chunk.metadata }
}

function matchesScope(chunk: StoredChunk, scope: RetrievalScope): boolean {
  return (
    scope.accountIds.includes(chunk.accountId) &&
    (!scope.threadIds?.length || scope.threadIds.includes(chunk.threadId)) &&
    (scope.after === undefined || chunk.internalDate >= scope.after) &&
    (scope.before === undefined || chunk.internalDate <= scope.before) &&
    (!scope.sourceTypes?.length || scope.sourceTypes.includes(chunk.sourceType))
  )
}

function citationId(chunk: StoredChunk): string {
  return [
    'mail',
    chunk.accountId,
    chunk.messageId,
    chunk.attachmentPartId ?? 'body',
    chunk.sourceLocation,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join(':')
}

function buildContext(evidence: Evidence[], maxCharacters: number): string {
  const blocks: string[] = []
  let used = 0
  for (const item of evidence) {
    const block = `[${item.citationId}]\n${item.content}`
    if (used + block.length > maxCharacters) break
    blocks.push(block)
    used += block.length
  }
  return blocks.join('\n\n')
}
