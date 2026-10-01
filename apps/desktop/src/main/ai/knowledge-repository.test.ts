import { describe, expect, it } from 'vitest'
import { openIndexDatabase } from '../db/index'
import { SqliteKnowledgeRepository } from './knowledge-repository'

describe('SqliteKnowledgeRepository', () => {
  it('searches chunk FTS within explicit account scope', () => {
    const db = openIndexDatabase(':memory:')
    const generation = Number(
      db
        .prepare(
          "INSERT INTO index_generations (model, dimensions, status, created_at, activated_at) VALUES ('m', 3, 'active', 1, 1)",
        )
        .run().lastInsertRowid,
    )
    const insert = db.prepare(
      `INSERT INTO chunks
       (id, generation_id, account_id, thread_id, message_id, source_type, source_location,
        content, content_hash, internal_date, metadata_json)
       VALUES (?, ?, ?, ?, ?, 'message', 'body:1', ?, 'hash', 1, '{}')`,
    )
    insert.run('c1', generation, 1, 't1', 'm1', 'renewal price')
    insert.run('c2', generation, 2, 't2', 'm2', 'renewal private')

    const results = new SqliteKnowledgeRepository(db).lexicalSearch(
      'renewal',
      { accountIds: [1] },
      generation,
      10,
    )

    expect(results.map((result) => result.id)).toEqual(['c1'])
    db.close()
  })

  it('returns lexical hits for natural-language questions', () => {
    const db = openIndexDatabase(':memory:')
    const generation = Number(
      db
        .prepare(
          "INSERT INTO index_generations (model, dimensions, status, created_at, activated_at) VALUES ('m', 3, 'active', 1, 1)",
        )
        .run().lastInsertRowid,
    )
    const insert = db.prepare(
      `INSERT INTO chunks
       (id, generation_id, account_id, thread_id, message_id, source_type, source_location,
        content, content_hash, internal_date, metadata_json)
       VALUES (?, ?, 1, ?, ?, 'message', 'body:1', ?, 'hash', 1, '{}')`,
    )
    insert.run('c1', generation, 't1', 'm1', 'Bob sent the contract for signature')
    insert.run('c2', generation, 't2', 'm2', 'Lunch on Friday')
    const repository = new SqliteKnowledgeRepository(db)

    const results = repository.lexicalSearch('When did Bob send the contract?', { accountIds: [1] }, generation, 10)

    expect(results.map((result) => result.id)).toEqual(['c1'])
    expect(repository.lexicalSearch('what is the', { accountIds: [1] }, generation, 10)).toEqual([])
    expect(repository.activeGenerationInfo()).toEqual({ id: generation, model: 'm', dimensions: 3 })
    db.close()
  })

  it('returns the first body chunk of each newest message, newest first, within scope', () => {
    const db = openIndexDatabase(':memory:')
    const generation = Number(
      db
        .prepare(
          "INSERT INTO index_generations (model, dimensions, status, created_at, activated_at) VALUES ('m', 3, 'active', 1, 1)",
        )
        .run().lastInsertRowid,
    )
    const insert = db.prepare(
      `INSERT INTO chunks
       (id, generation_id, account_id, thread_id, message_id, source_type, source_location,
        content, content_hash, internal_date, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hash', ?, '{}')`,
    )
    insert.run('old', generation, 1, 't1', 'm-old', 'message', 'body:1', 'old body', 100)
    insert.run('mid-1', generation, 1, 't2', 'm-mid', 'message', 'body:1', 'mid first part', 200)
    insert.run('mid-2', generation, 1, 't2', 'm-mid', 'message', 'body:2', 'mid second part', 200)
    insert.run('new', generation, 1, 't3', 'm-new', 'message', 'body:1', 'new body', 300)
    insert.run('new-att', generation, 1, 't3', 'm-new', 'attachment', 'page:1', 'attachment text', 300)
    insert.run('other-account', generation, 2, 't4', 'm-other', 'message', 'body:1', 'other', 400)

    const results = new SqliteKnowledgeRepository(db).recentMessageChunks([1], generation, 2)

    expect(results.map((result) => result.id)).toEqual(['new', 'mid-1'])
    db.close()
  })
})
