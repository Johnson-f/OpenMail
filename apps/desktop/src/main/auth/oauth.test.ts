import { describe, expect, it } from 'vitest'
import { buildAuthUrl, GMAIL_SCOPES, startLoopbackServer } from './oauth'

describe('startLoopbackServer', () => {
  it('resolves waitForCode with the code from the redirect', async () => {
    const server = await startLoopbackServer()
    try {
      expect(server.port).toBeGreaterThan(0)

      const res = await fetch(`http://127.0.0.1:${server.port}/?code=abc123`)
      expect(res.status).toBe(200)

      await expect(server.waitForCode).resolves.toBe('abc123')
    } finally {
      server.close()
    }
  })

  it('rejects waitForCode when the redirect carries an error', async () => {
    const server = await startLoopbackServer()
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/?error=access_denied`)
      expect(res.status).toBe(200)

      await expect(server.waitForCode).rejects.toThrow(/access_denied/)
    } finally {
      server.close()
    }
  })

  it('rejects waitForCode when neither code nor error is present', async () => {
    const server = await startLoopbackServer()
    try {
      await fetch(`http://127.0.0.1:${server.port}/`)
      await expect(server.waitForCode).rejects.toThrow()
    } finally {
      server.close()
    }
  })
})

describe('buildAuthUrl', () => {
  it('includes the loopback redirect uri, scopes, and offline+consent params', () => {
    const url = new URL(buildAuthUrl('client-123', 54321))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54321')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '))
  })
})
