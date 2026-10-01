import { describe, expect, it } from 'vitest'
import { openIndexDatabase } from '../db/index'
import { SqliteKnowledgeRepository } from './knowledge-repository'

describe('lexical retrieval gate', () => {
  it('keyword search returns the relevant chunk for natural-language questions', () => {
    const questions: Array<{ question: string; documents: string[]; relevant: number }> = [
      { question: 'What is the renewal price?', documents: ['lunch tomorrow', 'renewal price 18000 two years'], relevant: 1 },
      { question: 'When is the invoice due?', documents: ['invoice 3817 due september 14', 'vacation photos'], relevant: 0 },
      { question: 'Did anyone follow up about the onboarding?', documents: ['meeting accepted', 'following up on onboarding schedule'], relevant: 1 },
      { question: 'Does the plan include priority support?', documents: ['priority support included', 'ticket closed'], relevant: 0 },
    ]
    for (const item of questions) {
      const db = openIndexDatabase(':memory:')
      const generation = Number(
        db
          .prepare(
            "INSERT INTO index_generations (model, dimensions, status, created_at, activated_at) VALUES ('m', 3, 'active', 1, 1)",
          )
          .run().lastInsertRowid,
      )
      item.documents.forEach((content, index) =>
        db
          .prepare(
            `INSERT INTO chunks (id, generation_id, account_id, thread_id, message_id, source_type, source_location,
              content, content_hash, internal_date, metadata_json)
             VALUES (?, ?, 1, 't', ?, 'message', 'body:1', ?, 'h', 1, '{}')`,
          )
          .run(`c${index}`, generation, `m${index}`, content),
      )
      const hits = new SqliteKnowledgeRepository(db).lexicalSearch(item.question, { accountIds: [1] }, generation, 5)
      expect(hits[0]?.id, item.question).toBe(`c${item.relevant}`)
      db.close()
    }
  })
})
