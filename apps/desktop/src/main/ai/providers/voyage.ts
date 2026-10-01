import type {
  EmbeddingProvider,
  RankedCandidate,
  RerankProvider,
  RetrievalCandidate,
} from '@gmail/intelligence'
import { ProviderError } from '@gmail/intelligence'

type Fetch = typeof fetch

export const EMBED_BATCH_MAX_INPUTS = 128
export const EMBED_BATCH_MAX_CHARS = 120_000

export function batchEmbeddingInputs(inputs: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let chars = 0
  for (const input of inputs) {
    if (current.length > 0 && (current.length >= EMBED_BATCH_MAX_INPUTS || chars + input.length > EMBED_BATCH_MAX_CHARS)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(input)
    chars += input.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function classify(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate_limit'
  // A 5xx is the service being down, not this input being bad; callers treat
  // 'network' as a pause-everything failure rather than a per-message one.
  if (status >= 500) return 'network'
  return 'provider'
}

export class VoyageProvider implements EmbeddingProvider, RerankProvider {
  readonly model = 'voyage-4'
  readonly dimensions = 1024
  readonly rerankModel = 'rerank-2.5'

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async embedDocuments(chunks: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = []
    for (const batch of batchEmbeddingInputs(chunks)) {
      vectors.push(...(await this.embed(batch, 'document', signal)))
    }
    return vectors
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.embed([query], 'query', signal)
    if (!vector) throw new ProviderError('Voyage returned no query embedding', 'invalid_response')
    return vector
  }

  async rerank(
    query: string,
    candidates: RetrievalCandidate[],
    topK: number,
    signal?: AbortSignal,
  ): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return []
    const data = await this.request<{ results?: Array<{ index?: number; relevance_score?: number }> }>(
      '/v1/rerank',
      {
        query,
        documents: candidates.map((candidate) => candidate.content),
        model: this.rerankModel,
        top_k: Math.min(topK, candidates.length),
        return_documents: false,
        truncation: false,
      },
      signal,
    )
    if (!Array.isArray(data.results) || data.results.length === 0) {
      throw new ProviderError(
        'Voyage returned no rerank results for a non-empty candidate set',
        'invalid_response',
      )
    }
    return data.results.flatMap((result) => {
      const candidate = result.index === undefined ? undefined : candidates[result.index]
      return candidate && typeof result.relevance_score === 'number'
        ? [{ ...candidate, rerankScore: result.relevance_score }]
        : []
    })
  }

  private async embed(
    inputs: string[],
    inputType: 'document' | 'query',
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (inputs.length === 0) return []
    const data = await this.request<{ data?: Array<{ embedding?: number[] }> }>(
      '/v1/embeddings',
      {
        input: inputs,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
        output_dtype: 'float',
        truncation: false,
      },
      signal,
    )
    const vectors = (data.data ?? []).map((item) => item.embedding ?? [])
    if (vectors.length !== inputs.length || vectors.some((vector) => vector.length !== this.dimensions)) {
      throw new ProviderError('Voyage returned embeddings with an unexpected shape', 'invalid_response')
    }
    return vectors
  }

  private async request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetcher(`https://api.voyageai.com${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        if (response.ok) return (await response.json()) as T
        const error = new ProviderError(`Voyage request failed with status ${response.status}`, classify(response.status))
        if (response.status !== 429 && response.status < 500) throw error
        lastError = error
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof ProviderError && error.kind === 'authentication') throw error
        lastError = error
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
    if (lastError instanceof ProviderError) throw lastError
    throw new ProviderError('Voyage request failed', 'network', { cause: lastError })
  }
}
