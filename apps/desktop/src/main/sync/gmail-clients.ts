import type { GmailApi } from '@gmail/gmail'

export class GmailClientCache<T extends GmailApi = GmailApi> {
  private readonly clients = new Map<number, T>()

  constructor(private readonly create: (accountId: number) => T) {}

  get(accountId: number): T {
    let client = this.clients.get(accountId)
    if (!client) {
      client = this.create(accountId)
      this.clients.set(accountId, client)
    }
    return client
  }

  invalidate(accountId: number): void {
    this.clients.delete(accountId)
  }
}
