import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { MessageWithLabels, SyncStatus } from '@gmail/core'
import type { GmailApi } from '@gmail/gmail'
import { drainOutbox, runBackfill, runIncrementalSync } from '@gmail/sync'
import type { Db } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { getMessage, mailboxCounts } from '../db/messages'
import { effectiveLabels } from '../db/outbox'
import { listAccounts, loadRefreshToken, type Encryptor } from '../auth/tokens'
import { signIn } from '../auth/signin'
import type { ProviderRegistry } from '../ai/providers/registry'
import type { AssistantService } from '../ai/assistant-service'
import type { IndexingStatus } from '../ai/indexing-worker'
import type { ProviderName } from '../ai/secrets'
import type { ActionService } from '../ai/action-service'
import type { MailActionService } from '../ai/mail-action-service'
import type { WritingProfileRecord, WritingProfileService } from '../ai/writing-profile-service'
import type { DraftingService } from '../ai/drafting-service'
import type { AutomationService } from '../ai/automation-service'
import { AutomationSpecSchema } from '@gmail/agent'
import { z } from 'zod'
import type { IpcChannel, SemanticThread } from './contract'
import type { AssistantToolService } from '../ai/assistant-tool-service'

const AccountIdSchema = z.number().int().positive()
const IdSchema = z.string().min(1).max(256)
const LabelListSchema = z.array(IdSchema).max(50)
const LimitSchema = z.number().int().positive().max(500)
const ProviderSchema = z.enum(['voyage', 'perplexity'])
const TimeZoneSchema = z.string().min(1).max(100).refine((zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}, 'Unknown time zone')
const ComposeMessageSchema = z.object({
  to: z.array(z.string().min(1)).max(200),
  cc: z.array(z.string().min(1)).max(200).optional(),
  bcc: z.array(z.string().min(1)).max(200).optional(),
  subject: z.string().max(998),
  bodyText: z.string().max(5_000_000),
  bodyHtml: z.string().max(5_000_000).optional(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).max(200).optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    dataBase64: z.string().max(35_000_000),
    contentId: z.string().optional(),
  })).max(50).optional(),
})

export type Deps = {
  db: Db
  encryptor: Encryptor
  gmailFor(accountId: number): GmailApi
  invalidateGmailClient?(accountId: number): void
  onRefreshTokenChanged?(accountId: number, refreshToken: string): void
  onProviderKeyChanged?(provider: ProviderName, key: string | null): void
  syncAccount?(accountId: number): Promise<void>
  providerRegistry?: ProviderRegistry
  assistantService?: AssistantService
  indexingWorker?: {
    status(): IndexingStatus | Promise<IndexingStatus>
    retryFailed(): number | Promise<number>
  }
  actionService?: ActionService
  mailActionService?: MailActionService
  writingProfileService?: WritingProfileService
  rebuildWritingProfiles?(accountId: number): Promise<WritingProfileRecord[]>
  draftingService?: DraftingService
  automationService?: AutomationService
  automationScheduler?: { runManual(versionId: string): string | Promise<string> }
  demoMode?: boolean
  semanticSearch?(accountIds: number[], query: string, limit: number): Promise<SemanticThread[]>
  assistantToolService?: AssistantToolService
}

export type IpcRegistrar = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
}

export function registerIpcHandlers(deps: Deps, ipc: IpcRegistrar = ipcMain): void {
  const { db } = deps
  const store = new SqliteMailStore(db)

  // Every channel parses its full argument list before any service runs: the
  // renderer is the security boundary and its arguments are untrusted.
  function handle<T extends z.ZodTuple>(
    channel: IpcChannel,
    schema: T,
    fn: (...args: z.infer<T>) => unknown,
  ): void {
    ipc.handle(channel, (_event, ...args) => fn(...(schema.parse(args) as z.infer<T>)))
  }

  function required<T>(service: T | undefined, message: string): T {
    if (!service) throw new Error(message)
    return service
  }

  handle('auth:signin', z.tuple([]), async () => {
    const accountId = await signIn(db, deps.encryptor)
    deps.invalidateGmailClient?.(accountId)
    deps.onRefreshTokenChanged?.(accountId, loadRefreshToken(db, deps.encryptor, accountId))
    // Kick off the first download immediately; the UI polls sync:status.
    const sync = deps.syncAccount
      ? deps.syncAccount(accountId)
      : runBackfill(store, accountId, deps.gmailFor(accountId)).then(() => undefined)
    void sync.catch((err: unknown) => {
      console.error(`Backfill failed for account ${accountId}:`, err)
    })
    return accountId
  })

  handle('accounts:list', z.tuple([]), () =>
    deps.demoMode
      ? [{ id: 1, email: 'demo@openmail.local', needsReauth: true }]
      : listAccounts(db),
  )

  handle('threads:list', z.tuple([AccountIdSchema, IdSchema, LimitSchema]), (accountId, labelId, limit) =>
    store.listThreads(accountId, labelId, limit),
  )

  handle('thread:messages', z.tuple([AccountIdSchema, IdSchema]), (accountId, threadId): MessageWithLabels[] => {
    const ids = db
      .prepare('SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY internal_date')
      .all(accountId, threadId)
      .map((r) => (r as { id: string }).id)

    return ids.flatMap((id) => {
      const m = getMessage(db, accountId, id)
      return m ? [{ ...m, effectiveLabelIds: effectiveLabels(db, accountId, id) }] : []
    })
  })

  handle('mailboxes:counts', z.tuple([AccountIdSchema, LabelListSchema]), (accountId, labelIds) =>
    mailboxCounts(db, accountId, labelIds),
  )

  handle('search:messages', z.tuple([AccountIdSchema, z.string().max(1_000), LimitSchema]), (accountId, query, limit) =>
    store.searchMessages(accountId, query, limit),
  )

  handle(
    'labels:modify',
    z.tuple([AccountIdSchema, IdSchema, LabelListSchema, LabelListSchema]),
    (accountId, messageId, add, remove) => {
      store.enqueueOutbox(accountId, messageId, add, remove)
      // Return the new effective state so the renderer re-renders instantly,
      // with no round trip to Gmail.
      return store.effectiveLabels(accountId, messageId)
    },
  )

  handle('sync:status', z.tuple([AccountIdSchema]), (accountId): SyncStatus => {
    const account = db
      .prepare('SELECT backfill_complete AS c, needs_reauth AS r, message_count AS n FROM accounts WHERE id = ?')
      .get(accountId) as { c: number; r: number; n: number } | undefined
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE account_id = ? AND status IN ('pending','failed')")
      .get(accountId) as { n: number }
    const syncError = db
      .prepare('SELECT message AS e FROM sync_errors WHERE account_id = ?')
      .get(accountId) as { e: string } | undefined
    const outboxError = db
      .prepare(
        "SELECT last_error AS e FROM outbox WHERE account_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      .get(accountId) as { e: string | null } | undefined

    return {
      accountId,
      backfillComplete: account?.c === 1,
      backfillFetched: account?.n ?? 0,
      pendingUploads: pending.n,
      needsReauth: account?.r === 1,
      lastError: syncError?.e ?? outboxError?.e ?? null,
    }
  })

  handle('sync:now', z.tuple([AccountIdSchema]), async (accountId) => {
    if (deps.syncAccount) return deps.syncAccount(accountId)
    const gmail = deps.gmailFor(accountId)
    // Upload first: a change sent now appears in the history page we are
    // about to read, instead of one sync cycle later.
    await drainOutbox(store, accountId, gmail)
    await runIncrementalSync(store, accountId, gmail)
  })

  handle('providers:list', z.tuple([]), () => deps.providerRegistry?.list() ?? [])

  handle('providers:set-key', z.tuple([ProviderSchema, z.string().min(1).max(1_000)]), async (provider, key) => {
    await required(deps.providerRegistry, 'AI providers are unavailable').setKey(provider, key)
    deps.onProviderKeyChanged?.(provider, key.trim())
  })

  handle('providers:remove-key', z.tuple([ProviderSchema]), (provider) => {
    required(deps.providerRegistry, 'AI providers are unavailable').remove(provider)
    deps.onProviderKeyChanged?.(provider, null)
  })

  handle(
    'assistant:ask',
    z.tuple([
      z.object({
        conversationId: z.string().max(256).optional(),
        question: z.string().min(1).max(20_000),
        accountIds: z.array(AccountIdSchema).min(1).max(50),
        threadIds: z.array(IdSchema).max(100).optional(),
      }),
    ]),
    (input) => required(deps.assistantService, 'Assistant is unavailable').ask(input),
  )

  handle('assistant:conversations', z.tuple([]), () => deps.assistantService?.listConversations() ?? [])
  handle('assistant:conversation-messages', z.tuple([IdSchema]), (conversationId) =>
    deps.assistantService?.conversationMessages(conversationId) ?? [],
  )
  handle('indexing:status', z.tuple([]), () =>
    deps.indexingWorker?.status() ?? {
      activeGeneration: null,
      pendingEvents: 0,
      indexedChunks: 0,
      lastError: 'Indexing is unavailable',
      failedJobs: 0,
      waitingForSignIn: 0,
      needsKey: false,
    },
  )
  handle('indexing:retry-failed', z.tuple([]), () => deps.indexingWorker?.retryFailed() ?? 0)
  handle(
    'search:semantic',
    z.tuple([z.array(AccountIdSchema).min(1).max(50), z.string().min(1).max(20_000), z.number().int().positive().max(200)]),
    (accountIds, query, limit) =>
      required(deps.semanticSearch, 'Semantic search is unavailable')(accountIds, query, limit),
  )
  handle('actions:pending', z.tuple([]), () => deps.actionService?.listPending() ?? [])
  handle('actions:review', z.tuple([IdSchema, z.string().min(1).max(256), z.boolean()]), async (intentId, contentHash, approved) => {
    const actionService = required(deps.actionService, 'Action review is unavailable')
    const reviewStatus = await actionService.review(intentId, contentHash, approved)
    const reviewedIntent = actionService.getIntent(intentId)
    const execution = reviewStatus !== 'approved'
      ? undefined
      : reviewedIntent?.kind === 'send' && deps.mailActionService
        ? await deps.mailActionService.executeApproved(intentId)
        : deps.assistantToolService?.executeApproved(intentId)
    return { reviewStatus, ...(execution ? { execution } : {}) }
  })
  handle('actions:not-sent', z.tuple([]), () => deps.mailActionService?.listNotSent() ?? [])
  handle('actions:resend', z.tuple([IdSchema]), (intentId) =>
    required(deps.mailActionService, 'Sending is unavailable').resend(intentId),
  )
  handle(
    'drafts:save',
    z.tuple([AccountIdSchema, z.string().uuid().optional(), ComposeMessageSchema]),
    (accountId, localDraftId, message) =>
      required(deps.mailActionService, 'Drafts are unavailable').saveDraft(accountId, localDraftId, message),
  )
  handle('drafts:delete', z.tuple([AccountIdSchema, z.string().uuid()]), (accountId, localDraftId) =>
    required(deps.mailActionService, 'Drafts are unavailable').deleteDraft(accountId, localDraftId),
  )
  handle(
    'send:request',
    z.tuple([AccountIdSchema, ComposeMessageSchema, z.string().max(256).optional(), z.string().uuid().optional()]),
    (accountId, message, conversationId, localDraftId) =>
      required(deps.mailActionService, 'Sending is unavailable').requestSend(
        accountId,
        message,
        conversationId,
        localDraftId,
      ),
  )
  handle('writing-profiles:list', z.tuple([AccountIdSchema]), (accountId) =>
    deps.writingProfileService?.list(accountId) ?? [],
  )
  handle('writing-profiles:rebuild', z.tuple([AccountIdSchema]), (accountId) =>
    deps.rebuildWritingProfiles
      ? deps.rebuildWritingProfiles(accountId)
      : required(deps.writingProfileService, 'Writing profiles are unavailable').rebuild(accountId),
  )
  handle(
    'writing-profiles:toggle',
    z.tuple([AccountIdSchema, z.string().min(1).max(320), z.boolean()]),
    (accountId, relationshipKey, enabled) => {
      required(deps.writingProfileService, 'Writing profiles are unavailable').setEnabled(
        accountId,
        relationshipKey,
        enabled,
      )
    },
  )
  handle('writing-profiles:reset', z.tuple([AccountIdSchema]), (accountId) => {
    required(deps.writingProfileService, 'Writing profiles are unavailable').reset(accountId)
  })
  handle('writing-profiles:export', z.tuple([AccountIdSchema]), (accountId) =>
    required(deps.writingProfileService, 'Writing profiles are unavailable').export(accountId),
  )
  handle(
    'writing-profiles:record-edit',
    z.tuple([AccountIdSchema, z.array(z.string().min(1).max(320)).max(200), z.string().max(200_000), z.string().max(200_000)]),
    (accountId, recipients, before, after) => {
      required(deps.writingProfileService, 'Writing profiles are unavailable').recordEdit(
        accountId,
        recipients,
        before,
        after,
      )
    },
  )
  handle(
    'drafts:generate',
    z.tuple([
      z.object({
        accountId: AccountIdSchema,
        recipients: z.array(z.string().min(1).max(320)).max(200),
        subject: z.string().max(998),
        instruction: z.string().min(1).max(20_000),
      }),
    ]),
    (input) => required(deps.draftingService, 'AI drafting is unavailable').generate(input),
  )
  handle(
    'automations:build',
    z.tuple([z.string().min(1).max(10_000), AccountIdSchema, TimeZoneSchema]),
    (instruction, defaultAccountId, timezone) =>
      required(deps.automationService, 'Automations are unavailable').build(instruction, defaultAccountId, timezone),
  )
  handle('automations:simulate', z.tuple([AutomationSpecSchema]), (spec) =>
    required(deps.automationService, 'Automations are unavailable').simulate(spec),
  )
  handle('automations:activate', z.tuple([AutomationSpecSchema, IdSchema]), (spec, simulationId) => {
    required(deps.automationService, 'Automations are unavailable').activate(spec, simulationId)
  })
  handle('automations:list', z.tuple([]), () => deps.automationService?.records() ?? [])
  handle(
    'automations:set-status',
    z.tuple([IdSchema, z.enum(['active', 'paused', 'archived'])]),
    (versionId, status) => {
      required(deps.automationService, 'Automations are unavailable').setStatus(versionId, status)
    },
  )
  handle('automations:run-now', z.tuple([IdSchema]), (versionId) =>
    required(deps.automationScheduler, 'Automation scheduler is unavailable').runManual(versionId),
  )
  handle('automations:runs', z.tuple([IdSchema]), (versionId) => deps.automationService?.runs(versionId) ?? [])
}
