import type { BrainProvider, EmbeddingProvider, RerankProvider } from '@gmail/intelligence'
import type { ProviderName, SecretSource } from '../secrets'
import { PerplexityBrain } from './perplexity'
import { VoyageProvider } from './voyage'

export type ProviderStatus = { provider: ProviderName; configured: boolean }

export class ProviderRegistry {
  constructor(private readonly secrets: SecretSource) {}

  list(): ProviderStatus[] {
    return (['voyage', 'perplexity'] as const).map((provider) => ({
      provider,
      configured: this.secrets.has(provider),
    }))
  }

  async setKey(provider: ProviderName, key: string): Promise<void> {
    if (provider === 'voyage') {
      await new VoyageProvider(key).embedQuery('OpenMail provider validation')
    } else {
      let completed = false
      for await (const event of new PerplexityBrain(key).stream({
        model: 'openai/gpt-5.4',
        instructions: 'Validate connectivity. Reply with OK.',
        input: 'OK',
      })) {
        if (event.type === 'completed') completed = true
      }
      if (!completed) throw new Error('Perplexity validation did not complete')
    }
    this.secrets.set(provider, key)
  }

  remove(provider: ProviderName): void {
    this.secrets.remove(provider)
  }

  embedding(): EmbeddingProvider {
    const key = this.requireKey('voyage')
    return new VoyageProvider(key)
  }

  reranker(): RerankProvider {
    const key = this.requireKey('voyage')
    return new VoyageProvider(key)
  }

  brain(): BrainProvider {
    return new PerplexityBrain(this.requireKey('perplexity'))
  }

  private requireKey(provider: ProviderName): string {
    const key = this.secrets.get(provider)
    if (!key) throw new Error(`${provider} is not configured`)
    return key
  }
}
