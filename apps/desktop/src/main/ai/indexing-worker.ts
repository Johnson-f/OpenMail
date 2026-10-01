import { createHash } from 'node:crypto'
import type { EmbeddingProvider, KnowledgeChunk, VectorIndex } from '@gmail/intelligence'
import { chunkMessage, extractAttachment, ProviderError } from '@gmail/intelligence'
import type { StoredMessage } from '@gmail/core'
import { MessageNotFoundError, type GmailApi } from '@gmail/gmail'
import type { Db } from '../db/index'
import { advanceCursor, eventsAfter, INDEXER_CONSUMER, pendingCount, pruneEvents, readCursor } from '../db/event-cursors'
import type { SqliteMailStore } from '../db/store'
import { isRevokedTokenError, markNeedsReauth } from '../auth/tokens'

type IndexJobRow = {
  id: number
  event_key: string
  account_id: number
  message_id: string
  generation_id: number
  attempts: number
}

type WorkItem = {
  eventId: number | null
  jobId: number | null
  eventKey: string
  accountId: number
  messageId: string
  kind: string
  generationId: number
  attempts: number
}

type PreparedUnit = {
  items: WorkItem[]
  message: StoredMessage
  fingerprint: string
  chunks: KnowledgeChunk[]
}

export type IndexingStatus = {
  activeGeneration: number | null
  pendingEvents: number
  indexedChunks: number
  lastError: string | null
  failedJobs: number
  waitingForSignIn: number
  needsKey: boolean
}

export type IndexingWorkerDeps = {
  mailDb: Db
  indexDb: Db
  mailStore: SqliteMailStore
  gmailFor(accountId: number): GmailApi
  embedding(): EmbeddingProvider
  vectorIndex: VectorIndex
  intervalMs?: number
  now?: () => number
}

export const MAX_CHUNKS_PER_MESSAGE = 500
export const MAX_JOB_ATTEMPTS = 5
const BATCH_MESSAGES = 100
const BATCH_CHUNKS = 1_000
const MIN_OCR_BYTES = 10 * 1024
const BACKOFF_START_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60_000
const JOB_RETRY_CAP_MS = 6 * 60 * 60_000
const CLEANUP_ROWS_PER_RUN = 1_000
const EVENT_RETENTION_MS = 7 * 86_400_000
const PRUNE_INTERVAL_MS = 60 * 60_000

class AbortBatch extends Error {
  constructor(readonly cause: unknown) {
    super('indexing batch aborted')
  }
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && /not configured/i.test(error.message)
}

function isGlobalFailure(error: unknown): boolean {
  if (isNotConfigured(error)) return true
  return (
    error instanceof ProviderError &&
    (error.kind === 'authentication' ||
      error.kind === 'rate_limit' ||
      error.kind === 'network' ||
      error.kind === 'timeout')
  )
}

function messageFingerprint(message: StoredMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.subject,
        message.from,
        message.to,
        message.cc,
        message.internalDate,
        message.bodyText,
        message.bodyHtml,
        message.attachments.map((ref) => [ref.partId, ref.attachmentId ?? null, ref.sizeBytes, ref.mimeType]),
      ]),
    )
    .digest('hex')
}

export class IndexingWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<number> | null = null
  private backoffMs = 0
  private backoffUntil = 0
  private lastPruneAt = 0
  private batchEventIds: number[] = []
  private completedEventIds = new Set<number>()

  constructor(private readonly deps: IndexingWorkerDeps) {}

  start(): void {
    if (this.timer) return
    void this.runOnce().catch(() => undefined)
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), this.deps.intervalMs ?? 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  wake(): void {
    void this.runOnce().catch(() => undefined)
  }

  runOnce(): Promise<number> {
    if (this.running) return this.running
    this.running = this.process().finally(() => {
      this.running = null
    })
    return this.running
  }

  retryFailed(): number {
    const now = this.now()
    const info = this.deps.indexDb
      .prepare("UPDATE index_jobs SET status = 'pending', attempts = 0, available_at = ?, updated_at = ? WHERE status = 'failed'")
      .run(now, now)
    this.backoffUntil = 0
    if (info.changes > 0) this.wake()
    return Number(info.changes)
  }

  status(): IndexingStatus {
    const generation = this.deps.indexDb
      .prepare("SELECT id FROM index_generations WHERE status = 'active' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined
    const chunks = this.deps.indexDb.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }
    const failed = this.deps.indexDb
      .prepare("SELECT COUNT(*) AS count FROM index_jobs WHERE status = 'failed'")
      .get() as { count: number }
    const waiting = this.deps.indexDb
      .prepare("SELECT COUNT(*) AS count FROM index_jobs WHERE status = 'waiting_auth'")
      .get() as { count: number }
    return {
      activeGeneration: generation?.id ?? null,
      pendingEvents: pendingCount(this.deps.mailDb, INDEXER_CONSUMER),
      indexedChunks: chunks.count,
      lastError: this.getState('last_error') || null,
      failedJobs: failed.count,
      waitingForSignIn: waiting.count,
      needsKey: this.getState('needs_key') === '1',
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async process(): Promise<number> {
    if (this.now() < this.backoffUntil) return 0
    let processed = 0
    this.pruneIfDue()
    this.resumeSignedInAccounts()
    try {
      for (;;) {
        const items = this.nextItems()
        if (items.length === 0) break
        processed += await this.processBatch(items)
        this.cleanupRetired()
        await new Promise((resolve) => setImmediate(resolve))
      }
      this.cleanupRetired()
      this.activateBuildingGenerations()
    } catch (error) {
      if (!(error instanceof AbortBatch)) throw error
      this.handleGlobalFailure(error.cause)
    }
    return processed
  }

  private pruneIfDue(): void {
    const now = this.now()
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = now
    pruneEvents(this.deps.mailDb, EVENT_RETENTION_MS, now)
  }

  private activateBuildingGenerations(): void {
    const building = this.deps.indexDb
      .prepare("SELECT id FROM index_generations WHERE status = 'building'")
      .all() as Array<{ id: number }>
    for (const { id } of building) this.activateIfComplete(id)
  }

  private handleGlobalFailure(error: unknown): void {
    if (isNotConfigured(error)) {
      this.setState('needs_key', '1')
      this.setState('last_error', '')
      return
    }
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_CAP_MS)
    this.backoffUntil = this.now() + this.backoffMs
    this.setState('needs_key', '0')
    this.setState('last_error', error instanceof Error ? error.message : String(error))
  }

  private nextItems(): WorkItem[] {
    const now = this.now()
    const jobs = this.deps.indexDb
      .prepare(
        `SELECT id, event_key, account_id, message_id, generation_id, attempts FROM index_jobs
         WHERE status = 'pending' AND available_at <= ? ORDER BY id LIMIT ?`,
      )
      .all(now, BATCH_MESSAGES) as IndexJobRow[]
    const items: WorkItem[] = jobs.map((job) => ({
      eventId: null,
      jobId: job.id,
      eventKey: job.event_key,
      accountId: job.account_id,
      messageId: job.message_id,
      kind: 'message_upserted',
      generationId: job.generation_id,
      attempts: job.attempts,
    }))
    const room = BATCH_MESSAGES - items.length
    if (room <= 0) return items
    const events = eventsAfter(this.deps.mailDb, INDEXER_CONSUMER, room)
    if (events.length === 0) return items
    let embedding: EmbeddingProvider
    try {
      embedding = this.deps.embedding()
    } catch (error) {
      throw new AbortBatch(error)
    }
    this.batchEventIds = events.map((event) => event.id)
    this.completedEventIds.clear()
    for (const event of events) {
      const payload = JSON.parse(event.payload_json) as { generationId?: number }
      items.push({
        eventId: event.id,
        jobId: null,
        eventKey: event.event_key,
        accountId: event.account_id,
        messageId: event.message_id,
        kind: event.kind,
        generationId: payload.generationId ?? this.ensureGeneration(embedding.model, embedding.dimensions),
        attempts: 0,
      })
    }
    return items
  }

  private async processBatch(items: WorkItem[]): Promise<number> {
    let embedding: EmbeddingProvider
    try {
      embedding = this.deps.embedding()
    } catch (error) {
      throw new AbortBatch(error)
    }
    let done = 0
    const units = new Map<string, PreparedUnit>()
    const followers = new Map<string, WorkItem[]>()
    let chunkTotal = 0
    for (const item of items) {
      if (this.generationStatus(item.generationId) === 'retired') {
        this.finish(item)
        done += 1
        continue
      }
      if (item.kind === 'message_deleted') {
        this.deleteMessage(item.accountId, item.messageId)
        this.finish(item)
        done += 1
        continue
      }
      const key = `${item.generationId}:${item.accountId}:${item.messageId}`
      const existing = units.get(key)
      if (existing) {
        followers.set(key, [...(followers.get(key) ?? []), item])
        continue
      }
      try {
        const message = this.deps.mailStore.getMessage(item.accountId, item.messageId)
        if (!message) {
          this.deleteMessage(item.accountId, item.messageId)
          this.finish(item)
          done += 1
          continue
        }
        const fingerprint = messageFingerprint(message)
        if (this.storedFingerprint(item) === fingerprint) {
          this.finish(item)
          done += 1
          continue
        }
        const chunks = await this.buildChunks(item.accountId, message)
        units.set(key, { items: [item], message, fingerprint, chunks })
        chunkTotal += chunks.length
      } catch (error) {
        if (isGlobalFailure(error)) throw new AbortBatch(error)
        if (isRevokedTokenError(error)) this.waitForSignIn(item, error)
        else this.recordFailure(item, error)
        done += 1
      }
      if (chunkTotal >= BATCH_CHUNKS) {
        done += await this.embedAndWrite(embedding, [...units.entries()], followers)
        units.clear()
        followers.clear()
        chunkTotal = 0
      }
    }
    done += await this.embedAndWrite(embedding, [...units.entries()], followers)
    return done
  }

  private async embedAndWrite(
    embedding: EmbeddingProvider,
    entries: Array<[string, PreparedUnit]>,
    followers: Map<string, WorkItem[]>,
  ): Promise<number> {
    if (entries.length === 0) return 0
    const prepared = entries.map(([key, unit]) => ({ key, unit }))
    let vectorsByUnit: Array<number[][] | null>
    try {
      vectorsByUnit = await this.embedAll(embedding, prepared.map((entry) => entry.unit))
    } catch (error) {
      if (isGlobalFailure(error)) throw new AbortBatch(error)
      vectorsByUnit = await this.embedIndividually(embedding, prepared.map((entry) => entry.unit))
    }
    let done = 0
    prepared.forEach(({ key, unit }, index) => {
      const all = [...unit.items, ...(followers.get(key) ?? [])]
      const vectors = vectorsByUnit[index]
      if (vectors === null || vectors === undefined) {
        for (const item of all) this.recordFailure(item, new Error('Embedding failed'))
        done += all.length
        return
      }
      const first = unit.items[0]!
      this.replaceMessage(first.accountId, first.messageId, first.generationId, unit.chunks, vectors)
      this.storeFingerprint(first, unit.fingerprint)
      for (const item of all) this.finish(item)
      this.setState('last_error', '')
      this.setState('needs_key', '0')
      this.backoffMs = 0
      done += all.length
    })
    return done
  }

  private async embedAll(embedding: EmbeddingProvider, units: PreparedUnit[]): Promise<number[][][]> {
    const texts = units.flatMap((unit) => unit.chunks.map((chunk) => chunk.content))
    const vectors = texts.length === 0 ? [] : await embedding.embedDocuments(texts)
    if (vectors.length !== texts.length) throw new Error('Embedding result count does not match chunks')
    let offset = 0
    return units.map((unit) => {
      const slice = vectors.slice(offset, offset + unit.chunks.length)
      offset += unit.chunks.length
      return slice
    })
  }

  private async embedIndividually(embedding: EmbeddingProvider, units: PreparedUnit[]): Promise<Array<number[][] | null>> {
    const result: Array<number[][] | null> = []
    for (const unit of units) {
      try {
        result.push((await this.embedAll(embedding, [unit]))[0]!)
      } catch (error) {
        if (isGlobalFailure(error)) throw new AbortBatch(error)
        result.push(null)
        this.setState('last_error', error instanceof Error ? error.message : String(error))
      }
    }
    return result
  }

  private async buildChunks(accountId: number, message: StoredMessage): Promise<KnowledgeChunk[]> {
    const gmail = this.deps.gmailFor(accountId)
    const attachments = []
    for (const ref of message.attachments) {
      const isImage = ref.mimeType.toLowerCase().startsWith('image/')
      if (isImage && (ref.contentId || ref.sizeBytes < MIN_OCR_BYTES)) continue
      let data: Uint8Array | null
      try {
        data = ref.inlineData
          ? Buffer.from(ref.inlineData, 'base64url')
          : ref.attachmentId
            ? await gmail.getAttachment(message.id, ref.attachmentId)
            : null
      } catch (error) {
        if (error instanceof MessageNotFoundError) continue
        throw error
      }
      if (!data) continue
      try {
        attachments.push({
          partId: ref.partId,
          filename: ref.filename,
          mimeType: ref.mimeType,
          result: await extractAttachment({ ref, data }),
        })
      } catch {
        continue
      }
    }
    const chunks = chunkMessage(accountId, message, attachments)
    if (chunks.length <= MAX_CHUNKS_PER_MESSAGE) return chunks
    const body = chunks.filter((chunk) => chunk.sourceType === 'message')
    const extra = chunks.filter((chunk) => chunk.sourceType !== 'message')
    return [...body, ...extra].slice(0, MAX_CHUNKS_PER_MESSAGE)
  }

  private storedFingerprint(item: WorkItem): string | null {
    const row = this.deps.indexDb
      .prepare('SELECT fingerprint FROM indexed_messages WHERE generation_id = ? AND account_id = ? AND message_id = ?')
      .get(item.generationId, item.accountId, item.messageId) as { fingerprint: string } | undefined
    return row?.fingerprint ?? null
  }

  private storeFingerprint(item: WorkItem, fingerprint: string): void {
    this.deps.indexDb
      .prepare(
        `INSERT INTO indexed_messages (generation_id, account_id, message_id, fingerprint, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(generation_id, account_id, message_id)
         DO UPDATE SET fingerprint = excluded.fingerprint, indexed_at = excluded.indexed_at`,
      )
      .run(item.generationId, item.accountId, item.messageId, fingerprint, this.now())
  }

  private finish(item: WorkItem): void {
    if (item.eventId !== null) this.markProcessed(item.eventId)
    this.deps.indexDb
      .prepare('DELETE FROM index_jobs WHERE event_key = ? AND generation_id = ?')
      .run(item.eventKey, item.generationId)
    this.activateIfComplete(item.generationId)
  }

  /**
   * A revoked Gmail sign-in is not this message's fault and retrying cannot fix
   * it, so park the job without spending attempts and keep indexing other
   * accounts. It resumes once the account is signed in again.
   */
  private waitForSignIn(item: WorkItem, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const now = this.now()
    this.deps.indexDb
      .prepare(
        `INSERT INTO index_jobs
           (event_key, account_id, message_id, generation_id, status, attempts, last_error, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'waiting_auth', ?, ?, ?, ?, ?)
         ON CONFLICT(event_key, generation_id) DO UPDATE SET
           status = excluded.status, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(item.eventKey, item.accountId, item.messageId, item.generationId, item.attempts, message, now, now, now)
    if (item.eventId !== null) this.markProcessed(item.eventId)
    markNeedsReauth(this.deps.mailDb, item.accountId)
  }

  private resumeSignedInAccounts(): void {
    const signedIn = (
      this.deps.mailDb.prepare('SELECT id FROM accounts WHERE needs_reauth = 0').all() as Array<{ id: number }>
    ).map((row) => row.id)
    if (signedIn.length === 0) return
    const now = this.now()
    this.deps.indexDb
      .prepare(
        `UPDATE index_jobs SET status = 'pending', available_at = ?, updated_at = ?
         WHERE status = 'waiting_auth' AND account_id IN (${signedIn.map(() => '?').join(',')})`,
      )
      .run(now, now, ...signedIn)
  }

  private recordFailure(item: WorkItem, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const now = this.now()
    const attempts = item.attempts + 1
    const retryMs = Math.min(2 ** attempts * 60_000, JOB_RETRY_CAP_MS)
    const status = attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending'
    this.deps.indexDb
      .prepare(
        `INSERT INTO index_jobs
           (event_key, account_id, message_id, generation_id, status, attempts, last_error, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key, generation_id) DO UPDATE SET
           status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error,
           available_at = excluded.available_at, updated_at = excluded.updated_at`,
      )
      .run(item.eventKey, item.accountId, item.messageId, item.generationId, status, attempts, message, now + retryMs, now, now)
    if (item.eventId !== null) this.markProcessed(item.eventId)
    this.setState('last_error', message)
  }

  private generationStatus(generationId: number): string | undefined {
    return (
      this.deps.indexDb.prepare('SELECT status FROM index_generations WHERE id = ?').get(generationId) as
        | { status: string }
        | undefined
    )?.status
  }

  private cleanupRetired(): void {
    const retired = this.deps.indexDb
      .prepare("SELECT id FROM index_generations WHERE status = 'retired'")
      .all() as Array<{ id: number }>
    if (retired.length === 0) return
    const marks = retired.map(() => '?').join(',')
    const ids = retired.map((row) => row.id)
    const rows = this.deps.indexDb
      .prepare(`SELECT rowid FROM chunks WHERE generation_id IN (${marks}) LIMIT ?`)
      .all(...ids, CLEANUP_ROWS_PER_RUN) as { rowid: number }[]
    if (rows.length > 0) {
      this.deps.vectorIndex.delete(rows.map((row) => row.rowid))
      const rowMarks = rows.map(() => '?').join(',')
      this.deps.indexDb.prepare(`DELETE FROM chunks WHERE rowid IN (${rowMarks})`).run(...rows.map((row) => row.rowid))
    }
    if (rows.length < CLEANUP_ROWS_PER_RUN) {
      this.deps.indexDb.prepare(`DELETE FROM index_jobs WHERE generation_id IN (${marks})`).run(...ids)
      this.deps.indexDb.prepare(`DELETE FROM indexed_messages WHERE generation_id IN (${marks})`).run(...ids)
    }
  }

  private ensureGeneration(model: string, dimensions: number): number {
    const active = this.deps.indexDb
      .prepare("SELECT id, model, dimensions FROM index_generations WHERE status = 'active' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; model: string; dimensions: number } | undefined
    if (active?.model === model && active.dimensions === dimensions) return active.id
    const building = this.deps.indexDb
      .prepare("SELECT id FROM index_generations WHERE status = 'building' AND model = ? AND dimensions = ? ORDER BY id DESC LIMIT 1")
      .get(model, dimensions) as { id: number } | undefined
    if (building) return building.id
    const now = Date.now()
    const status = active ? 'building' : 'active'
    const info = this.deps.indexDb
      .prepare(
        'INSERT INTO index_generations (model, dimensions, status, created_at, activated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(model, dimensions, status, now, active ? null : now)
    const generationId = Number(info.lastInsertRowid)
    this.seedGeneration(generationId, Boolean(active))
    this.deps.indexDb
      .prepare('UPDATE index_generations SET seed_until_event_id = ? WHERE id = ?')
      .run(this.latestEventId(), generationId)
    return generationId
  }

  private seedGeneration(generationId: number, includeAll: boolean): void {
    const messages = this.deps.mailDb
      .prepare(
        includeAll
          ? 'SELECT account_id, id, internal_date FROM messages'
          : `SELECT m.account_id, m.id, m.internal_date FROM messages m
             WHERE NOT EXISTS (
               SELECT 1 FROM mail_events e
               WHERE e.account_id = m.account_id AND e.message_id = m.id AND e.kind = 'message_upserted'
             )`,
      )
      .all() as Array<{
      account_id: number
      id: string
      internal_date: number
    }>
    const insert = this.deps.mailDb.prepare(
      `INSERT INTO mail_events
       (event_key, account_id, message_id, kind, origin, payload_json, created_at)
       VALUES (?, ?, ?, 'message_upserted', 'reconciliation', ?, ?)
       ON CONFLICT(event_key) DO NOTHING`,
    )
    this.deps.mailDb.transaction(() => {
      for (const message of messages) {
        insert.run(
          `reindex:${generationId}:${message.account_id}:${message.id}:${message.internal_date}`,
          message.account_id,
          message.id,
          JSON.stringify({ generationId }),
          Date.now(),
        )
      }
    })()
  }

  private latestEventId(): number {
    return (this.deps.mailDb.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mail_events').get() as { id: number }).id
  }

  private activateIfComplete(generationId: number): void {
    const generation = this.deps.indexDb
      .prepare('SELECT status, seed_until_event_id FROM index_generations WHERE id = ?')
      .get(generationId) as { status: string; seed_until_event_id: number | null } | undefined
    if (generation?.status !== 'building') return
    if (readCursor(this.deps.mailDb, INDEXER_CONSUMER) < (generation.seed_until_event_id ?? 0)) return
    const retrying = this.deps.indexDb
      .prepare("SELECT COUNT(*) AS count FROM index_jobs WHERE generation_id = ? AND status = 'pending'")
      .get(generationId) as { count: number }
    if (retrying.count > 0) return
    this.deps.indexDb.transaction(() => {
      this.deps.indexDb.prepare("UPDATE index_generations SET status = 'retired' WHERE status = 'active'").run()
      this.deps.indexDb
        .prepare("UPDATE index_generations SET status = 'active', activated_at = ? WHERE id = ?")
        .run(Date.now(), generationId)
    })()
  }

  private replaceMessage(
    accountId: number,
    messageId: string,
    generationId: number,
    chunks: KnowledgeChunk[],
    vectors: number[][],
  ): void {
    const old = this.deps.indexDb
      .prepare('SELECT rowid FROM chunks WHERE account_id = ? AND message_id = ? AND generation_id = ?')
      .all(accountId, messageId, generationId) as { rowid: number }[]
    this.deps.vectorIndex.delete(old.map((row) => row.rowid))
    const insert = this.deps.indexDb.prepare(
      `INSERT INTO chunks
         (id, generation_id, account_id, thread_id, message_id, attachment_part_id, source_type,
          source_location, content, content_hash, internal_date, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const records: Array<{ rowId: number; embedding: number[] }> = []
    this.deps.indexDb.transaction(() => {
      this.deps.indexDb
        .prepare('DELETE FROM chunks WHERE account_id = ? AND message_id = ? AND generation_id = ?')
        .run(accountId, messageId, generationId)
      chunks.forEach((chunk, index) => {
        const result = insert.run(
          `${generationId}:${chunk.id}`,
          generationId,
          chunk.accountId,
          chunk.threadId,
          chunk.messageId,
          chunk.attachmentPartId ?? null,
          chunk.sourceType,
          chunk.sourceLocation,
          chunk.content,
          chunk.contentHash,
          chunk.internalDate,
          JSON.stringify(chunk.metadata),
        )
        records.push({ rowId: Number(result.lastInsertRowid), embedding: vectors[index]! })
      })
    })()
    this.deps.vectorIndex.upsert(
      records.map((record) => ({ ...record, accountId, generationId })),
    )
  }

  private deleteMessage(accountId: number, messageId: string): void {
    const rows = this.deps.indexDb
      .prepare(
        `SELECT rowid FROM chunks WHERE account_id = ? AND message_id = ?
         AND generation_id IN (SELECT id FROM index_generations WHERE status != 'retired')`,
      )
      .all(accountId, messageId) as { rowid: number }[]
    this.deps.vectorIndex.delete(rows.map((row) => row.rowid))
    this.deps.indexDb.transaction(() => {
      this.deps.indexDb
        .prepare(
          `DELETE FROM chunks WHERE account_id = ? AND message_id = ?
           AND generation_id IN (SELECT id FROM index_generations WHERE status != 'retired')`,
        )
        .run(accountId, messageId)
      this.deps.indexDb.prepare('DELETE FROM indexed_messages WHERE account_id = ? AND message_id = ?').run(accountId, messageId)
    })()
  }

  private markProcessed(eventId: number): void {
    this.completedEventIds.add(eventId)
    let last: number | null = null
    while (this.batchEventIds.length > 0 && this.completedEventIds.has(this.batchEventIds[0]!)) {
      last = this.batchEventIds.shift()!
      this.completedEventIds.delete(last)
    }
    if (last !== null) advanceCursor(this.deps.mailDb, INDEXER_CONSUMER, last, this.now())
  }

  private getState(key: string): string {
    const row = this.deps.indexDb.prepare('SELECT value FROM index_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? ''
  }

  private setState(key: string, value: string): void {
    this.deps.indexDb
      .prepare(
        `INSERT INTO index_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now())
  }
}
