import { google } from 'googleapis'
import type Database from 'better-sqlite3'
import { buildAuthUrl, startLoopbackServer } from './oauth'
import { saveAccount, type Encryptor } from './tokens'

/**
 * Runs the interactive OAuth sign-in flow: opens the system browser,
 * receives the redirect on a loopback server, exchanges the code for
 * tokens, and persists the refresh token. Not unit-tested — it needs a
 * real browser and a real Google consent screen; verify manually.
 */
export async function signIn(db: Database.Database, enc: Encryptor): Promise<number> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Follow docs/google-cloud-setup.md ' +
        'to create an OAuth client and put the credentials in your .env file.',
    )
  }

  const server = await startLoopbackServer()

  try {
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `http://127.0.0.1:${server.port}`,
    )

    const authUrl = buildAuthUrl(clientId, server.port)

    const { shell } = await import('electron')
    await shell.openExternal(authUrl)

    const code = await server.waitForCode

    const { tokens } = await oauth2Client.getToken(code)

    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. This usually means the app was already ' +
          'authorized. Revoke access for this app at https://myaccount.google.com/permissions ' +
          'and try signing in again.',
      )
    }

    oauth2Client.setCredentials(tokens)

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
    const { data: profile } = await oauth2.userinfo.get()

    if (!profile.email) {
      throw new Error('Google did not return an email address for this account.')
    }

    return saveAccount(db, enc, profile.email, tokens.refresh_token)
  } finally {
    server.close()
  }
}
