import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Encryptor } from '../auth/tokens'
import { ProviderSecretStore } from './secrets'

const encryptor: Encryptor = {
  encryptString: (plain) => Buffer.from(`encrypted:${plain}`),
  decryptString: (cipher) => cipher.toString().replace(/^encrypted:/, ''),
}

describe('ProviderSecretStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('persists ciphertext without exposing plaintext', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openmail-secrets-'))
    dirs.push(dir)
    const path = join(dir, 'ai-secrets.json')
    const store = new ProviderSecretStore(path, encryptor)

    store.set('voyage', 'voyage-secret')

    expect(store.has('voyage')).toBe(true)
    expect(store.get('voyage')).toBe('voyage-secret')
    expect(readFileSync(path, 'utf8')).not.toContain('"voyage-secret"')
  })

  it('removes one provider without affecting the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openmail-secrets-'))
    dirs.push(dir)
    const store = new ProviderSecretStore(join(dir, 'ai-secrets.json'), encryptor)
    store.set('voyage', 'v')
    store.set('perplexity', 'p')
    store.remove('voyage')
    expect(store.get('voyage')).toBeNull()
    expect(store.get('perplexity')).toBe('p')
  })
})
