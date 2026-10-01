import type { AccountRow, MailStore } from '@gmail/core'
import type { GmailApi } from '@gmail/gmail'
import { drainOutbox, runBackfill, runIncrementalSync } from '@gmail/sync'

export type SyncCoordinatorDeps = {
  listAccounts(): AccountRow[]
  gmailFor(accountId: number): GmailApi
  store: MailStore
  onError(accountId: number, error: unknown): void
  onSuccess?(accountId: number): void
  intervalMs?: number
  backfillThrottleMs?: number
}

export class SyncCoordinator {
  private readonly inFlight = new Map<number, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: SyncCoordinatorDeps) {}

  start(): void {
    if (this.timer) return
    void this.runAll()
    this.timer = setInterval(() => void this.runAll(), this.deps.intervalMs ?? 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runAll(): Promise<void> {
    await Promise.all(
      this.deps
        .listAccounts()
        .filter((account) => !account.needsReauth)
        .map((account) => this.runAccount(account.id).catch(() => undefined)),
    )
  }

  runAccount(accountId: number): Promise<void> {
    const running = this.inFlight.get(accountId)
    if (running) return running

    const promise = this.performSync(accountId)
      .then(() => this.deps.onSuccess?.(accountId))
      .catch((error: unknown) => {
        this.deps.onError(accountId, error)
        throw error
      })
      .finally(() => this.inFlight.delete(accountId))

    this.inFlight.set(accountId, promise)
    return promise
  }

  private async performSync(accountId: number): Promise<void> {
    const gmail = this.deps.gmailFor(accountId)
    const cursor = this.deps.store.getSyncCursor(accountId)
    if (!cursor.backfillComplete) {
      await runBackfill(this.deps.store, accountId, gmail, {
        throttleMs: this.deps.backfillThrottleMs,
      })
    }
    await drainOutbox(this.deps.store, accountId, gmail)
    await runIncrementalSync(this.deps.store, accountId, gmail)
  }
}
