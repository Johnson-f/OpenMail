import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Encryptor } from '../auth/tokens'

export type ProviderName = 'voyage' | 'perplexity'

type SecretFile = { version: 1; secrets: Partial<Record<ProviderName, string>> }

export type SecretSource = {
  has(provider: ProviderName): boolean
  get(provider: ProviderName): string | null
  set(provider: ProviderName, key: string): void
  remove(provider: ProviderName): void
}

export class MemorySecretSource implements SecretSource {
  private readonly keys = new Map<ProviderName, string>()

  has(provider: ProviderName): boolean {
    return this.keys.has(provider)
  }

  get(provider: ProviderName): string | null {
    return this.keys.get(provider) ?? null
  }

  set(provider: ProviderName, key: string): void {
    this.keys.set(provider, key)
  }

  remove(provider: ProviderName): void {
    this.keys.delete(provider)
  }
}

const EMPTY: SecretFile = { version: 1, secrets: {} }

export class ProviderSecretStore {
  constructor(
    private readonly path: string,
    private readonly encryptor: Encryptor,
  ) {}

  has(provider: ProviderName): boolean {
    return Boolean(this.read().secrets[provider])
  }

  get(provider: ProviderName): string | null {
    const encoded = this.read().secrets[provider]
    return encoded ? this.encryptor.decryptString(Buffer.from(encoded, 'base64')) : null
  }

  set(provider: ProviderName, key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('Provider key cannot be empty')
    const file = this.read()
    file.secrets[provider] = this.encryptor.encryptString(trimmed).toString('base64')
    this.write(file)
  }

  remove(provider: ProviderName): void {
    const file = this.read()
    delete file.secrets[provider]
    this.write(file)
  }

  private read(): SecretFile {
    if (!existsSync(this.path)) return { ...EMPTY, secrets: {} }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as SecretFile
    if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== 'object') {
      throw new Error('Provider secret file has an unsupported format')
    }
    return { version: 1, secrets: { ...parsed.secrets } }
  }

  private write(file: SecretFile): void {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
  }
}
