import { describe, expect, it } from 'vitest'
import { openIndexDatabase } from '../db/index'
import { SqliteVecIndex } from './sqlite-vec-index'

describe('SqliteVecIndex', () => {
  it('loads the native extension and returns scoped nearest neighbours', () => {
    const db = openIndexDatabase(':memory:')
    const index = new SqliteVecIndex(db, 3)
    index.upsert([
      { rowId: 1, accountId: 1, generationId: 1, embedding: [1, 0, 0] },
      { rowId: 2, accountId: 1, generationId: 1, embedding: [0.9, 0.1, 0] },
      { rowId: 3, accountId: 2, generationId: 1, embedding: [1, 0, 0] },
      { rowId: 4, accountId: 1, generationId: 2, embedding: [1, 0, 0] },
    ])

    expect(index.version()).toMatch(/^v?0\./)
    expect(index.search([1, 0, 0], { accountIds: [1], generationId: 1, limit: 5 }).map((row) => row.rowId)).toEqual([1, 2])
    expect(index.search([1, 0, 0], { accountIds: [2], generationId: 1, limit: 5 }).map((row) => row.rowId)).toEqual([3])

    index.delete([1])
    expect(index.search([1, 0, 0], { accountIds: [1], generationId: 1, limit: 5 }).map((row) => row.rowId)).toEqual([2])
    db.close()
  })

  it('rejects vectors with the wrong dimensions', () => {
    const db = openIndexDatabase(':memory:')
    const index = new SqliteVecIndex(db, 3)
    expect(() => index.upsert([{ rowId: 1, accountId: 1, generationId: 1, embedding: [1] }])).toThrow(/dimensions/)
    db.close()
  })
})
