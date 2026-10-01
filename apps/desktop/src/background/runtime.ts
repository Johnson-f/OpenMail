import { join } from 'node:path'
import { GoogleGmail, type GmailApi } from '@gmail/gmail'
import {
  ActionApprovalGraph,
  AutomationRunGraph,
  PolicyEngine,
} from '@gmail/agent'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { markCleanShutdown, openAgentDatabase, openDatabase, openIndexDatabase, type Db } from '../main/db/index'
import { SqliteMailStore } from '../main/db/store'
import { isRevokedTokenError, listAccounts, markNeedsReauth } from '../main/auth/tokens'
import { SyncCoordinator } from '../main/sync/coordinator'
import { GmailClientCache } from '../main/sync/gmail-clients'
import { MemorySecretSource } from '../main/ai/secrets'
import { ProviderRegistry } from '../main/ai/providers/registry'
import { SqliteVecIndex } from '../main/ai/sqlite-vec-index'
import { IndexingWorker } from '../main/ai/indexing-worker'
import { ActionService } from '../main/ai/action-service'
import { MailActionService } from '../main/ai/mail-action-service'
import { AutomationScheduler } from '../main/automation/scheduler'
import { WritingProfileService } from '../main/ai/writing-profile-service'
import type { BackgroundInit, BackgroundToMain, MainToBackground, RequestMessage } from './protocol'

export type BackgroundRuntimeOptions = {
  send(message: BackgroundToMain): void
  onShutdown?(): void
  gmailFactory?(accountId: number, refreshToken: string, init: BackgroundInit): GmailApi
  syncIntervalMs?: number
  backfillThrottleMs?: number
}

export type BackgroundRuntime = {
  start(): void
  stop(): void
  handle(message: MainToBackground): void
}

type Services = {
  dbs: Db[]
  userDataDir: string
  coordinator: SyncCoordinator
  indexingWorker: IndexingWorker
  scheduler: AutomationScheduler
  writingProfiles: WritingProfileService
  registry: ProviderRegistry
  secrets: MemorySecretSource
  refreshTokens: Map<number, string>
  gmailClients: GmailClientCache
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createBackgroundRuntime(options: BackgroundRuntimeOptions): BackgroundRuntime {
  let services: Services | null = null
  let started = false

  function build(init: BackgroundInit): Services {
    const db = openDatabase(join(init.userDataDir, 'mail.db'))
    const indexDb = openIndexDatabase(join(init.userDataDir, 'index.db'))
    const agentDb = openAgentDatabase(join(init.userDataDir, 'agent.db'))
    const refreshTokens = new Map<number, string>(
      Object.entries(init.refreshTokens).map(([id, token]) => [Number(id), token]),
    )
    const secrets = new MemorySecretSource()
    for (const [provider, key] of Object.entries(init.providerKeys)) {
      if (key) secrets.set(provider as 'voyage' | 'perplexity', key)
    }
    const registry = new ProviderRegistry(secrets)
    const gmailClients = new GmailClientCache((accountId) => {
      const token = refreshTokens.get(accountId)
      if (!token) throw new Error(`No refresh token available for account ${accountId}`)
      return options.gmailFactory
        ? options.gmailFactory(accountId, token, init)
        : GoogleGmail.forRefreshToken(init.googleClientId, init.googleClientSecret, token)
    })
    const gmailFor = (accountId: number): GmailApi => gmailClients.get(accountId)

    const store = new SqliteMailStore(db)
    const indexingWorker = new IndexingWorker({
      mailDb: db,
      indexDb,
      mailStore: store,
      gmailFor,
      embedding: () => registry.embedding(),
      vectorIndex: new SqliteVecIndex(indexDb),
    })
    const checkpointer = new SqliteSaver(agentDb as never)
    const actionService = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(checkpointer))
    const mailActionService = new MailActionService(db, store, gmailFor, actionService)
    const scheduler = new AutomationScheduler(
      db,
      agentDb,
      store,
      actionService,
      mailActionService,
      (execute) => new AutomationRunGraph(execute, checkpointer),
    )
    const coordinator = new SyncCoordinator({
      listAccounts: () => listAccounts(db),
      gmailFor,
      store,
      intervalMs: options.syncIntervalMs,
      backfillThrottleMs: options.backfillThrottleMs,
      onSuccess: (accountId) => {
        db.prepare('DELETE FROM sync_errors WHERE account_id = ?').run(accountId)
        indexingWorker.wake()
        mailActionService
          .reconcilePending(accountId)
          .catch((err) => log('error', `Send reconciliation failed for account ${accountId}: ${errorMessage(err)}`))
      },
      onError: (accountId, err) => {
        if (isRevokedTokenError(err)) markNeedsReauth(db, accountId)
        db.prepare(
          `INSERT INTO sync_errors (account_id, message, error_kind, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             message = excluded.message,
             error_kind = excluded.error_kind,
             updated_at = excluded.updated_at`,
        ).run(accountId, errorMessage(err), isRevokedTokenError(err) ? 'reauth' : 'transient', Date.now())
        log('error', `Sync failed for account ${accountId}: ${errorMessage(err)}`)
      },
    })
    return {
      dbs: [indexDb, agentDb, db],
      userDataDir: init.userDataDir,
      coordinator,
      indexingWorker,
      scheduler,
      writingProfiles: new WritingProfileService(db, agentDb),
      registry,
      secrets,
      refreshTokens,
      gmailClients,
    }
  }

  function log(level: 'info' | 'warn' | 'error', message: string): void {
    options.send({ type: 'log', level, message })
  }

  function startServices(current: Services): void {
    current.coordinator.start()
    current.indexingWorker.start()
    current.scheduler.start()
  }

  function stopServices(current: Services): void {
    current.coordinator.stop()
    current.indexingWorker.stop()
    current.scheduler.stop()
  }

  function dispatch(current: Services, message: RequestMessage): Promise<unknown> | unknown {
    switch (message.method) {
      case 'syncAccount':
        return current.coordinator.runAccount(message.args[0])
      case 'indexingStatus':
        return current.indexingWorker.status()
      case 'retryFailedIndexing':
        return current.indexingWorker.retryFailed()
      case 'runAutomationNow':
        return current.scheduler.runManual(message.args[0])
      case 'wakeIndexer':
        current.indexingWorker.wake()
        return undefined
      case 'rebuildWritingProfiles':
        return current.writingProfiles.rebuild(message.args[0])
      default:
        throw new Error(`Unknown background method: ${(message as { method: string }).method}`)
    }
  }

  async function handleRequest(message: RequestMessage): Promise<void> {
    try {
      if (!services) throw new Error('Background runtime is not initialized')
      const result = await dispatch(services, message)
      options.send({ type: 'response', id: message.id, result })
    } catch (err) {
      options.send({ type: 'response', id: message.id, error: errorMessage(err) })
    }
  }

  function close(): void {
    if (!services) return
    stopServices(services)
    const closing = services
    services = null
    for (const db of closing.dbs) db.close()
    for (const file of ['mail.db', 'index.db', 'agent.db']) markCleanShutdown(join(closing.userDataDir, file))
  }

  return {
    start() {
      started = true
      if (services) startServices(services)
    },
    stop: close,
    handle(message) {
      switch (message.type) {
        case 'init':
          close()
          services = build(message)
          if (started) startServices(services)
          options.send({ type: 'ready' })
          return
        case 'set-refresh-token':
          services?.refreshTokens.set(message.accountId, message.refreshToken)
          services?.gmailClients.invalidate(message.accountId)
          return
        case 'set-provider-key':
          if (!services) return
          if (message.key) services.secrets.set(message.provider, message.key)
          else services.registry.remove(message.provider)
          if (message.provider === 'voyage') services.indexingWorker.wake()
          return
        case 'shutdown':
          close()
          options.send({ type: 'log', level: 'info', message: 'shutdown complete' })
          options.onShutdown?.()
          return
        case 'request':
          void handleRequest(message)
          return
      }
    },
  }
}
