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
}

contextBridge.exposeInMainWorld('mail', api)
