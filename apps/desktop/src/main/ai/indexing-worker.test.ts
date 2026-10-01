import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@gmail/core'
import type { EmbeddingProvider } from '@gmail/intelligence'
import { FakeVectorIndex, ProviderError } from '@gmail/intelligence'
import { FakeGmail, MessageNotFoundError } from '@gmail/gmail'
import { openDatabase, openIndexDatabase } from '../db/index'
import { advanceCursor, readCursor } from '../db/event-cursors'
import { SqliteMailStore } from '../db/store'
import { IndexingWorker, MAX_CHUNKS_PER_MESSAGE } from './indexing-worker'
import { VoyageProvider } from './providers/voyage'

class FakeEmbedding implements EmbeddingProvider {
  readonly model = 'fake-embedding'
  readonly dimensions = 3
  embedDocuments(chunks: string[]): Promise<number[][]> {
    return Promise.resolve(chunks.map((chunk) => [chunk.length, 1, 0]))
  }
  embedQuery(): Promise<number[]> {
    return Promise.resolve([1, 0, 0])
  }
}

describe('IndexingWorker', () => {
  it('indexes each durable event once and deletes derived data', async () => {
    const mailDb = openDatabase(':memory:')
    const indexDb = openIndexDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', subject: 'Renewal', bodyText: 'Renew for $18,000.' })
    store.upsertMessage(1, await gmail.getMessage('m1'), {
      eventKey: 'event:1',
      origin: 'incremental',
    })
    const worker = new IndexingWorker({
      mailDb,
      indexDb,
      mailStore: store,
      gmailFor: () => gmail,
      embedding: () => new FakeEmbedding(),
      vectorIndex: new FakeVectorIndex(3),
    })

    await expect(worker.runOnce()).resolves.toBe(1)
    await expect(worker.runOnce()).resolves.toBe(0)
    expect(worker.status()).toMatchObject({ pendingEvents: 0, indexedChunks: 1, lastError: null })

    store.deleteMessage(1, 'm1', { eventKey: 'event:2', origin: 'incremental' })
    await worker.runOnce()
    expect(worker.status().indexedChunks).toBe(0)
    mailDb.close()
    indexDb.close()
  })

  it('leaves an event pending when embedding is unavailable', async () => {
    const mailDb = openDatabase(':memory:')
    const indexDb = openIndexDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1' })
    store.upsertMessage(1, await gmail.getMessage('m1'), { eventKey: 'event:1', origin: 'backfill' })
    const worker = new IndexingWorker({
      mailDb,
      indexDb,
      mailStore: store,
      gmailFor: () => gmail,
      embedding: () => {
        throw new Error('Voyage is not configured')
      },
      vectorIndex: new FakeVectorIndex(3),
    })

    await expect(worker.runOnce()).resolves.toBe(0)
    expect(worker.status()).toMatchObject({ pendingEvents: 1, indexedChunks: 0, needsKey: true, lastError: null })
    mailDb.close()
    indexDb.close()
  })

  it('reindexes every message before activating a changed model generation', async () => {
    const mailDb = openDatabase(':memory:')
    const indexDb = openIndexDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', bodyText: 'one' })
    gmail.seedMessage({ id: 'm2', bodyText: 'two' })
    store.upsertMessage(1, await gmail.getMessage('m1'), { eventKey: 'event:1', origin: 'backfill' })
    store.upsertMessage(1, await gmail.getMessage('m2'), { eventKey: 'event:2', origin: 'backfill' })
    let model = 'model-1'
    const provider = (): EmbeddingProvider => ({
      ...new FakeEmbedding(),
      model,
      dimensions: 3,
      embedDocuments: (chunks) => Promise.resolve(chunks.map(() => [1, 0, 0])),
      embedQuery: () => Promise.resolve([1, 0, 0]),
    })
    const worker = new IndexingWorker({
      mailDb, indexDb, mailStore: store, gmailFor: () => gmail,
      embedding: provider, vectorIndex: new FakeVectorIndex(3),
    })
    await worker.runOnce()
    model = 'model-2'
    store.upsertMessage(1, await gmail.getMessage('m1'), { eventKey: 'event:3', origin: 'incremental' })
    await worker.runOnce()
    await worker.runOnce()

    const generations = indexDb
      .prepare('SELECT model, status FROM index_generations ORDER BY id')
      .all()
    expect(generations).toEqual([
      { model: 'model-1', status: 'retired' },
      { model: 'model-2', status: 'active' },
    ])
    expect(
      (indexDb.prepare("SELECT COUNT(DISTINCT message_id) AS count FROM chunks WHERE generation_id = 2").get() as {
        count: number
      }).count,
    ).toBe(2)
    mailDb.close(); indexDb.close()
  })

  describe('failure isolation and efficiency', () => {
    type Harness = ReturnType<typeof harness>

    function message(id: string, over: Partial<StoredMessage> = {}): StoredMessage {
      return {
        id,
        threadId: id,
        from: 'a@example.com',
        to: ['b@example.com'],
        cc: [],
        subject: `Subject ${id}`,
        snippet: '',
        bodyText: `Body of ${id}`,
        bodyHtml: '',
        internalDate: 1_700_000_000_000,
        labelIds: ['INBOX', 'UNREAD'],
        messageIdHeader: `${id}@x`,
        inReplyTo: '',
        references: [],
        attachments: [],
        ...over,
      }
    }

    function harness(embedDocuments: (chunks: string[]) => Promise<number[][]>) {
      const mailDb = openDatabase(':memory:')
      const indexDb = openIndexDatabase(':memory:')
      const store = new SqliteMailStore(mailDb)
      const vectorIndex = new FakeVectorIndex(3)
      const clock = { now: 1_000_000 }
      const calls: string[][] = []
      const provider: EmbeddingProvider = {
        model: 'fake-embedding',
        dimensions: 3,
        embedDocuments: (chunks) => {
          calls.push(chunks)
          return embedDocuments(chunks)
        },
        embedQuery: () => Promise.resolve([1, 0, 0]),
      }
      const worker = new IndexingWorker({
        mailDb, indexDb, mailStore: store, gmailFor: () => new FakeGmail(),
        embedding: () => provider, vectorIndex, now: () => clock.now,
      })
      let seq = 0
      const put = (msg: StoredMessage) => store.upsertMessage(1, msg, { eventKey: `e:${++seq}`, origin: 'incremental' })
      return { mailDb, indexDb, store, vectorIndex, clock, calls, worker, put }
    }

    const ok = (chunks: string[]) => Promise.resolve(chunks.map(() => [1, 0, 0]))
    const close = (h: Harness) => { h.mailDb.close(); h.indexDb.close() }
    const jobs = (h: Harness) =>
      h.indexDb.prepare('SELECT message_id, status, attempts FROM index_jobs ORDER BY id').all()

    it('does not let a poison message block the next three', async () => {
      const h = harness((chunks) =>
        chunks.some((chunk) => chunk.includes('POISON'))
          ? Promise.reject(new ProviderError('bad request', 'provider'))
          : ok(chunks),
      )
      h.put(message('bad', { bodyText: 'POISON' }))
      for (const id of ['g1', 'g2', 'g3']) h.put(message(id))

      await h.worker.runOnce()

      expect(h.worker.status()).toMatchObject({ pendingEvents: 0, indexedChunks: 3 })
      expect(jobs(h)).toEqual([{ message_id: 'bad', status: 'pending', attempts: 1 }])
      close(h)
    })

    it('isolates an extraction crash to one message', async () => {
      const h = harness(ok)
      const bad = message('bad', {
        attachments: [{ partId: '2', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, attachmentId: 'missing', disposition: 'attachment' }],
      })
      h.put(bad)
      h.put(message('g1'))
      await h.worker.runOnce()
      expect(h.worker.status()).toMatchObject({ pendingEvents: 0, indexedChunks: 2, failedJobs: 0 })
      expect(jobs(h)).toEqual([])
      close(h)
    })

    it('consumes nothing on an authentication error and backs off', async () => {
      let fail = true
      const h = harness((chunks) => (fail ? Promise.reject(new ProviderError('401', 'authentication')) : ok(chunks)))
      h.put(message('m1'))
      h.put(message('m2'))

      await expect(h.worker.runOnce()).resolves.toBe(0)
      expect(h.worker.status()).toMatchObject({ pendingEvents: 2, lastError: '401', needsKey: false })
      expect(jobs(h)).toEqual([])

      fail = false
      await h.worker.runOnce()
      expect(h.calls).toHaveLength(1)
      h.clock.now += 5_001
      await h.worker.runOnce()
      expect(h.worker.status()).toMatchObject({ pendingEvents: 0, indexedChunks: 2, lastError: null })
      close(h)
    })

    it('retries a failed job after backoff and marks it failed after 5 attempts; retry-failed resets', async () => {
      let broken = true
      const h = harness((chunks) => (broken ? Promise.reject(new ProviderError('nope', 'provider')) : ok(chunks)))
      h.put(message('m1'))

      await h.worker.runOnce()
      expect(jobs(h)).toEqual([{ message_id: 'm1', status: 'pending', attempts: 1 }])
      const callsAfterFirst = h.calls.length

      await h.worker.runOnce()
      expect(h.calls).toHaveLength(callsAfterFirst)

      for (let attempt = 2; attempt <= 5; attempt += 1) {
        h.clock.now += 7 * 60 * 60_000
        await h.worker.runOnce()
        expect(jobs(h)).toEqual([{ message_id: 'm1', status: attempt === 5 ? 'failed' : 'pending', attempts: attempt }])
      }
      expect(h.worker.status().failedJobs).toBe(1)

      h.clock.now += 7 * 60 * 60_000
      const callsBefore = h.calls.length
      await h.worker.runOnce()
      expect(h.calls).toHaveLength(callsBefore)

      broken = false
      expect(h.worker.retryFailed()).toBe(1)
      await h.worker.runOnce()
      expect(h.worker.status()).toMatchObject({ failedJobs: 0, indexedChunks: 1 })
      expect(jobs(h)).toEqual([])
      close(h)
    })

    it('skips a message whose only change is labels, and re-embeds on a body edit', async () => {
      const h = harness(ok)
      h.put(message('m1'))
      await h.worker.runOnce()
      expect(h.calls).toHaveLength(1)

      h.put(message('m1', { labelIds: ['INBOX'] }))
      await expect(h.worker.runOnce()).resolves.toBe(1)
      expect(h.calls).toHaveLength(1)
      expect(h.worker.status().pendingEvents).toBe(0)

      h.put(message('m1', { bodyText: 'Edited body' }))
      await h.worker.runOnce()
      expect(h.calls).toHaveLength(2)
      expect(h.worker.status().indexedChunks).toBe(1)
      close(h)
    })

    it('packs 100 small messages into at most two embedding requests', async () => {
      const h = harness(ok)
      for (let i = 0; i < 100; i += 1) h.put(message(`m${i}`))
      await h.worker.runOnce()
      expect(h.calls.length).toBeLessThanOrEqual(2)
      expect(h.worker.status()).toMatchObject({ pendingEvents: 0, indexedChunks: 100 })
      close(h)
    })

    it('caps a huge message at 500 chunks and sends them in several Voyage requests', async () => {
      const mailDb = openDatabase(':memory:')
      const indexDb = openIndexDatabase(':memory:')
      const store = new SqliteMailStore(mailDb)
      let requests = 0
      const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
        requests += 1
        const input = (JSON.parse(String(init?.body)) as { input: string[] }).input
        return new Response(JSON.stringify({ data: input.map(() => ({ embedding: new Array(1024).fill(0.1) })) }), { status: 200 })
      }) as typeof fetch
      const voyage = new VoyageProvider('key', fetcher)
      const paragraphs = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} ${'word '.repeat(480)}`)
      store.upsertMessage(1, message('big', { bodyText: paragraphs.join('\n\n') }), { eventKey: 'e:1', origin: 'incremental' })
      const worker = new IndexingWorker({
        mailDb, indexDb, mailStore: store, gmailFor: () => new FakeGmail(),
        embedding: () => voyage, vectorIndex: new FakeVectorIndex(1024),
      })

      await worker.runOnce()

      expect(worker.status().indexedChunks).toBe(MAX_CHUNKS_PER_MESSAGE)
      expect(requests).toBeGreaterThan(3)
      mailDb.close(); indexDb.close()
    }, 30_000)

    it('skips OCR download for inline and tiny images', async () => {
      const h = harness(ok)
      const getAttachment = async () => { throw new Error('should not download') }
      const gmail = { getAttachment } as unknown as FakeGmail
      const worker = new IndexingWorker({
        mailDb: h.mailDb, indexDb: h.indexDb, mailStore: h.store, gmailFor: () => gmail,
        embedding: () => ({ model: 'fake-embedding', dimensions: 3, embedDocuments: ok, embedQuery: () => Promise.resolve([1, 0, 0]) }),
        vectorIndex: h.vectorIndex,
      })
      h.put(message('m1', {
        attachments: [
          { partId: '1', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 50_000, attachmentId: 'a', contentId: 'cid', disposition: 'inline' },
          { partId: '2', filename: 'dot.png', mimeType: 'image/png', sizeBytes: 100, attachmentId: 'b', disposition: 'attachment' },
        ],
      }))
      await worker.runOnce()
      expect(worker.status()).toMatchObject({ indexedChunks: 1, failedJobs: 0 })
      close(h)
    })

    const withGmail = (h: Harness, getAttachment: () => Promise<Uint8Array>) =>
      new IndexingWorker({
        mailDb: h.mailDb, indexDb: h.indexDb, mailStore: h.store,
        gmailFor: () => ({ getAttachment }) as unknown as FakeGmail,
        embedding: () => ({ model: 'fake-embedding', dimensions: 3, embedDocuments: ok, embedQuery: () => Promise.resolve([1, 0, 0]) }),
        vectorIndex: h.vectorIndex, now: () => h.clock.now,
      })
    const pdfMessage = (id: string) =>
      message(id, {
        attachments: [{ partId: '2', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, attachmentId: 'att', disposition: 'attachment' }],
      })
    const fingerprints = (h: Harness) => h.indexDb.prepare('SELECT COUNT(*) AS n FROM indexed_messages').get()

    it('queues a retry without a fingerprint when an attachment download fails transiently', async () => {
      const h = harness(ok)
      const worker = withGmail(h, () => Promise.reject(new Error('503 backend error')))
      h.put(pdfMessage('m1'))
      await worker.runOnce()
      expect(jobs(h)).toEqual([{ message_id: 'm1', status: 'pending', attempts: 1 }])
      expect(fingerprints(h)).toEqual({ n: 0 })
      expect(worker.status().indexedChunks).toBe(0)
      close(h)
    })

    it('parks a message whose account sign-in was revoked and resumes after sign-in, spending no attempts', async () => {
      const h = harness(ok)
      h.mailDb.prepare("INSERT INTO accounts (id, email, encrypted_refresh_token, created_at) VALUES (1, 'a@b.com', x'00', 0)").run()
      let revoked = true
      const worker = withGmail(h, () =>
        revoked
          ? Promise.reject(Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }))
          : Promise.resolve(new TextEncoder().encode('hello')),
      )
      h.put(pdfMessage('m1'))
      h.put(message('m2'))
      await worker.runOnce()

      expect(jobs(h)).toEqual([{ message_id: 'm1', status: 'waiting_auth', attempts: 0 }])
      expect(h.mailDb.prepare('SELECT needs_reauth AS r FROM accounts WHERE id = 1').get()).toEqual({ r: 1 })
      expect(worker.status()).toMatchObject({ waitingForSignIn: 1, failedJobs: 0, lastError: null })
      expect(worker.status().indexedChunks).toBeGreaterThan(0)

      h.clock.now += 24 * 3_600_000
      await worker.runOnce()
      expect(jobs(h)).toEqual([{ message_id: 'm1', status: 'waiting_auth', attempts: 0 }])

      revoked = false
      h.mailDb.prepare('UPDATE accounts SET needs_reauth = 0 WHERE id = 1').run()
      await worker.runOnce()
      expect(jobs(h)).toEqual([])
      expect(worker.status()).toMatchObject({ waitingForSignIn: 0, failedJobs: 0 })
      close(h)
    })

    it('skips only the attachment that no longer exists and fingerprints the message', async () => {
      const h = harness(ok)
      const worker = withGmail(h, () => Promise.reject(new MessageNotFoundError('m1')))
      h.put(pdfMessage('m1'))
      await worker.runOnce()
      expect(jobs(h)).toEqual([])
      expect(fingerprints(h)).toEqual({ n: 1 })
      expect(worker.status().indexedChunks).toBe(1)
      close(h)
    })

    it('advances the indexer cursor and reports pending as a range count', async () => {
      const h = harness(ok)
      h.put(message('a'))
      h.put(message('b'))
      expect(h.worker.status().pendingEvents).toBe(2)
      expect(readCursor(h.mailDb, 'indexer')).toBe(0)
      await h.worker.runOnce()
      expect(readCursor(h.mailDb, 'indexer')).toBe(2)
      expect(h.worker.status().pendingEvents).toBe(0)
      close(h)
    })

    describe('generation activation', () => {
      const model = { current: 'model-1' }
      const modelHarness = () => {
        const h = harness(ok)
        const worker = new IndexingWorker({
          mailDb: h.mailDb, indexDb: h.indexDb, mailStore: h.store, gmailFor: () => new FakeGmail(),
          embedding: () => ({ model: model.current, dimensions: 3, embedDocuments: ok, embedQuery: () => Promise.resolve([1, 0, 0]) }),
          vectorIndex: h.vectorIndex, now: () => h.clock.now,
        })
        return { ...h, worker }
      }
      const generation = (h: Harness, id: number) =>
        h.indexDb.prepare('SELECT status, seed_until_event_id AS seed FROM index_generations WHERE id = ?').get(id)

      it('stores the seed boundary and activates once the cursor reaches it and no jobs are pending', async () => {
        model.current = 'model-1'
        const h = modelHarness()
        h.put(message('a'))
        h.put(message('b'))
        await h.worker.runOnce()
        model.current = 'model-2'
        h.put(message('a', { bodyText: 'edited' }))
        await h.worker.runOnce()
        const seed = (generation(h, 2) as { seed: number }).seed
        expect(seed).toBeGreaterThanOrEqual(readCursor(h.mailDb, 'indexer'))
        expect(generation(h, 2)).toMatchObject({ status: 'active' })
        expect(generation(h, 1)).toMatchObject({ status: 'retired' })
        close(h)
      })

      it('stays building while the cursor is behind the boundary', async () => {
        model.current = 'model-1'
        const h = modelHarness()
        h.put(message('a'))
        await h.worker.runOnce()
        h.indexDb
          .prepare("INSERT INTO index_generations (model, dimensions, status, created_at, seed_until_event_id) VALUES ('model-3', 3, 'building', 0, 99)")
          .run()
        await h.worker.runOnce()
        expect(generation(h, 2)).toMatchObject({ status: 'building' })
        advanceCursor(h.mailDb, 'indexer', 99)
        await h.worker.runOnce()
        expect(generation(h, 2)).toMatchObject({ status: 'active' })
        close(h)
      })

      it('stays building while a job for the generation is pending', async () => {
        model.current = 'model-1'
        const h = modelHarness()
        h.put(message('a'))
        await h.worker.runOnce()
        h.indexDb
          .prepare("INSERT INTO index_generations (model, dimensions, status, created_at, seed_until_event_id) VALUES ('model-3', 3, 'building', 0, 0)")
          .run()
        h.indexDb
          .prepare("INSERT INTO index_jobs (event_key, account_id, message_id, generation_id, status, attempts, available_at, created_at, updated_at) VALUES ('k', 1, 'a', 2, 'pending', 1, ?, 0, 0)")
          .run(h.clock.now + 60_000)
        await h.worker.runOnce()
        expect(generation(h, 2)).toMatchObject({ status: 'building' })
        h.indexDb.prepare('DELETE FROM index_jobs').run()
        await h.worker.runOnce()
        expect(generation(h, 2)).toMatchObject({ status: 'active' })
        close(h)
      })

      it('activates a generation seeded with zero events', async () => {
        model.current = 'model-1'
        const h = modelHarness()
        h.put(message('a'))
        await h.worker.runOnce()
        h.store.deleteMessage(1, 'a', { eventKey: 'del:a', origin: 'incremental' })
        model.current = 'model-2'
        await h.worker.runOnce()
        expect(generation(h, 2)).toMatchObject({ status: 'active', seed: 2 })
        close(h)
      })
    })

    describe('event retention', () => {
      const DAY = 86_400_000
      const ageEvents = (h: Harness) => h.mailDb.prepare('UPDATE mail_events SET created_at = 0').run()
      const eventCount = (h: Harness) => (h.mailDb.prepare('SELECT COUNT(*) AS n FROM mail_events').get() as { n: number }).n

      it('never deletes events that both consumers have not passed', async () => {
        const h = harness(ok)
        h.clock.now = 30 * DAY
        h.put(message('a'))
        h.put(message('b'))
        h.put(message('c'))
        ageEvents(h)
        await h.worker.runOnce()
        expect(readCursor(h.mailDb, 'indexer')).toBe(3)
        expect(eventCount(h)).toBe(3)

        advanceCursor(h.mailDb, 'automation-dispatch', 2)
        h.clock.now += 2 * 60 * 60_000
        await h.worker.runOnce()
        expect(h.mailDb.prepare('SELECT id FROM mail_events').all()).toEqual([{ id: 3 }])
        close(h)
      })

      it('keeps recent events even when both consumers have passed them', async () => {
        const h = harness(ok)
        h.clock.now = 30 * DAY
        h.put(message('a'))
        h.mailDb.prepare('UPDATE mail_events SET created_at = ?').run(h.clock.now - DAY)
        await h.worker.runOnce()
        advanceCursor(h.mailDb, 'automation-dispatch', 1)
        h.clock.now += 2 * 60 * 60_000
        await h.worker.runOnce()
        expect(eventCount(h)).toBe(1)
        close(h)
      })
    })

    it('deletes chunks and fingerprints from every non-retired generation', async () => {
      const h = harness(ok)
      h.put(message('m1'))
      await h.worker.runOnce()
      h.store.deleteMessage(1, 'm1', { eventKey: 'del', origin: 'incremental' })
      await h.worker.runOnce()
      expect(h.worker.status().indexedChunks).toBe(0)
      expect(h.indexDb.prepare('SELECT COUNT(*) AS n FROM indexed_messages').get()).toEqual({ n: 0 })
      close(h)
    })

    it('removes chunks, vectors, jobs and fingerprints of retired generations', async () => {
      const mailDb = openDatabase(':memory:')
      const indexDb = openIndexDatabase(':memory:')
      const store = new SqliteMailStore(mailDb)
      const vectorIndex = new FakeVectorIndex(3)
      let model = 'model-1'
      const provider = (): EmbeddingProvider => ({
        model, dimensions: 3, embedDocuments: ok, embedQuery: () => Promise.resolve([1, 0, 0]),
      })
      const worker = new IndexingWorker({
        mailDb, indexDb, mailStore: store, gmailFor: () => new FakeGmail(), embedding: provider, vectorIndex,
      })
      store.upsertMessage(1, message('m1'), { eventKey: 'e:1', origin: 'backfill' })
      store.upsertMessage(1, message('m2'), { eventKey: 'e:2', origin: 'backfill' })
      await worker.runOnce()
      model = 'model-2'
      store.upsertMessage(1, message('m1', { bodyText: 'changed' }), { eventKey: 'e:3', origin: 'incremental' })
      await worker.runOnce()
      await worker.runOnce()

      const retired = indexDb.prepare("SELECT id FROM index_generations WHERE status = 'retired'").all() as Array<{ id: number }>
      expect(retired).toHaveLength(1)
      const id = retired[0]!.id
      expect(indexDb.prepare('SELECT COUNT(*) AS n FROM chunks WHERE generation_id = ?').get(id)).toEqual({ n: 0 })
      expect(indexDb.prepare('SELECT COUNT(*) AS n FROM indexed_messages WHERE generation_id = ?').get(id)).toEqual({ n: 0 })
      expect(vectorIndex.search([1, 0, 0], { accountIds: [1], generationId: id, limit: 50 })).toEqual([])
      expect(worker.status().indexedChunks).toBe(2)
      mailDb.close(); indexDb.close()
    })
  })
})
