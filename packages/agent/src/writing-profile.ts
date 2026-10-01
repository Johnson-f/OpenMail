import type { StoredMessage } from '@gmail/core'

export type WritingProfile = {
  tone: 'concise' | 'balanced' | 'detailed'
  formality: 'casual' | 'neutral' | 'formal'
  averageSentenceWords: number
  averageMessageWords: number
  greetings: string[]
  signoffs: string[]
  prefersBullets: boolean
  sampleCount: number
}

export function buildWritingProfile(messages: StoredMessage[]): WritingProfile {
  const bodies = messages.map((message) => message.bodyText.trim()).filter(Boolean)
  const words = bodies.map((body) => body.split(/\s+/).filter(Boolean))
  const sentenceCounts = bodies.map((body) => Math.max(body.split(/[.!?]+/).filter((item) => item.trim()).length, 1))
  const totalWords = words.reduce((total, items) => total + items.length, 0)
  const totalSentences = sentenceCounts.reduce((total, count) => total + count, 0)
  const averageMessageWords = bodies.length ? Math.round(totalWords / bodies.length) : 0
  const greetings = frequent(
    bodies.map((body) => body.split('\n')[0]?.trim() ?? '').filter((line) => /^(hi|hello|hey|dear|good\s)/i.test(line)),
  )
  const signoffs = frequent(
    bodies.flatMap((body) => body.split('\n').map((line) => line.trim()).slice(-4)).filter((line) => /^(thanks|thank you|best|regards|cheers|sincerely)[,!]?$/i.test(line)),
  )
  const formalSignals = bodies.filter((body) => /\b(dear|sincerely|kind regards|please find|would you kindly)\b/i.test(body)).length
  const casualSignals = bodies.filter((body) => /\b(hey|cheers|thanks!|yep|sounds good)\b/i.test(body)).length
  return {
    tone: averageMessageWords < 60 ? 'concise' : averageMessageWords > 180 ? 'detailed' : 'balanced',
    formality: formalSignals > casualSignals ? 'formal' : casualSignals > formalSignals ? 'casual' : 'neutral',
    averageSentenceWords: totalSentences ? Math.round(totalWords / totalSentences) : 0,
    averageMessageWords,
    greetings,
    signoffs,
    prefersBullets: bodies.filter((body) => /(^|\n)\s*[-*•]\s/m.test(body)).length > bodies.length / 3,
    sampleCount: bodies.length,
  }
}

export function profilePrompt(profile: WritingProfile, relationship?: WritingProfile): string {
  const selected = relationship && relationship.sampleCount >= 3 ? relationship : profile
  return [
    `Tone: ${selected.tone}.`,
    `Formality: ${selected.formality}.`,
    `Typical message length: about ${selected.averageMessageWords} words.`,
    `Typical sentence length: about ${selected.averageSentenceWords} words.`,
    selected.greetings[0] ? `Preferred greeting: ${selected.greetings[0]}.` : '',
    selected.signoffs[0] ? `Preferred sign-off: ${selected.signoffs[0]}.` : '',
    selected.prefersBullets ? 'Use bullets for lists.' : 'Prefer short paragraphs over bullets unless useful.',
  ]
    .filter(Boolean)
    .join(' ')
}

function frequent(values: string[]): string[] {
  const counts = new Map<string, { value: string; count: number }>()
  for (const value of values) {
    const key = value.toLowerCase()
    const current = counts.get(key)
    counts.set(key, { value, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 5)
    .map((item) => item.value)
}
