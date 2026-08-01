import type { MailApi } from '../main/ipc/contract'

declare global {
  interface Window {
    mail: MailApi
  }
}

export {}
