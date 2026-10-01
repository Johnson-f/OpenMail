import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const MESSAGES = 100_000
const THREADS = 20_000

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, entries: [] } })
const { openDatabase } = await server.ssrLoadModule('/apps/desktop/src/main/db/index.ts')
const { listThreads } = await server.ssrLoadModule('/apps/desktop/src/main/db/messages.ts')

const dir = mkdtempSync(join(tmpdir(), 'bench-threads-'))
const db = openDatabase(join(dir, 'mail.db'))

db.transaction(() => {
  const thread = db.prepare('INSERT INTO threads (account_id, id, subject, last_message_at) VALUES (1, ?, ?, ?)')
  const message = db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, from_addr, subject, snippet, internal_date, message_id_header)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const label = db.prepare('INSERT INTO message_labels (account_id, message_id, label_id) VALUES (1, ?, ?)')
  const lastDate = new Array<number>(THREADS).fill(0)
  for (let i = 0; i < MESSAGES; i++) {
    const t = i % THREADS
    const date = 1_700_000_000_000 + i * 1000
    lastDate[t] = date
    message.run(`m${i}`, `t${t}`, 'Sender <s@example.com>', `Subject ${t}`, 'snippet', date, `m${i}@example.com`)
    label.run(`m${i}`, 'INBOX')
    if (i % 3 === 0) label.run(`m${i}`, 'UNREAD')
  }
  for (let t = 0; t < THREADS; t++) thread.run(`t${t}`, `Subject ${t}`, lastDate[t])
})()

listThreads(db, 1, 'INBOX', 200)
const runs: number[] = []
for (let i = 0; i < 10; i++) {
  const start = performance.now()
  const rows = listThreads(db, 1, 'INBOX', 200)
  runs.push(performance.now() - start)
  if (rows.length !== 200) throw new Error(`expected 200 rows, got ${rows.length}`)
}
runs.sort((a, b) => a - b)
console.log(`listThreads(INBOX, 200) over ${MESSAGES} messages / ${THREADS} threads`)
console.log(`min ${runs[0]!.toFixed(1)} ms, median ${runs[5]!.toFixed(1)} ms, max ${runs[9]!.toFixed(1)} ms`)

db.close()
rmSync(dir, { recursive: true, force: true })
await server.close()
