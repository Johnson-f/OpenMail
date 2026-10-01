import type {
  BackgroundInit,
  BackgroundMethod,
  BackgroundRequests,
  BackgroundToMain,
  MainToBackground,
  ProviderKeyName,
} from '../background/protocol'

export type BackgroundChild = {
  postMessage(message: MainToBackground): void
  kill(): boolean
  on(event: 'message', listener: (message: BackgroundToMain) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

export type BackgroundHostOptions = {
  fork(): BackgroundChild
  buildInit(): BackgroundInit
  log?(level: 'info' | 'warn' | 'error', message: string): void
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  stableUptimeMs?: number
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | undefined
}

const UNBOUNDED_METHODS = new Set<BackgroundMethod>(['syncAccount', 'rebuildWritingProfiles'])

export class BackgroundHost {
  private child: BackgroundChild | null = null
  private startedAt = 0
  private nextId = 1
  private backoffMs: number
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly options: BackgroundHostOptions) {
    this.backoffMs = options.initialBackoffMs ?? 1_000
  }

  start(): void {
    this.stopped = false
    this.spawn()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, this.options.stopTimeoutMs ?? 3_000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.postMessage({ type: 'shutdown' })
    })
  }

  syncAccount(accountId: number): Promise<void> {
    return this.request('syncAccount', [accountId])
  }

  indexingStatus(): Promise<BackgroundRequests['indexingStatus']['result']> {
    return this.request('indexingStatus', [])
  }

  retryFailedIndexing(): Promise<number> {
    return this.request('retryFailedIndexing', [])
  }

  runAutomationNow(versionId: string): Promise<string> {
    return this.request('runAutomationNow', [versionId])
  }

  wakeIndexer(): Promise<void> {
    return this.request('wakeIndexer', [])
  }

  rebuildWritingProfiles(accountId: number): Promise<BackgroundRequests['rebuildWritingProfiles']['result']> {
    return this.request('rebuildWritingProfiles', [accountId])
  }

  setRefreshToken(accountId: number, refreshToken: string): void {
    this.child?.postMessage({ type: 'set-refresh-token', accountId, refreshToken })
  }

  setProviderKey(provider: ProviderKeyName, key: string | null): void {
    this.child?.postMessage({ type: 'set-provider-key', provider, key })
  }

  private request<M extends BackgroundMethod>(
    method: M,
    args: BackgroundRequests[M]['args'],
  ): Promise<BackgroundRequests[M]['result']> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Background process is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // A first sync downloads the whole mailbox and a profile rebuild reads
      // all sent mail; both legitimately outlast any fixed deadline. They still
      // settle if the child exits, because exit rejects everything pending.
      const timer = UNBOUNDED_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`Background request ${method} timed out`))
          }, this.options.requestTimeoutMs ?? 30_000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.postMessage({ type: 'request', id, method, args } as MainToBackground)
    })
  }

  private spawn(): void {
    let init: BackgroundInit
    try {
      init = this.options.buildInit()
    } catch (err) {
      this.options.log?.('error', `Could not prepare background init: ${err instanceof Error ? err.message : String(err)}`)
      this.scheduleRestart()
      return
    }
    const child = this.options.fork()
    this.child = child
    this.startedAt = Date.now()
    child.on('message', (message) => this.onMessage(message))
    child.on('exit', (code) => this.onExit(child, code))
    child.postMessage({ type: 'init', ...init })
  }

  private onMessage(message: BackgroundToMain): void {
    if (message.type === 'log') {
      this.options.log?.(message.level, message.message)
      return
    }
    if (message.type !== 'response') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if ('error' in message) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  }

  private onExit(child: BackgroundChild, code: number): void {
    if (this.child !== child) return
    this.child = null
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Background process exited'))
      this.pending.delete(id)
    }
    if (this.stopped) return
    this.options.log?.('warn', `Background process exited with code ${code}`)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.startedAt > 0 && Date.now() - this.startedAt >= (this.options.stableUptimeMs ?? 60_000)) {
      this.backoffMs = this.options.initialBackoffMs ?? 1_000
    }
    this.startedAt = 0
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 60_000)
    this.options.log?.('info', `Restarting background process in ${delay}ms`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.spawn()
    }, delay)
  }
}
