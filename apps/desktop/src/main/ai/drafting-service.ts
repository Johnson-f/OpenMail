import type { BrainProvider } from '@gmail/intelligence'
import type { WritingProfileService } from './writing-profile-service'

export class DraftingService {
  constructor(
    private readonly profiles: WritingProfileService,
    private readonly brain: () => BrainProvider,
  ) {}

  async generate(input: {
    accountId: number
    recipients: string[]
    subject: string
    instruction: string
  }): Promise<string> {
    const style = this.profiles.context(input.accountId, input.recipients)
    let draft = ''
    for await (const event of this.brain().stream({
      model: 'openai/gpt-5.4',
      instructions:
        'Write only the email body. Follow the local writing profile and relationship examples. Do not invent commitments, facts, recipients, or attachments.',
      input: [
        `Task: ${input.instruction}`,
        `Recipients: ${input.recipients.join(', ')}`,
        `Subject: ${input.subject}`,
        `Writing profile: ${style.prompt}`,
        style.examples.length ? `Relevant sent examples:\n${style.examples.join('\n---\n')}` : '',
      ].filter(Boolean).join('\n\n'),
    })) {
      if (event.type === 'text_delta') draft += event.delta
    }
    if (!draft.trim()) throw new Error('The brain returned an empty draft')
    return draft.trim()
  }
}
