import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@gmail/core'
import { buildWritingProfile, profilePrompt } from './writing-profile'

function message(bodyText: string): StoredMessage {
  return {
    id: bodyText,
    threadId: 't',
    from: 'me@example.com',
    to: ['you@example.com'],
    cc: [],
    subject: '',
    snippet: '',
    bodyText,
    bodyHtml: '',
    internalDate: 1,
    labelIds: ['SENT'],
    messageIdHeader: `${bodyText}@example.com`,
    inReplyTo: '',
    references: [],
    attachments: [],
  }
}

describe('writing profiles', () => {
  it('learns concise relationship style from sent messages', () => {
    const profile = buildWritingProfile([
      message('Hi Alice,\n\nSounds good.\n\nThanks,'),
      message('Hi Alice,\n\nConfirmed for Friday.\n\nThanks,'),
      message('Hi Alice,\n\nI agree.\n\nThanks,'),
    ])
    expect(profile).toMatchObject({ tone: 'concise', greetings: ['Hi Alice,'], signoffs: ['Thanks,'], sampleCount: 3 })
    expect(profilePrompt(profile)).toContain('Preferred greeting: Hi Alice,')
  })
})
