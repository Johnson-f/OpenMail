import { app, BrowserWindow, utilityProcess } from 'electron'
import { join } from 'node:path'
import { GoogleGmail } from '@gmail/gmail'
import { markCleanShutdown, openAgentDatabase, openDatabase, openIndexDatabase } from './db/index'
import { SqliteMailStore } from './db/store'
import {
  electronEncryptor,
  listAccounts,
  loadRefreshToken,
} from './auth/tokens'
import { registerIpcHandlers } from './ipc/handlers'
import { GmailClientCache } from './sync/gmail-clients'
import { ProviderSecretStore } from './ai/secrets'
import { ProviderRegistry } from './ai/providers/registry'
import { SqliteVecIndex } from './ai/sqlite-vec-index'
import { SqliteKnowledgeRepository } from './ai/knowledge-repository'
import { HybridRetriever } from '@gmail/intelligence'
import {
  ActionApprovalGraph,
  AgentRuntime,
  AutomationBuilder,
  PolicyEngine,
} from '@gmail/agent'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { AssistantService } from './ai/assistant-service'
import { ActionService } from './ai/action-service'
import { MailActionService } from './ai/mail-action-service'
import { AssistantToolService } from './ai/assistant-tool-service'
import { WritingProfileService } from './ai/writing-profile-service'
import { DraftingService } from './ai/drafting-service'
import { AutomationService } from './ai/automation-service'
import { MailChangeNotifier } from './mail-changes'
import { BackgroundHost, type BackgroundChild } from './background-host'
import type { BackgroundInit } from '../background/protocol'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',
    // 'under-window' is the material Mail uses for its sidebar. Because
    // only the sidebar is transparent in CSS, this reads as a translucent
    // sidebar against opaque panes — not a see-through window.
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    trafficLightPosition: { x: 14, y: 18 },
    minWidth: 900,
    minHeight: 560,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * Load GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET into process.env.
 *
 * Vite only injects build-time constants for prefixed variables, and a
 * packaged app has no bundler involved at all — so read the file ourselves
 * rather than depending on the dev server to have done it. Missing file is
 * fine here; signIn() raises a clear, actionable error if the values are
 * absent when the user actually tries to sign in.
 */
function loadEnvFile(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(import.meta.dirname, '../../.env'),
    join(app.getAppPath(), '.env'),
  ]
  for (const path of candidates) {
    try {
      process.loadEnvFile(path)
      return
    } catch {
      // Try the next candidate.
    }
  }
}

loadEnvFile()

// Without this, userData derives from the package name and the database
// lands in "Application Support/@gmail/desktop/". Changing it after users
// have mail on disk would orphan their database, so pin it now.
app.setName('Mail')
if (process.env.OPENMAIL_USER_DATA_DIR) {
  app.setPath('userData', process.env.OPENMAIL_USER_DATA_DIR)
}

void app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const db = openDatabase(join(userData, 'mail.db'))
  const indexDb = openIndexDatabase(join(userData, 'index.db'))
  const agentDb = openAgentDatabase(join(userData, 'agent.db'))
  const encryptor = electronEncryptor()
  const store = new SqliteMailStore(db)
  const providerSecrets = new ProviderSecretStore(join(userData, 'ai-secrets.json'), encryptor)
  const providerRegistry = new ProviderRegistry(providerSecrets)
  const gmailClients = new GmailClientCache((accountId: number) =>
    GoogleGmail.forRefreshToken(
      process.env.GOOGLE_CLIENT_ID ?? '',
      process.env.GOOGLE_CLIENT_SECRET ?? '',
      loadRefreshToken(db, encryptor, accountId),
    ),
  )
  const gmailFor = (accountId: number): GoogleGmail => gmailClients.get(accountId)

  const vectorIndex = new SqliteVecIndex(indexDb)
  const knowledgeRepository = new SqliteKnowledgeRepository(indexDb)
  const createRetriever = () =>
    new HybridRetriever(
      knowledgeRepository,
      vectorIndex,
      providerRegistry.embedding(),
      providerRegistry.reranker(),
    )
  const checkpointer = new SqliteSaver(agentDb as never)
  const actionService = new ActionService(
    agentDb,
    new PolicyEngine(),
    new ActionApprovalGraph(checkpointer),
  )
  const mailActionService = new MailActionService(db, store, gmailFor, actionService)
  mailActionService.recoverInterrupted()
  const assistantToolService = new AssistantToolService(store, actionService, mailActionService, (accountId, threadIds) => {
    if (threadIds.length === 0) return []
    const rows = db
      .prepare(
        `SELECT id FROM messages WHERE account_id = ? AND thread_id IN (${threadIds.map(() => '?').join(',')})`,
      )
      .all(accountId, ...threadIds) as Array<{ id: string }>
    return rows.map((row) => row.id)
  })
  const assistantRuntime = new AgentRuntime(
    {
      retrieve: (question, accountIds, signal, threadIds) =>
        createRetriever().retrieve(
          question,
          { accountIds, ...(threadIds?.length ? { threadIds } : {}) },
          { signal },
        ),
    },
    () => providerRegistry.brain(),
    undefined,
    assistantToolService,
  )
  const assistantService = new AssistantService(agentDb, assistantRuntime)
  const writingProfileService = new WritingProfileService(db, agentDb)
  const draftingService = new DraftingService(writingProfileService, () => providerRegistry.brain())
  const automationService = new AutomationService(
    db,
    agentDb,
    new AutomationBuilder(() => providerRegistry.brain()),
    () => app.setLoginItemSettings({ openAtLogin: true, args: ['--background'] }),
  )
  const host = new BackgroundHost({
    fork: () =>
      utilityProcess.fork(join(import.meta.dirname, 'background.js'), [], {
        serviceName: 'OpenMail Background',
        stdio: 'inherit',
      }) as unknown as BackgroundChild,
    buildInit: (): BackgroundInit => buildBackgroundInit(),
    log: (level, message) => console[level](`[background] ${message}`),
  })

  function buildBackgroundInit(): BackgroundInit {
    const refreshTokens: Record<number, string> = {}
    for (const account of listAccounts(db)) {
      try {
        refreshTokens[account.id] = loadRefreshToken(db, encryptor, account.id)
      } catch (err) {
        console.error(`Could not decrypt refresh token for account ${account.id}:`, err)
      }
    }
    const providerKeys: BackgroundInit['providerKeys'] = {}
    for (const provider of ['voyage', 'perplexity'] as const) {
      const key = providerSecrets.get(provider)
      if (key) providerKeys[provider] = key
    }
    return {
      userDataDir: userData,
      googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      refreshTokens,
      providerKeys,
    }
  }

  registerIpcHandlers({
    db,
    encryptor,
    gmailFor,
    invalidateGmailClient: (accountId: number) => gmailClients.invalidate(accountId),
    onRefreshTokenChanged: (accountId, refreshToken) => host.setRefreshToken(accountId, refreshToken),
    onProviderKeyChanged: (provider, key) => host.setProviderKey(provider, key),
    providerRegistry,
    assistantService,
    indexingWorker: { status: () => host.indexingStatus(), retryFailed: () => host.retryFailedIndexing() },
    actionService,
    mailActionService,
    writingProfileService,
    rebuildWritingProfiles: (accountId: number) => host.rebuildWritingProfiles(accountId),
    draftingService,
    automationService,
    automationScheduler: { runManual: (versionId) => host.runAutomationNow(versionId) },
    demoMode: process.env.OPENMAIL_UI_DEMO === '1',
    semanticSearch: async (accountIds, query, limit) => {
      const result = await createRetriever().retrieve(query, { accountIds }, { evidenceLimit: limit })
      const seen = new Set<string>()
      return result.evidence.flatMap((item) => {
        if (seen.has(item.threadId)) return []
        seen.add(item.threadId)
        return [{
          threadId: item.threadId,
          subject: String(item.metadata.subject ?? ''),
          from: String(item.metadata.from ?? ''),
          snippet: item.content.slice(0, 240),
          lastMessageAt: item.internalDate,
          accountId: item.accountId,
        }]
      })
    },
    assistantToolService,
    syncAccount: (accountId) => host.syncAccount(accountId),
  })
  const changeNotifier = new MailChangeNotifier(db, () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('mail:changed')
  })
  changeNotifier.start()
  host.start()

  // macOS also emits 'activate' for the launch itself, which would open a
  // window on every login-item start; only a later activation (a Dock click)
  // should show the window for a background launch.
  let ignoreLaunchActivation = process.argv.includes('--background')
  if (!ignoreLaunchActivation) createWindow()
  app.on('activate', () => {
    if (ignoreLaunchActivation) {
      ignoreLaunchActivation = false
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  let shutdownComplete = false
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    shutdownComplete = true
    changeNotifier.stop()
    void host.stop().finally(() => {
      indexDb.close()
      agentDb.close()
      db.close()
      for (const file of ['mail.db', 'index.db', 'agent.db']) markCleanShutdown(join(userData, file))
      app.quit()
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
