import type { MailboxCounts, MailEventContext, StoredMessage, ThreadSummary } from '@gmail/core'
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
  message_id_header: string
  in_reply_to: string
  references_json: string
}

type AttachmentRow = {
  part_id: string
  filename: string | null
  mime_type: string | null
  size_bytes: number | null
  attachment_id: string | null
  content_id: string | null
  disposition: string
  inline_data: string | null
}

function recordMailEvent(
  db: Db,
  accountId: number,
  messageId: string,
  threadId: string | null,
  kind: string,
  event: MailEventContext | undefined,
): void {
  if (!event) return
  db.prepare(
    `INSERT INTO mail_events
       (event_key, account_id, message_id, thread_id, kind, origin, history_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key) DO NOTHING`,
  ).run(
    event.eventKey,
    accountId,
    messageId,
    threadId,
    kind,
    event.origin,
    event.historyId ?? null,
    JSON.stringify(event.payload ?? {}),
    Date.now(),
  )
}

/**
 * Gmail's labels overwrite `message_labels` on every sync, so local changes
 * that have not uploaded yet are re-applied on top, in id order (removes,
 * then adds). Safe because Gmail label operations are idempotent set
 * operations. Abandoned and uploaded rows are no longer replayed.
 */
function replayPendingLabelChanges(db: Db, accountId: number, messageId: string): void {
  const rows = db
    .prepare(
      `SELECT add_labels, remove_labels FROM outbox
       WHERE account_id = ? AND message_id = ? AND status IN ('pending', 'failed')
       ORDER BY id ASC`,
    )
    .all(accountId, messageId) as { add_labels: string; remove_labels: string }[]
  if (rows.length === 0) return
  applyLabelChange(db, accountId, messageId, rows)
}

export function applyLabelChange(
  db: Db,
  accountId: number,
  messageId: string,
  changes: { add_labels: string; remove_labels: string }[],
): void {
  const remove = db.prepare(`DELETE FROM message_labels WHERE account_id = ? AND message_id = ? AND label_id = ?`)
  const add = db.prepare(
    `INSERT OR IGNORE INTO message_labels (account_id, message_id, label_id) VALUES (?, ?, ?)`,
  )
  for (const change of changes) {
    for (const label of JSON.parse(change.remove_labels) as string[]) remove.run(accountId, messageId, label)
    for (const label of JSON.parse(change.add_labels) as string[]) add.run(accountId, messageId, label)
  }
}

/**
 * Upserts a message row, replaces its labels with Gmail's (then replays
 * unuploaded local changes), and upserts the parent thread row so
 * `last_message_at` only ever moves forward.
 */
export function upsertMessage(
  db: Db,
  accountId: number,
  msg: StoredMessage,
  event?: MailEventContext,
): void {
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
         (account_id, id, thread_id, from_addr, to_addrs, cc_addrs, subject, snippet, body_text, body_html,
          internal_date, message_id_header, in_reply_to, references_json, seen_epoch)
       VALUES
         (@accountId, @id, @threadId, @from, @to, @cc, @subject, @snippet, @bodyText, @bodyHtml,
          @internalDate, @messageIdHeader, @inReplyTo, @references,
          COALESCE((SELECT sync_epoch FROM accounts WHERE id = @accountId), 0))
       ON CONFLICT(account_id, id) DO UPDATE SET
         thread_id = excluded.thread_id,
         from_addr = excluded.from_addr,
         to_addrs = excluded.to_addrs,
         cc_addrs = excluded.cc_addrs,
         subject = excluded.subject,
         snippet = excluded.snippet,
         body_text = excluded.body_text,
         body_html = excluded.body_html,
         internal_date = excluded.internal_date,
         message_id_header = excluded.message_id_header,
         in_reply_to = excluded.in_reply_to,
         references_json = excluded.references_json,
         seen_epoch = excluded.seen_epoch`
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
      messageIdHeader: msg.messageIdHeader,
      inReplyTo: msg.inReplyTo,
      references: JSON.stringify(msg.references),
    })

    db.prepare(`DELETE FROM message_labels WHERE account_id = ? AND message_id = ?`).run(accountId, msg.id)
    const insertLabel = db.prepare(
      `INSERT INTO message_labels (account_id, message_id, label_id) VALUES (?, ?, ?)`
    )
    for (const labelId of msg.labelIds) {
      insertLabel.run(accountId, msg.id, labelId)
    }
    replayPendingLabelChanges(db, accountId, msg.id)

    db.prepare(`DELETE FROM attachments WHERE account_id = ? AND message_id = ?`).run(accountId, msg.id)
    const insertAttachment = db.prepare(
      `INSERT INTO attachments
         (account_id, message_id, part_id, filename, mime_type, size_bytes, attachment_id,
          content_id, disposition, inline_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const attachment of msg.attachments) {
      insertAttachment.run(
        accountId,
        msg.id,
        attachment.partId,
        attachment.filename,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.attachmentId ?? null,
        attachment.contentId ?? null,
        attachment.disposition,
        attachment.inlineData ?? null,
      )
    }
    recordMailEvent(db, accountId, msg.id, msg.threadId, 'message_upserted', event)
  })

  tx()
}

export function deleteMessage(
  db: Db,
  accountId: number,
  messageId: string,
  event?: MailEventContext,
): void {
  const tx = db.transaction(() => {
    const message = db
      .prepare('SELECT thread_id FROM messages WHERE account_id = ? AND id = ?')
      .get(accountId, messageId) as { thread_id: string } | undefined
    db.prepare(`DELETE FROM message_labels WHERE account_id = ? AND message_id = ?`).run(accountId, messageId)
    db.prepare(`DELETE FROM attachments WHERE account_id = ? AND message_id = ?`).run(accountId, messageId)
    db.prepare(`DELETE FROM messages WHERE account_id = ? AND id = ?`).run(accountId, messageId)
    if (message) refreshThread(db, accountId, message.thread_id)
    recordMailEvent(db, accountId, messageId, message?.thread_id ?? null, 'message_deleted', event)
  })
  tx()
}

function refreshThread(db: Db, accountId: number, threadId: string): void {
  const newest = db
    .prepare(
      `SELECT subject, internal_date FROM messages
       WHERE account_id = ? AND thread_id = ?
       ORDER BY internal_date DESC, id DESC LIMIT 1`,
    )
    .get(accountId, threadId) as { subject: string | null; internal_date: number | null } | undefined
  if (!newest) {
    db.prepare('DELETE FROM threads WHERE account_id = ? AND id = ?').run(accountId, threadId)
    return
  }
  db.prepare('UPDATE threads SET subject = ?, last_message_at = ? WHERE account_id = ? AND id = ?').run(
    newest.subject,
    newest.internal_date,
    accountId,
    threadId,
  )
}

export function beginResync(db: Db, accountId: number): void {
  db.prepare(`UPDATE accounts SET sync_epoch = sync_epoch + 1 WHERE id = ?`).run(accountId)
}

export function sweepUnseen(db: Db, accountId: number): void {
  const epoch = (db.prepare(`SELECT sync_epoch FROM accounts WHERE id = ?`).get(accountId) as
    | { sync_epoch: number }
    | undefined)?.sync_epoch
  if (!epoch) return
  const stale = db
    .prepare(`SELECT id FROM messages WHERE account_id = ? AND seen_epoch < ?`)
    .all(accountId, epoch) as { id: string }[]
  const abandon = db.prepare(
    `UPDATE outbox SET status = 'abandoned', last_error = 'message deleted remotely'
     WHERE account_id = ? AND message_id = ? AND status IN ('pending', 'failed')`,
  )
  for (const { id } of stale) {
    db.transaction(() => {
      deleteMessage(db, accountId, id, {
        eventKey: `resync:${accountId}:${epoch}:${id}`,
        origin: 'reconciliation',
      })
      abandon.run(accountId, id)
    })()
  }
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
  const attachmentRows = db
    .prepare(`SELECT * FROM attachments WHERE account_id = ? AND message_id = ? ORDER BY part_id`)
    .all(accountId, messageId) as AttachmentRow[]

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
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.references_json),
    attachments: attachmentRows.map((attachment) => ({
      partId: attachment.part_id,
      filename: attachment.filename ?? '',
      mimeType: attachment.mime_type ?? 'application/octet-stream',
      sizeBytes: attachment.size_bytes ?? 0,
      ...(attachment.attachment_id ? { attachmentId: attachment.attachment_id } : {}),
      ...(attachment.content_id ? { contentId: attachment.content_id } : {}),
      disposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
      ...(attachment.inline_data ? { inlineData: attachment.inline_data } : {}),
    })),
  }
}

type ThreadRow = {
  threadId: string
  subject: string | null
  lastMessageAt: number | null
  messageCount: number
  unread: number
}

export const THREAD_PAGE_SQL = `WITH ordered AS MATERIALIZED (
    SELECT id FROM threads WHERE account_id = @accountId
    ORDER BY last_message_at DESC, id DESC
  )
  SELECT o.id AS id FROM ordered o
  WHERE EXISTS (
    SELECT 1 FROM messages m
    JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id
    WHERE m.account_id = @accountId AND m.thread_id = o.id AND ml.label_id = @labelId
  )
  LIMIT @limit`

/**
 * Threads containing at least one message with `labelId`, newest first.
 * The page of thread ids is chosen first so the per-thread aggregates only
 * run for the rows that are shown.
 */
export function listThreads(db: Db, accountId: number, labelId: string, limit: number): ThreadSummary[] {
  const pageIds = (
    db.prepare(THREAD_PAGE_SQL).all({ accountId, labelId, limit }) as { id: string }[]
  ).map((r) => r.id)
  if (pageIds.length === 0) return []

  const unsorted = db
    .prepare(
      `WITH page(thread_id) AS (SELECT value FROM json_each(@ids))
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
       FROM page p
       CROSS JOIN messages n ON n.rowid = (
         SELECT m.rowid FROM messages m
          WHERE m.account_id = @accountId AND m.thread_id = p.thread_id
          ORDER BY m.internal_date DESC, m.id DESC LIMIT 1)`,
    )
    .all({ accountId, ids: JSON.stringify(pageIds) }) as {
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
  const position = new Map(pageIds.map((id, index) => [id, index]))
  const rows = unsorted.sort((a, b) => position.get(a.threadId)! - position.get(b.threadId)!)

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
  const grouped = db
    .prepare(
      `SELECT ml.label_id AS labelId,
              COUNT(*) AS total,
              COUNT(u.label_id) AS unread
       FROM message_labels ml
       JOIN messages m ON m.account_id = ml.account_id AND m.id = ml.message_id
       LEFT JOIN message_labels u
         ON u.account_id = ml.account_id AND u.message_id = ml.message_id AND u.label_id = 'UNREAD'
       WHERE ml.account_id = @accountId
         AND ml.label_id IN (SELECT value FROM json_each(@labelIds))
       GROUP BY ml.label_id`,
    )
    .all({ accountId, labelIds: JSON.stringify(labelIds) }) as { labelId: string; total: number; unread: number }[]
  const byLabel = new Map(grouped.map((row) => [row.labelId, row]))
  const named = db.prepare('SELECT name FROM labels WHERE account_id = ? AND id = ?')

  return labelIds.map((labelId) => ({
    labelId,
    name: ((named.get(accountId, labelId) as { name: string } | undefined)?.name ?? labelId),
    total: byLabel.get(labelId)?.total ?? 0,
    unread: byLabel.get(labelId)?.unread ?? 0,
  }))
}
