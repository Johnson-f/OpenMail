import type { SearchHit } from '@gmail/core'
import type { Db } from './index.js'

type SearchRow = {
  messageId: string
  threadId: string
  subject: string | null
  snippet: string | null
}

/**
 * FTS5 treats `"`, `*`, `:`, `^`, `-`, `AND`, `OR`, `NEAR` as query syntax.
 * User input is not a query language: each whitespace-separated token has
 * its double quotes stripped, then gets wrapped in double quotes so it can
 * only ever be matched as a literal phrase. That neutralizes every FTS5
 * operator above — including a stray `"` or a bare `AND` — without ever
 * raising a SQL error.
 */
export function searchMessages(db: Db, accountId: number, query: string, limit: number): SearchHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return []

  const ftsQuery = tokens.map((t) => `"${t}"`).join(' ')

  const rows = db
    .prepare(
      `SELECT
         m.id AS messageId,
         m.thread_id AS threadId,
         m.subject AS subject,
         m.snippet AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid AND m.account_id = @accountId
       WHERE messages_fts MATCH @ftsQuery
       ORDER BY rank
       LIMIT @limit`
    )
    .all({ accountId, ftsQuery, limit }) as SearchRow[]

  return rows.map((r) => ({
    messageId: r.messageId,
    threadId: r.threadId,
    subject: r.subject ?? '',
    snippet: r.snippet ?? '',
  }))
}
