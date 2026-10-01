export type VectorRecord = {
  rowId: number
  accountId: number
  generationId: number
  embedding: number[]
}

export type VectorSearch = {
  accountIds: number[]
  generationId: number
  limit: number
}

export type VectorMatch = { rowId: number; distance: number }

export interface VectorIndex {
  readonly dimensions: number
  upsert(records: VectorRecord[]): void
  delete(rowIds: number[]): void
  search(query: number[], options: VectorSearch): VectorMatch[]
}

export class FakeVectorIndex implements VectorIndex {
  private readonly records = new Map<number, VectorRecord>()

  constructor(readonly dimensions: number) {}

  upsert(records: VectorRecord[]): void {
    for (const record of records) {
      if (record.embedding.length !== this.dimensions) throw new Error('Embedding dimension mismatch')
      this.records.set(record.rowId, { ...record, embedding: [...record.embedding] })
    }
  }

  delete(rowIds: number[]): void {
    for (const rowId of rowIds) this.records.delete(rowId)
  }

  search(query: number[], options: VectorSearch): VectorMatch[] {
    if (query.length !== this.dimensions) throw new Error('Query dimension mismatch')
    const accounts = new Set(options.accountIds)
    return [...this.records.values()]
      .filter((record) => accounts.has(record.accountId) && record.generationId === options.generationId)
      .map((record) => ({ rowId: record.rowId, distance: cosineDistance(query, record.embedding) }))
      .sort((a, b) => a.distance - b.distance || a.rowId - b.rowId)
      .slice(0, options.limit)
  }
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    aNorm += av * av
    bNorm += bv * bv
  }
  if (aNorm === 0 || bNorm === 0) return 1
  return 1 - dot / Math.sqrt(aNorm * bNorm)
}
