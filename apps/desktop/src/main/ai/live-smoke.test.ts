import { describe, expect, it } from 'vitest'
import { GoogleGmail } from '@gmail/gmail'
import { PerplexityBrain } from './providers/perplexity'
import { VoyageProvider } from './providers/voyage'

const hasAI = Boolean(process.env.VOYAGE_API_KEY && process.env.PERPLEXITY_API_KEY)
const hasGmail = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN,
)

describe('opt-in live providers', () => {
  it.skipIf(!hasAI)('connects to Voyage and Perplexity', async () => {
    const vector = await new VoyageProvider(process.env.VOYAGE_API_KEY!).embedQuery('OpenMail live smoke test')
    expect(vector).toHaveLength(1024)
    let completed = false
    for await (const event of new PerplexityBrain(process.env.PERPLEXITY_API_KEY!).stream({
      model: 'openai/gpt-5.4', instructions: 'Reply only OK.', input: 'OK',
    })) if (event.type === 'completed') completed = true
    expect(completed).toBe(true)
  })

  it.skipIf(!hasGmail)('reads the dedicated Gmail test profile', async () => {
    const gmail = GoogleGmail.forRefreshToken(
      process.env.GOOGLE_CLIENT_ID!, process.env.GOOGLE_CLIENT_SECRET!, process.env.GOOGLE_REFRESH_TOKEN!,
    )
    await expect(gmail.getProfile()).resolves.toMatchObject({ emailAddress: expect.stringContaining('@') })
  })
})
