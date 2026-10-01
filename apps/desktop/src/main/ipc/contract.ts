import type {
  AccountRow,
  MailboxCounts,
  MessageWithLabels,
  SearchHit,
  SyncStatus,
  ThreadSummary,
} from '@gmail/core'
import type {
  ActionIntent,
  AssistantAnswer,
  AutomationSimulation,
  AutomationSpec,
  PolicyDecision,
} from '@gmail/agent'

/**
 * The complete set of capabilities the renderer has.
 *
 * This list is the security boundary. The renderer holds no database
 * handle, no OAuth token, and no network client — it can reach nothing
 * that is not named here. Adding a channel is a deliberate act; keep the
 * list small and reviewable.
 */
export const IPC_CHANNELS = [
  'auth:signin',
  'accounts:list',
  'threads:list',
  'mailboxes:counts',
  'thread:messages',
  'search:messages',
  'labels:modify',
  'sync:status',
  'sync:now',
  'providers:list',
  'providers:set-key',
  'providers:remove-key',
  'assistant:ask',
  'assistant:conversations',
  'assistant:conversation-messages',
  'indexing:status',
  'indexing:retry-failed',
  'search:semantic',
  'actions:pending',
  'actions:review',
  'actions:not-sent',
  'actions:resend',
  'drafts:save',
  'drafts:delete',
  'send:request',
  'writing-profiles:list',
  'writing-profiles:rebuild',
  'writing-profiles:toggle',
  'writing-profiles:reset',
  'writing-profiles:export',
  'writing-profiles:record-edit',
  'drafts:generate',
  'automations:build',
  'automations:simulate',
  'automations:activate',
  'automations:list',
  'automations:set-status',
  'automations:run-now',
  'automations:runs',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

export const IPC_EVENTS = ['mail:changed'] as const

export type ProviderName = 'voyage' | 'perplexity'
export type ProviderStatus = { provider: ProviderName; configured: boolean }
export type AssistantAskInput = {
  conversationId?: string
  question: string
  accountIds: number[]
  threadIds?: string[]
}
export type ConversationSummary = { id: string; title: string; accountIds: number[]; updatedAt: number }
export type StoredConversationMessage = {
  id: string
  role: 'user' | 'assistant'
  content: { text: string } | AssistantAnswer
  createdAt: number
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
export type PendingAction = { intent: ActionIntent; decision: PolicyDecision; status: string }
export type NotSentSend = { intent: ActionIntent; error: string | null; updatedAt: number }
export type SemanticThread = {
  threadId: string
  subject: string
  from: string
  snippet: string
  lastMessageAt: number
  accountId: number
}
export type ComposeAttachment = { filename: string; mimeType: string; dataBase64: string; contentId?: string }
export type ComposeMessage = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: ComposeAttachment[]
}
export type ActionReviewResult = {
  reviewStatus: 'approved' | 'denied'
  execution?: {
    status: 'sent' | 'uncertain' | 'failed' | 'in_progress' | 'completed' | 'denied'
    message?: string
    error?: string
  }
}
export type WritingProfileRecord = {
  relationshipKey: string
  version: number
  enabled: boolean
  profile: Record<string, unknown>
}

export type MailApi = {
  signIn(): Promise<number>
  listAccounts(): Promise<AccountRow[]>
  listThreads(accountId: number, labelId: string, limit: number): Promise<ThreadSummary[]>
  mailboxCounts(accountId: number, labelIds: string[]): Promise<MailboxCounts[]>
  threadMessages(accountId: number, threadId: string): Promise<MessageWithLabels[]>
  search(accountId: number, query: string, limit: number): Promise<SearchHit[]>
  modifyLabels(
    accountId: number,
    messageId: string,
    add: string[],
    remove: string[],
  ): Promise<string[]>
  syncStatus(accountId: number): Promise<SyncStatus>
  syncNow(accountId: number): Promise<void>
  onMailChanged(callback: () => void): () => void
  providerStatus(): Promise<ProviderStatus[]>
  setProviderKey(provider: ProviderName, key: string): Promise<void>
  removeProviderKey(provider: ProviderName): Promise<void>
  assistantAsk(input: AssistantAskInput): Promise<AssistantAnswer & { conversationId: string }>
  assistantConversations(): Promise<ConversationSummary[]>
  assistantConversationMessages(conversationId: string): Promise<StoredConversationMessage[]>
  indexingStatus(): Promise<IndexingStatus>
  retryFailedIndexing(): Promise<number>
  semanticSearch(accountIds: number[], query: string, limit: number): Promise<SemanticThread[]>
  pendingActions(): Promise<PendingAction[]>
  reviewAction(intentId: string, contentHash: string, approved: boolean): Promise<ActionReviewResult>
  notSentActions(): Promise<NotSentSend[]>
  resendAction(intentId: string): Promise<PendingAction>
  saveDraft(accountId: number, localDraftId: string | undefined, message: ComposeMessage): Promise<unknown>
  deleteDraft(accountId: number, localDraftId: string): Promise<void>
  requestSend(
    accountId: number,
    message: ComposeMessage,
    conversationId?: string,
    localDraftId?: string,
  ): Promise<PendingAction>
  writingProfiles(accountId: number): Promise<WritingProfileRecord[]>
  rebuildWritingProfiles(accountId: number): Promise<WritingProfileRecord[]>
  toggleWritingProfile(accountId: number, relationshipKey: string, enabled: boolean): Promise<void>
  resetWritingProfiles(accountId: number): Promise<void>
  exportWritingProfiles(accountId: number): Promise<string>
  recordDraftEdit(accountId: number, recipients: string[], before: string, after: string): Promise<void>
  generateDraft(input: {
    accountId: number
    recipients: string[]
    subject: string
    instruction: string
  }): Promise<string>
  buildAutomation(instruction: string, defaultAccountId: number, timezone: string): Promise<AutomationSpec>
  simulateAutomation(spec: AutomationSpec): Promise<{ id: string; result: AutomationSimulation }>
  activateAutomation(spec: AutomationSpec, simulationId: string): Promise<void>
  listAutomations(): Promise<Array<{ versionId: string; spec: AutomationSpec; status: string }>>
  setAutomationStatus(versionId: string, status: 'active' | 'paused' | 'archived'): Promise<void>
  runAutomationNow(versionId: string): Promise<string>
  automationRuns(versionId: string): Promise<Array<{
    id: string
    status: string
    result: unknown
    lastError: string | null
    updatedAt: number
  }>>
}
