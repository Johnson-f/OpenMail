import type { IndexingStatus } from '../main/ai/indexing-worker'
import type { WritingProfileRecord } from '../main/ai/writing-profile-service'

export type ProviderKeyName = 'voyage' | 'perplexity'

export type BackgroundInit = {
  userDataDir: string
  googleClientId: string
  googleClientSecret: string
  refreshTokens: Record<number, string>
  providerKeys: Partial<Record<ProviderKeyName, string>>
}

export type BackgroundRequests = {
  syncAccount: { args: [accountId: number]; result: void }
  indexingStatus: { args: []; result: IndexingStatus }
  retryFailedIndexing: { args: []; result: number }
  runAutomationNow: { args: [versionId: string]; result: string }
  wakeIndexer: { args: []; result: void }
  rebuildWritingProfiles: { args: [accountId: number]; result: WritingProfileRecord[] }
}

export type BackgroundMethod = keyof BackgroundRequests

export type RequestMessage = {
  [M in BackgroundMethod]: { type: 'request'; id: number; method: M; args: BackgroundRequests[M]['args'] }
}[BackgroundMethod]

export type MainToBackground =
  | ({ type: 'init' } & BackgroundInit)
  | { type: 'set-refresh-token'; accountId: number; refreshToken: string }
  | { type: 'set-provider-key'; provider: ProviderKeyName; key: string | null }
  | { type: 'shutdown' }
  | RequestMessage

export type BackgroundToMain =
  | { type: 'ready' }
  | { type: 'response'; id: number; result: unknown }
  | { type: 'response'; id: number; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
