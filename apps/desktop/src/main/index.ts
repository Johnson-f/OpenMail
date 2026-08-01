import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { GoogleGmail } from '@gmail/gmail'
import { drainOutbox, runIncrementalSync } from '@gmail/sync'
import { openDatabase } from './db/index'
import { SqliteMailStore } from './db/store'
import {
  electronEncryptor,
  isRevokedTokenError,
  listAccounts,
  loadRefreshToken,
  markNeedsReauth,
} from './auth/tokens'
import { registerIpcHandlers } from './ipc/handlers'

const SYNC_INTERVAL_MS = 30_000

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
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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

void app.whenReady().then(() => {
  const db = openDatabase(join(app.getPath('userData'), 'mail.db'))
  const encryptor = electronEncryptor()
  const store = new SqliteMailStore(db)

  const gmailFor = (accountId: number): GoogleGmail =>
    GoogleGmail.forRefreshToken(
      process.env.GOOGLE_CLIENT_ID ?? '',
      process.env.GOOGLE_CLIENT_SECRET ?? '',
      loadRefreshToken(db, encryptor, accountId),
    )

  registerIpcHandlers({ db, encryptor, gmailFor })

  setInterval(() => {
    void (async () => {
      for (const account of listAccounts(db)) {
        if (account.needsReauth) continue
        // Skip accounts whose first download is still in flight; incremental
        // sync throws if it runs before backfill finishes.
        if (!store.getSyncCursor(account.id).backfillComplete) continue

        try {
          const gmail = gmailFor(account.id)
          await drainOutbox(store, account.id, gmail)
          await runIncrementalSync(store, account.id, gmail)
        } catch (err) {
          // A revoked token is permanent — stop retrying and surface the
          // re-auth banner. Anything else (a dropped connection, a rate
          // limit) is transient and must NOT sign the user out.
          if (isRevokedTokenError(err)) markNeedsReauth(db, account.id)
          // Never let one account's failure stop the others, and never fail
          // silently — this lands in the main-process log either way.
          console.error(`Sync failed for account ${account.id}:`, err)
        }
      }
    })()
  }, SYNC_INTERVAL_MS)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
