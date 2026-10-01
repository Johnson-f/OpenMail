import OpenAI from 'openai'
import type { BrainEvent, BrainProvider, BrainRequest } from '@gmail/intelligence'
import { ProviderError } from '@gmail/intelligence'

type ResponsesClient = {
  responses: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
  }
}

export class PerplexityBrain implements BrainProvider {
  private readonly client: ResponsesClient

  constructor(apiKey: string, client?: ResponsesClient) {
    this.client =
      client ??
      (new OpenAI({ apiKey, baseURL: 'https://api.perplexity.ai/v1' }) as unknown as ResponsesClient)
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainEvent> {
    let response: unknown
    try {
      response = await this.client.responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.input,
          stream: true,
          tools: request.tools?.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            // Runtime Zod schemas remain authoritative. Strict Responses schemas
            // require every optional property to be represented as nullable,
            // which is needlessly brittle for compose and mailbox tools.
            strict: false,
          })),
        },
        { signal: request.signal },
      )
    } catch (error) {
      throw new ProviderError('Perplexity request failed', 'network', { cause: error })
    }

    if (!response || !(Symbol.asyncIterator in Object(response))) {
      throw new ProviderError('Perplexity did not return a response stream', 'invalid_response')
    }

    for await (const raw of response as AsyncIterable<Record<string, unknown>>) {
      const type = raw.type
      if (type === 'response.output_text.delta' && typeof raw.delta === 'string') {
        yield { type: 'text_delta', delta: raw.delta }
      } else if (type === 'response.function_call_arguments.done') {
        const id = typeof raw.item_id === 'string' ? raw.item_id : ''
        const name = typeof raw.name === 'string' ? raw.name : ''
        const args = typeof raw.arguments === 'string' ? raw.arguments : '{}'
        yield { type: 'tool_call', id, name, arguments: args }
      } else if (type === 'response.completed') {
        const completed = raw.response as { id?: string; usage?: Record<string, number> } | undefined
        if (completed?.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: completed.usage.input_tokens,
              outputTokens: completed.usage.output_tokens,
              totalTokens: completed.usage.total_tokens,
            },
          }
        }
        yield { type: 'completed', responseId: completed?.id ?? '' }
      }
    }
  }
}
