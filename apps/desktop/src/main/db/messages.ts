import type { MailboxCounts, StoredMessage, ThreadSummary } from '@gmail/core'
import type { Db } from './index.js'

type MessageRow = {
  id: string
  thread_id: string
  from_addr: string | null
  to_addrs: string | null
  cc_addrs: string | null
  subject: string | null
  snippet: string | null
  body_text: string | null
  body_html: string | null
  internal_date: number | null
}

/**
 * Upserts a message row, replaces its labels wholesale (never appends), and
 * upserts the parent thread row so `last_message_at` only ever moves forward.
 */
export function upsertMessage(db: Db, accountId: number, msg: StoredMessage): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_message_at)
       VALUES (@accountId, @threadId, @subject, @internalDate)
       ON CONFLICT(account_id, id) DO UPDATE SET
         subject = excluded.subject,
         last_message_at = MAX(COALESCE(threads.last_message_at, 0), excluded.last_message_at)`
    ).run({ accountId, threadId: msg.threadId, subject: msg.subject, internalDate: msg.internalDate })

    db.prepare(
      `INSERT INTO messages
         (account_id, id, thread_id, from_addr, to_addrs, cc_addrs, subject, snippet, body_text, body_html, internal_date)
       VALUES
         (@accountId, @id, @threadId, @from, @to, @cc, @subject, @snippet, @bodyText, @bodyHtml, @internalDate)
       ON CONFLICT(account_id, id) DO UPDATE SET
         thread_id = excluded.thread_id,
         from_addr = excluded.from_addr,
         to_addrs = excluded.to_addrs,
         cc_addrs = excluded.cc_addrs,
         subject = excluded.subject,
         snippet = excluded.snippet,
         body_text = excluded.body_text,
         body_html = excluded.body_html,
         internal_date = excluded.internal_date`
    ).run({
      accountId,
      id: msg.id,
      threadId: msg.threadId,
      from: msg.from,
      to: JSON.stringify(msg.to),
      cc: JSON.stringify(msg.cc),
      subject: msg.subject,
      snippet: msg.snippet,
      bodyText: msg.bodyText,
      bodyHtml: msg.bodyHtml,
      internalDate: msg.internalDate,
    })

    db.prepare(`DELETE FROM message_labels WHERE account_id = ? AND message_id = ?`).run(accountId, msg.id)
    const insertLabel = db.prepare(
      `INSERT INTO message_labels (account_id, message_id, label_id) VALUES (?, ?, ?)`
    )
    for (const labelId of msg.labelIds) {
      insertLabel.run(accountId, msg.id, labelId)
    }
  })

  tx()
}

export function deleteMessage(db: Db, accountId: number, messageId: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM message_labels WHERE account_id = ? AND message_id = ?`).run(accountId, messageId)
    db.prepare(`DELETE FROM messages WHERE account_id = ? AND id = ?`).run(accountId, messageId)
  })
  tx()
}

export function getMessage(db: Db, accountId: number, messageId: string): StoredMessage | null {
  const row = db
    .prepare(`SELECT * FROM messages WHERE account_id = ? AND id = ?`)
    .get(accountId, messageId) as MessageRow | undefined
  if (!row) return null

  const labelRows = db
    .prepare(
      `SELECT label_id FROM message_labels WHERE account_id = ? AND message_id = ? ORDER BY label_id ASC`
    )
    .all(accountId, messageId) as { label_id: string }[]

  return {
    id: row.id,
    threadId: row.thread_id,
    from: row.from_addr ?? '',
    to: JSON.parse(row.to_addrs ?? '[]'),
    cc: JSON.parse(row.cc_addrs ?? '[]'),
    subject: row.subject ?? '',
    snippet: row.snippet ?? '',
    bodyText: row.body_text ?? '',
    bodyHtml: row.body_html ?? '',
    internalDate: row.internal_date ?? 0,
    labelIds: labelRows.map((l) => l.label_id),
  }
}

type ThreadRow = {
  threadId: string
  subject: string | null
  lastMessageAt: number | null
  messageCount: number
  unread: number
}

/**
 * Threads containing at least one message with `labelId`, newest first.
 * Every selected column that isn't part of GROUP BY goes through an
 * aggregate function on purpose — a bare column in a GROUP BY query
 * silently returns an arbitrary row's value in SQLite.
 */
export function listThreads(db: Db, accountId: number, labelId: string, limit: number): ThreadSummary[] {
  const rows = db
    .prepare(
      `WITH matching AS (
         SELECT DISTINCT m2.thread_id AS thread_id
         FROM messages m2
         JOIN message_labels ml
           ON ml.account_id = m2.account_id
          AND ml.message_id = m2.id
          AND ml.label_id = @labelId
         WHERE m2.account_id = @accountId
       ),
       newest AS (
         SELECT m.thread_id,
                m.id           AS newest_id,
                m.from_addr    AS from_addr,
                m.snippet      AS snippet,
                m.subject      AS subject,
                m.internal_date AS internal_date,
                ROW_NUMBER() OVER (
                  PARTITION BY m.thread_id ORDER BY m.internal_date DESC, m.id DESC
                ) AS rn
         FROM messages m
         JOIN matching t ON t.thread_id = m.thread_id
         WHERE m.account_id = @accountId
       )
       SELECT
         n.thread_id                                                       AS threadId,
         n.subject                                                         AS subject,
         n.from_addr                                                       AS fromAddr,
         n.snippet                                                         AS snippet,
         n.internal_date                                                   AS lastMessageAt,
         (SELECT COUNT(*) FROM messages c
           WHERE c.account_id = @accountId AND c.thread_id = n.thread_id)  AS messageCount,
         (SELECT COUNT(*) FROM messages c
            JOIN message_labels cl ON cl.account_id = c.account_id
             AND cl.message_id = c.id AND cl.label_id = 'UNREAD'
           WHERE c.account_id = @accountId AND c.thread_id = n.thread_id)  AS unreadCount,
         (SELECT COUNT(*) FROM messages c
            JOIN message_labels cl ON cl.account_id = c.account_id
             AND cl.message_id = c.id AND cl.label_id = 'STARRED'
           WHERE c.account_id = @accountId AND c.thread_id = n.thread_id)  AS starredCount,
         (SELECT COUNT(*) FROM attachments a
           WHERE a.account_id = @accountId AND a.message_id IN (
             SELECT c.id FROM messages c
              WHERE c.account_id = @accountId AND c.thread_id = n.thread_id))
                                                                          AS attachmentCount
       FROM newest n
       WHERE n.rn = 1
       ORDER BY n.internal_date DESC
       LIMIT @limit`
    )
    .all({ accountId, labelId, limit }) as {
      threadId: string
      subject: string | null
      fromAddr: string | null
      snippet: string | null
      lastMessageAt: number | null
      messageCount: number
      unreadCount: number
      starredCount: number
      attachmentCount: number
    }[]

  return rows.map((r) => ({
    threadId: r.threadId,
    subject: r.subject ?? '',
    from: displayName(r.fromAddr ?? ''),
    snippet: r.snippet ?? '',
    lastMessageAt: r.lastMessageAt ?? 0,
    messageCount: r.messageCount,
    unread: r.unreadCount > 0,
    starred: r.starredCount > 0,
    hasAttachment: r.attachmentCount > 0,
  }))
}

/**
 * Turn a raw From header into what the list should show.
 *
 * `"Ameet Rai (JIRA)" <a@x.com>` becomes `Ameet Rai (JIRA)`; a bare address
 * stays as-is. Quotes are stripped because they are RFC syntax, not part of
 * the name a person expects to read.
 */
export function displayName(fromHeader: string): string {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(fromHeader)
  if (!match) return fromHeader.trim()
  const name = (match[1] ?? '').replace(/^"|"$/g, '').trim()
  return name.length > 0 ? name : (match[2] ?? '').trim()
}

/** Per-mailbox totals for the sidebar. */
export function mailboxCounts(db: Db, accountId: number, labelIds: string[]): MailboxCounts[] {
  const total = db.prepare(
    `SELECT COUNT(DISTINCT m.id) AS n FROM messages m
       JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id
      WHERE m.account_id = ? AND ml.label_id = ?`
  )
  const unread = db.prepare(
    `SELECT COUNT(DISTINCT m.id) AS n FROM messages m
       JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id
       JOIN message_labels u  ON u.account_id = m.account_id AND u.message_id = m.id AND u.label_id = 'UNREAD'
      WHERE m.account_id = ? AND ml.label_id = ?`
  )
  const named = db.prepare('SELECT name FROM labels WHERE account_id = ? AND id = ?')

  return labelIds.map((labelId) => ({
    labelId,
    name: ((named.get(accountId, labelId) as { name: string } | undefined)?.name ?? labelId),
    total: (total.get(accountId, labelId) as { n: number }).n,
    unread: (unread.get(accountId, labelId) as { n: number }).n,
  }))
}

