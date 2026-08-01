import type {
  AccountRow,
  MailboxCounts,
  MessageWithLabels,
  SearchHit,
  SyncStatus,
  ThreadSummary,
} from '@gmail/core'

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
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

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
}
