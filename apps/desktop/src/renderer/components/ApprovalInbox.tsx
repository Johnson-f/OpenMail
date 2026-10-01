import { useCallback, useEffect, useState } from 'react'
import type { NotSentSend, PendingAction } from '../../main/ipc/contract'

type SendAttachment = { filename?: string; dataBase64?: string }
type SendMessage = {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  bodyText?: string
  attachments?: SendAttachment[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

function withoutAttachmentData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAttachmentData)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'dataBase64').map(([key, item]) => [key, withoutAttachmentData(item)]),
    )
  }
  return value
}

function expiryLabel(expiresAt: number | undefined, now: number): string | null {
  if (!expiresAt) return null
  const minutes = Math.ceil((expiresAt - now) / 60_000)
  return minutes <= 0 ? 'Expired' : `Expires in ${minutes} min`
}

function SendSummary({ message }: { message: SendMessage }) {
  const rows: Array<[string, string]> = [
    ['To', (message.to ?? []).join(', ')],
    ['Cc', (message.cc ?? []).join(', ')],
    ['Bcc', (message.bcc ?? []).join(', ')],
    ['Subject', message.subject ?? ''],
  ]
  const body = message.bodyText ?? ''
  return (
    <div className="selectable mt-3 space-y-1 rounded-lg bg-surface-raised p-3 text-xs">
      {rows.filter(([label, value]) => value || label === 'To' || label === 'Subject').map(([label, value]) => (
        <div key={label} className="flex gap-2"><span className="w-14 shrink-0 text-text-secondary">{label}</span><span className="break-all">{value || '(none)'}</span></div>
      ))}
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap border-t border-separator pt-2 text-2xs">{body.length > 1000 ? `${body.slice(0, 1000)}...` : body}</pre>
      {(message.attachments ?? []).length > 0 && (
        <ul className="border-t border-separator pt-2 text-2xs">
          {message.attachments!.map((attachment, index) => (
            <li key={index}>{attachment.filename || 'attachment'} ({formatBytes(base64Bytes(attachment.dataBase64 ?? ''))})</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ApprovalInbox() {
  const [items, setItems] = useState<PendingAction[]>([])
  const [notSent, setNotSent] = useState<NotSentSend[]>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const refresh = useCallback(() => {
    void window.mail.pendingActions().then(setItems)
    void window.mail.notSentActions().then(setNotSent)
    setNow(Date.now())
  }, [])
  useEffect(() => { refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer) }, [refresh])

  const withBusy = async (id: string, work: () => Promise<void>) => {
    if (busy.has(id)) return
    setBusy((current) => new Set(current).add(id))
    try {
      await work()
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((current) => { const next = new Set(current); next.delete(id); return next })
      refresh()
    }
  }
  const review = (item: PendingAction, approved: boolean) =>
    withBusy(item.intent.id, async () => {
      const response = await window.mail.reviewAction(item.intent.id, item.intent.contentHash, approved)
      setResult(response.execution ? `Send ${response.execution.status}` : response.reviewStatus)
    })
  const resend = (item: NotSentSend) =>
    withBusy(item.intent.id, async () => {
      await window.mail.resendAction(item.intent.id)
      setResult('A new send is waiting for your approval')
    })

  return (
    <div className="h-full overflow-y-auto bg-surface p-6 pt-[64px]">
      <div className="mx-auto max-w-2xl"><h1 className="text-xl font-semibold">Approvals</h1><p className="mt-1 text-sm text-text-secondary">Review the exact content and scope before sensitive actions run.</p>
        {result && <p className="mt-4 rounded-lg bg-accent-fill p-3 text-xs text-accent">{result}</p>}
        <div className="mt-5 space-y-3">{items.map((item) => {
          const disabled = busy.has(item.intent.id)
          const expiry = expiryLabel(item.intent.expiresAt, now)
          return (
            <div key={item.intent.id} className="rounded-xl border border-separator p-4"><div className="flex items-center"><strong className="capitalize">{item.intent.kind.replace('_', ' ')}</strong><span className="ml-auto text-xs text-text-secondary">Account {item.intent.accountId}</span></div>
              {item.intent.kind === 'send'
                ? <SendSummary message={(item.intent.arguments.message ?? {}) as SendMessage} />
                : <pre className="selectable mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-raised p-3 text-2xs">{JSON.stringify(withoutAttachmentData(item.intent.arguments), null, 2)}</pre>}
              <p className="mt-2 text-2xs text-text-secondary">{item.decision.reason}{expiry ? ` · ${expiry}` : ''}</p>
              <div className="mt-3 flex gap-2"><button disabled={disabled} onClick={() => void review(item, true)} className="rounded-control bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">Approve exact action</button><button disabled={disabled} onClick={() => void review(item, false)} className="rounded-control border border-separator px-3 py-1.5 text-xs text-danger disabled:opacity-50">Reject</button></div></div>
          )
        })}{items.length === 0 && <p className="py-16 text-center text-sm text-text-tertiary">No actions are waiting for review.</p>}</div>
        {notSent.length > 0 && (
          <div className="mt-8"><h2 className="text-sm font-semibold">Not sent</h2><p className="mt-1 text-xs text-text-secondary">Gmail has no record of these messages. Sending again needs a new approval.</p>
            <div className="mt-3 space-y-3">{notSent.map((item) => (
              <div key={item.intent.id} className="rounded-xl border border-separator p-4">
                <SendSummary message={(item.intent.arguments.message ?? {}) as SendMessage} />
                {item.error && <p className="mt-2 text-2xs text-danger">{item.error}</p>}
                <button disabled={busy.has(item.intent.id)} onClick={() => void resend(item)} className="mt-3 rounded-control bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">Send again</button>
              </div>
            ))}</div>
          </div>
        )}
      </div>
    </div>
  )
}
