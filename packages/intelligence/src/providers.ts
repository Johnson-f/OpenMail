export type ProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type RetrievalCandidate = {
  id: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

export type RankedCandidate = RetrievalCandidate & { rerankScore: number }

export type BrainTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type BrainRequest = {
  model: string
  instructions: string
  input: string
  tools?: BrainTool[]
  signal?: AbortSignal
}

export type BrainEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'completed'; responseId: string }

export interface EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  embedDocuments(chunks: string[], signal?: AbortSignal): Promise<number[][]>
  embedQuery(query: string, signal?: AbortSignal): Promise<number[]>
}

export interface RerankProvider {
  readonly model: string
  rerank(
    query: string,
    candidates: RetrievalCandidate[],
    topK: number,
    signal?: AbortSignal,
  ): Promise<RankedCandidate[]>
}

export interface BrainProvider {
  stream(request: BrainRequest): AsyncIterable<BrainEvent>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'authentication' | 'rate_limit' | 'timeout' | 'network' | 'invalid_response' | 'provider',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ProviderError'
  }
}
