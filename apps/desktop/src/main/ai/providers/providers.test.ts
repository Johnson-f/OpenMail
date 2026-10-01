import { describe, expect, it } from 'vitest'
import { PerplexityBrain } from './perplexity'
import { EMBED_BATCH_MAX_CHARS, EMBED_BATCH_MAX_INPUTS, VoyageProvider } from './voyage'

describe('VoyageProvider', () => {
  it('embeds queries with the settled model and shape', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, index) => index / 1024) }] }),
        { status: 200 },
      )
    }) as typeof fetch
    const provider = new VoyageProvider('secret', fetcher)

    const vector = await provider.embedQuery('find renewal mail')

    expect(vector).toHaveLength(1024)
    expect(requestBody).toMatchObject({
      model: 'voyage-4',
      input_type: 'query',
      output_dimension: 1024,
    })
  })

  describe('embedDocuments batching', () => {
    function recordingFetcher(sizes: number[]): typeof fetch {
      return (async (_url: string | URL | Request, init?: RequestInit) => {
        const input = (JSON.parse(String(init?.body)) as { input: string[] }).input
        sizes.push(input.length)
        return new Response(
          JSON.stringify({ data: input.map(() => ({ embedding: new Array(1024).fill(0) })) }),
          { status: 200 },
        )
      }) as typeof fetch
    }

    it('splits by input count and returns vectors in order', async () => {
      const sizes: number[] = []
      const provider = new VoyageProvider('secret', recordingFetcher(sizes))
      const vectors = await provider.embedDocuments(Array.from({ length: 300 }, () => 'x'))
      expect(vectors).toHaveLength(300)
      expect(sizes).toEqual([EMBED_BATCH_MAX_INPUTS, EMBED_BATCH_MAX_INPUTS, 300 - 2 * EMBED_BATCH_MAX_INPUTS])
    })

    it('splits by character budget', async () => {
      const sizes: number[] = []
      const provider = new VoyageProvider('secret', recordingFetcher(sizes))
      const big = 'y'.repeat(EMBED_BATCH_MAX_CHARS / 2)
      await provider.embedDocuments([big, big, big, 'z'])
      expect(sizes).toEqual([2, 2])
    })
  })

  it('reranks candidates while preserving provenance', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }] }), {
        status: 200,
      })) as typeof fetch
    const provider = new VoyageProvider('secret', fetcher)
    const result = await provider.rerank(
      'renewal',
      [
        { id: 'a', content: 'unrelated', score: 0.5, metadata: { messageId: 'm1' } },
        { id: 'b', content: 'renewal price', score: 0.4, metadata: { messageId: 'm2' } },
      ],
      1,
    )
    expect(result).toEqual([
      {
        id: 'b',
        content: 'renewal price',
        score: 0.4,
        rerankScore: 0.9,
        metadata: { messageId: 'm2' },
      },
    ])
  })

  it('reports a server outage as transient and a bad request as a provider error', async () => {
    const respond = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch
    await expect(new VoyageProvider('secret', respond(503)).embedQuery('q')).rejects.toMatchObject({ kind: 'network' })
    await expect(new VoyageProvider('secret', respond(400)).embedQuery('q')).rejects.toMatchObject({ kind: 'provider' })
    await expect(new VoyageProvider('secret', respond(401)).embedQuery('q')).rejects.toMatchObject({ kind: 'authentication' })
  })

  it('rejects an empty rerank response when candidates were supplied', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch
    const provider = new VoyageProvider('secret', fetcher)
    await expect(
      provider.rerank(
        'summarize this thread',
        [{ id: 'c1', content: 'thread content', score: 1, metadata: {} }],
        1,
      ),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})

describe('PerplexityBrain', () => {
  it('normalizes streaming text, usage and completion events', async () => {
    const stream = async function* () {
      yield { type: 'response.output_text.delta', delta: 'Hello' }
      yield {
        type: 'response.completed',
        response: {
          id: 'response-1',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      }
    }
    const brain = new PerplexityBrain('secret', {
      responses: { create: async () => stream() },
    })

    const events = []
    for await (const event of brain.stream({ model: 'openai/gpt-5.4', instructions: 'Answer', input: 'Hi' })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
      { type: 'completed', responseId: 'response-1' },
    ])
  })

  it('normalizes completed function calls for the assistant tool seam', async () => {
    const stream = async function* () {
      yield {
        type: 'response.function_call_arguments.done',
        item_id: 'tool-1',
        name: 'create_draft',
        arguments: '{"to":["alice@example.com"],"subject":"Hi","bodyText":"Hello"}',
      }
      yield { type: 'response.completed', response: { id: 'response-2' } }
    }
    const brain = new PerplexityBrain('secret', {
      responses: { create: async () => stream() },
    })
    const events = []
    for await (const event of brain.stream({
      model: 'openai/gpt-5.4',
      instructions: 'Use a tool',
      input: 'Draft an email',
      tools: [{ name: 'create_draft', description: 'Create draft', parameters: { type: 'object' } }],
    })) events.push(event)
    expect(events[0]).toEqual({
      type: 'tool_call',
      id: 'tool-1',
      name: 'create_draft',
      arguments: '{"to":["alice@example.com"],"subject":"Hi","bodyText":"Hello"}',
    })
  })
})
