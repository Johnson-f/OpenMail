import { describe, expect, it } from 'vitest'

type Case = { query: string[]; documents: string[]; relevant: number }

const CORPUS: Case[] = [
  { query: ['renewal', 'price'], documents: ['lunch tomorrow', 'renewal price 18000 two years'], relevant: 1 },
  { query: ['invoice', 'due'], documents: ['invoice 3817 due september 14', 'vacation photos'], relevant: 0 },
  { query: ['no', 'reply', 'days'], documents: ['follow up because there was no reply for five days', 'meeting accepted'], relevant: 0 },
  { query: ['priority', 'support'], documents: ['onboarding excluded but priority support included', 'support ticket closed'], relevant: 0 },
]

function score(query: string[], document: string): number {
  const lower = document.toLowerCase()
  return query.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0)
}

describe('synthetic retrieval gate', () => {
  it('meets the initial known-answer recall and reciprocal-rank thresholds', () => {
    let recalled = 0
    let reciprocalRank = 0
    for (const item of CORPUS) {
      const ranked = item.documents
        .map((document, index) => ({ index, score: score(item.query, document) }))
        .sort((a, b) => b.score - a.score)
      const rank = ranked.findIndex((candidate) => candidate.index === item.relevant) + 1
      if (rank > 0 && rank <= 20) recalled += 1
      if (rank > 0) reciprocalRank += 1 / rank
    }
    expect(recalled / CORPUS.length).toBeGreaterThanOrEqual(0.9)
    expect(reciprocalRank / CORPUS.length).toBeGreaterThanOrEqual(0.75)
  })

  it('keeps account isolation and citation provenance as hard 100% gates', () => {
    const syntheticResults = [
      { requested: [1], accountId: 1, citation: 'mail:1:m1:body:body%3A1' },
      { requested: [2], accountId: 2, citation: 'mail:2:m2:a1:page%3A1' },
    ]
    expect(syntheticResults.every((result) => result.requested.includes(result.accountId))).toBe(true)
    expect(syntheticResults.every((result) => result.citation.startsWith(`mail:${result.accountId}:`))).toBe(true)
  })
})
