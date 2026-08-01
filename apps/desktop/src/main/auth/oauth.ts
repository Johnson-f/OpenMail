import { createServer } from 'node:http'
import type { Server } from 'node:http'

// gmail.modify covers read, label changes (archive/star/mark read), and
// send. It does NOT cover permanent deletion — our "delete" is move-to-Trash.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
]

const CLOSE_TAB_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Signed in</title></head>
  <body style="font-family: -apple-system, sans-serif; text-align: center; padding-top: 4rem;">
    <p>You're signed in. You can close this tab and return to the app.</p>
  </body>
</html>`

export type LoopbackServer = {
  port: number
  waitForCode: Promise<string>
  close(): void
}

/**
 * Starts an HTTP server on 127.0.0.1 (never 0.0.0.0 — this must not be
 * reachable from the network) with an OS-assigned free port, to receive
 * Google's OAuth redirect.
 */
export function startLoopbackServer(): Promise<LoopbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void

    const waitForCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // A rejection may happen before the caller ever awaits this promise
    // (e.g. the user closes the browser tab). Attach a no-op catch now so
    // Node doesn't flag it as an unhandled rejection.
    waitForCode.catch(() => {})

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(CLOSE_TAB_HTML)

      if (code) {
        resolveCode(code)
      } else if (error) {
        rejectCode(new Error(error))
      } else {
        rejectCode(new Error('OAuth redirect contained neither a code nor an error'))
      }
    })

    server.on('error', (err) => rejectServer(err))

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectServer(new Error('Failed to determine loopback server port'))
        return
      }

      resolveServer({
        port: address.port,
        waitForCode,
        close(): void {
          server.close()
        },
      })
    })
  })
}

/**
 * Builds Google's OAuth authorize URL. Both access_type=offline and
 * prompt=consent are required together — without prompt=consent, Google
 * only issues a refresh_token on the very first consent, and omits it on
 * every subsequent sign-in for the same client/user pair.
 */
export function buildAuthUrl(clientId: string, port: number): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}
