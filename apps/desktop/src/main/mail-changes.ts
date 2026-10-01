import type { Db } from './db/index'

const CHANGE_TOKEN_SQL = `SELECT
  (SELECT COALESCE(MAX(id), 0) FROM mail_events) AS e,
  (SELECT COALESCE(MAX(id), 0) FROM outbox) AS o,
  (SELECT COALESCE(SUM(backfill_complete + needs_reauth), 0) FROM accounts) AS a,
  (SELECT COALESCE(MAX(updated_at), 0) FROM sync_errors) AS s`

export class MailChangeNotifier {
  private lastToken: string | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private notifyTimer: NodeJS.Timeout | null = null
  private readonly statement

  constructor(
    db: Db,
    private readonly notify: () => void,
    private readonly pollMs = 1000,
    private readonly debounceMs = 250,
  ) {
    this.statement = db.prepare(CHANGE_TOKEN_SQL)
  }

  start(): void {
    if (this.pollTimer) return
    this.lastToken = this.token()
    this.pollTimer = setInterval(() => this.check(), this.pollMs)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.pollTimer = null
    this.notifyTimer = null
  }

  check(): void {
    const token = this.token()
    if (token === this.lastToken) return
    this.lastToken = token
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify()
    }, this.debounceMs)
  }

  private token(): string {
    return JSON.stringify(this.statement.get())
  }
}
