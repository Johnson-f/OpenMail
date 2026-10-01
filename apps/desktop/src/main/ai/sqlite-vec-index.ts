import type { VectorIndex, VectorMatch, VectorRecord, VectorSearch } from '@gmail/intelligence'
import * as sqliteVec from 'sqlite-vec'
import { existsSync } from 'node:fs'
import type { Db } from '../db/index'

type MatchRow = { rowid: number | bigint; distance: number }

export class SqliteVecIndex implements VectorIndex {
  constructor(
    private readonly db: Db,
    readonly dimensions = 1024,
  ) {
    const packagedPath = sqliteVec.getLoadablePath().replace('app.asar/', 'app.asar.unpacked/')
    if (packagedPath !== sqliteVec.getLoadablePath() && existsSync(packagedPath)) db.loadExtension(packagedPath)
    else sqliteVec.load(db)
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
         embedding float[${dimensions}] distance_metric=cosine,
         account_id integer partition key,
         generation_id integer
       )`,
    )
  }

  version(): string {
    return (this.db.prepare('SELECT vec_version() AS version').get() as { version: string }).version
  }

  upsert(records: VectorRecord[]): void {
    const remove = this.db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?')
    const insert = this.db.prepare(
      'INSERT INTO chunk_vectors (rowid, embedding, account_id, generation_id) VALUES (?, ?, ?, ?)',
    )
    this.db.transaction((items: VectorRecord[]) => {
      for (const record of items) {
        this.assertDimensions(record.embedding)
        const rowId = BigInt(record.rowId)
        remove.run(rowId)
        insert.run(
          rowId,
          vectorBlob(record.embedding),
          BigInt(record.accountId),
          BigInt(record.generationId),
        )
      }
    })(records)
  }

  delete(rowIds: number[]): void {
    const remove = this.db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?')
    this.db.transaction((ids: number[]) => {
      for (const rowId of ids) remove.run(BigInt(rowId))
    })(rowIds)
  }

  search(query: number[], options: VectorSearch): VectorMatch[] {
    this.assertDimensions(query)
    if (options.accountIds.length === 0 || options.limit <= 0) return []
    const perAccount = Math.max(options.limit, 1)
    const statement = this.db.prepare(
      `SELECT rowid, distance
       FROM chunk_vectors
       WHERE embedding MATCH ?
         AND k = ?
         AND account_id = ?
         AND generation_id = ?
       ORDER BY distance`,
    )
    return options.accountIds
      .flatMap((accountId) =>
        (statement.all(
          vectorBlob(query),
          perAccount,
          BigInt(accountId),
          BigInt(options.generationId),
        ) as MatchRow[]).map((row) => ({ rowId: Number(row.rowid), distance: row.distance })),
      )
      .sort((a, b) => a.distance - b.distance || a.rowId - b.rowId)
      .slice(0, options.limit)
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`Expected ${this.dimensions} dimensions, received ${vector.length}`)
    }
  }
}

function vectorBlob(vector: number[]): Buffer {
  const floats = new Float32Array(vector)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}
