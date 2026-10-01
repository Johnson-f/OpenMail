import type { KnowledgeRepository, LexicalMatch, RetrievalScope, StoredChunk } from '@gmail/intelligence'
import type { Db } from '../db/index'

type ChunkRow = {
  rowId: number
  id: string
  accountId: number
  threadId: string
  messageId: string
  attachmentPartId: string | null
  sourceType: 'message' | 'attachment'
  sourceLocation: string
  content: string
  internalDate: number
  metadataJson: string
  rank?: number
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: Db) {}

  activeGenerationInfo(): { id: number; model: string; dimensions: number } | null {
    const row = this.db
      .prepare("SELECT id, model, dimensions FROM index_generations WHERE status = 'active' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; model: string; dimensions: number } | undefined
    return row ?? null
  }

  lexicalSearch(query: string, scope: RetrievalScope, generationId: number, limit: number): LexicalMatch[] {
    const ftsQuery = keywordFtsQuery(query)
    if (!ftsQuery || scope.accountIds.length === 0) return []
    const accountPlaceholders = scope.accountIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT c.rowid AS rowId, c.id, c.account_id AS accountId, c.thread_id AS threadId,
                c.message_id AS messageId, c.attachment_part_id AS attachmentPartId,
                c.source_type AS sourceType, c.source_location AS sourceLocation,
                c.content, c.internal_date AS internalDate, c.metadata_json AS metadataJson,
                bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
           AND c.generation_id = ?
           AND c.account_id IN (${accountPlaceholders})
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, generationId, ...scope.accountIds, limit) as ChunkRow[]
    return rows.map((row) => ({ ...mapRow(row), rank: row.rank ?? 0 }))
  }

  chunksByRowIds(rowIds: number[]): StoredChunk[] {
    if (rowIds.length === 0) return []
    const placeholders = rowIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT rowid AS rowId, id, account_id AS accountId, thread_id AS threadId,
                message_id AS messageId, attachment_part_id AS attachmentPartId,
                source_type AS sourceType, source_location AS sourceLocation,
                content, internal_date AS internalDate, metadata_json AS metadataJson
         FROM chunks WHERE rowid IN (${placeholders})`,
      )
      .all(...rowIds) as ChunkRow[]
    return rows.map(mapRow)
  }

  recentMessageChunks(accountIds: number[], generationId: number, messageLimit: number): StoredChunk[] {
    if (accountIds.length === 0 || messageLimit <= 0) return []
    const rows = this.db
      .prepare(
        `WITH recent AS (
           SELECT MIN(rowid) AS firstRow, MAX(internal_date) AS newest
           FROM chunks
           WHERE generation_id = ? AND account_id IN (${placeholders(accountIds)}) AND source_type = 'message'
           GROUP BY account_id, message_id
           ORDER BY newest DESC
           LIMIT ?
         )
         SELECT c.rowid AS rowId, c.id, c.account_id AS accountId, c.thread_id AS threadId,
                c.message_id AS messageId, c.attachment_part_id AS attachmentPartId,
                c.source_type AS sourceType, c.source_location AS sourceLocation,
                c.content, c.internal_date AS internalDate, c.metadata_json AS metadataJson
         FROM recent JOIN chunks c ON c.rowid = recent.firstRow
         ORDER BY recent.newest DESC`,
      )
      .all(generationId, ...accountIds, messageLimit) as ChunkRow[]
    return rows.map(mapRow)
  }

  chunksForThreads(accountIds: number[], threadIds: string[], generationId: number): StoredChunk[] {
    if (accountIds.length === 0 || threadIds.length === 0) return []
    const accountPlaceholders = accountIds.map(() => '?').join(',')
    const threadPlaceholders = threadIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT rowid AS rowId, id, account_id AS accountId, thread_id AS threadId,
                message_id AS messageId, attachment_part_id AS attachmentPartId,
                source_type AS sourceType, source_location AS sourceLocation,
                content, internal_date AS internalDate, metadata_json AS metadataJson
         FROM chunks
         WHERE generation_id = ?
           AND account_id IN (${accountPlaceholders})
           AND thread_id IN (${threadPlaceholders})
         ORDER BY internal_date, message_id, source_type, source_location`,
      )
      .all(generationId, ...accountIds, ...threadIds) as ChunkRow[]
    return rows.map(mapRow)
  }
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',')
}

function mapRow(row: ChunkRow): StoredChunk {
  return {
    rowId: row.rowId,
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    messageId: row.messageId,
    ...(row.attachmentPartId ? { attachmentPartId: row.attachmentPartId } : {}),
    sourceType: row.sourceType,
    sourceLocation: row.sourceLocation,
    content: row.content,
    internalDate: row.internalDate,
    metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
  }
}

const STOPWORDS = new Set(
  `a an the and or but if of at by for with about as into to from in on off up out over is are was were be been being
   am do does did done have has had having i me my we us our you your he him his she her it its they them their what
   when where which who whom whose why how that this these those can could would should will shall may might must not
   no so than then there here any some please tell show find`.split(/\s+/),
)
const MAX_QUERY_TOKENS = 16

function keywordFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((token) => token.replace(/^[._+-]+|[._+-]+$/g, ''))
    .filter((token) => token && !STOPWORDS.has(token))
  return [...new Set(tokens)]
    .slice(0, MAX_QUERY_TOKENS)
    .map((token) => `"${token.replace(/"/g, '')}"`)
    .join(' OR ')
}
