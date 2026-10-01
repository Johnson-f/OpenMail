import { contextBridge, ipcRenderer } from 'electron'
import type { MailApi } from '../main/ipc/contract'

/**
 * The only bridge between the renderer and the main process. Everything the
 * UI can do is on this object; there is no generic passthrough.
 */
const api: MailApi = {
  signIn: () => ipcRenderer.invoke('auth:signin'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  listThreads: (accountId, labelId, limit) =>
    ipcRenderer.invoke('threads:list', accountId, labelId, limit),
  mailboxCounts: (accountId, labelIds) =>
    ipcRenderer.invoke('mailboxes:counts', accountId, labelIds),
  threadMessages: (accountId, threadId) =>
    ipcRenderer.invoke('thread:messages', accountId, threadId),
  search: (accountId, query, limit) =>
    ipcRenderer.invoke('search:messages', accountId, query, limit),
  modifyLabels: (accountId, messageId, add, remove) =>
    ipcRenderer.invoke('labels:modify', accountId, messageId, add, remove),
  syncStatus: (accountId) => ipcRenderer.invoke('sync:status', accountId),
  syncNow: (accountId) => ipcRenderer.invoke('sync:now', accountId),
  onMailChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('mail:changed', listener)
    return () => ipcRenderer.removeListener('mail:changed', listener)
  },
  providerStatus: () => ipcRenderer.invoke('providers:list'),
  setProviderKey: (provider, key) => ipcRenderer.invoke('providers:set-key', provider, key),
  removeProviderKey: (provider) => ipcRenderer.invoke('providers:remove-key', provider),
  assistantAsk: (input) => ipcRenderer.invoke('assistant:ask', input),
  assistantConversations: () => ipcRenderer.invoke('assistant:conversations'),
  assistantConversationMessages: (conversationId) =>
    ipcRenderer.invoke('assistant:conversation-messages', conversationId),
  indexingStatus: () => ipcRenderer.invoke('indexing:status'),
  retryFailedIndexing: () => ipcRenderer.invoke('indexing:retry-failed'),
  semanticSearch: (accountIds, query, limit) => ipcRenderer.invoke('search:semantic', accountIds, query, limit),
  pendingActions: () => ipcRenderer.invoke('actions:pending'),
  reviewAction: (intentId, contentHash, approved) =>
    ipcRenderer.invoke('actions:review', intentId, contentHash, approved),
  notSentActions: () => ipcRenderer.invoke('actions:not-sent'),
  resendAction: (intentId) => ipcRenderer.invoke('actions:resend', intentId),
  saveDraft: (accountId, localDraftId, message) => ipcRenderer.invoke('drafts:save', accountId, localDraftId, message),
  deleteDraft: (accountId, localDraftId) => ipcRenderer.invoke('drafts:delete', accountId, localDraftId),
  requestSend: (accountId, message, conversationId, localDraftId) =>
    ipcRenderer.invoke('send:request', accountId, message, conversationId, localDraftId),
  writingProfiles: (accountId) => ipcRenderer.invoke('writing-profiles:list', accountId),
  rebuildWritingProfiles: (accountId) => ipcRenderer.invoke('writing-profiles:rebuild', accountId),
  toggleWritingProfile: (accountId, relationshipKey, enabled) =>
    ipcRenderer.invoke('writing-profiles:toggle', accountId, relationshipKey, enabled),
  resetWritingProfiles: (accountId) => ipcRenderer.invoke('writing-profiles:reset', accountId),
  exportWritingProfiles: (accountId) => ipcRenderer.invoke('writing-profiles:export', accountId),
  recordDraftEdit: (accountId, recipients, before, after) =>
    ipcRenderer.invoke('writing-profiles:record-edit', accountId, recipients, before, after),
  generateDraft: (input) => ipcRenderer.invoke('drafts:generate', input),
  buildAutomation: (instruction, defaultAccountId, timezone) =>
    ipcRenderer.invoke('automations:build', instruction, defaultAccountId, timezone),
  simulateAutomation: (spec) => ipcRenderer.invoke('automations:simulate', spec),
  activateAutomation: (spec, simulationId) => ipcRenderer.invoke('automations:activate', spec, simulationId),
  listAutomations: () => ipcRenderer.invoke('automations:list'),
  setAutomationStatus: (versionId, status) => ipcRenderer.invoke('automations:set-status', versionId, status),
  runAutomationNow: (versionId) => ipcRenderer.invoke('automations:run-now', versionId),
  automationRuns: (versionId) => ipcRenderer.invoke('automations:runs', versionId),
}

contextBridge.exposeInMainWorld('mail', api)
