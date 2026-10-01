import { useState } from 'react'
import { Paperclip, Send, Sparkles, X } from 'lucide-react'
import { splitAddresses } from '@gmail/core'
import type { ComposeAttachment, ComposeMessage } from '../../main/ipc/contract'

export function ComposePane({
  accountId,
  initial,
  onClose,
  onPending,
}: {
  accountId: number
  initial?: Partial<ComposeMessage>
  onClose: () => void
  onPending: () => void
}) {
  const [to, setTo] = useState((initial?.to ?? []).join(', '))
  const [cc, setCc] = useState((initial?.cc ?? []).join(', '))
  const [subject, setSubject] = useState(initial?.subject ?? '')
  const [bodyText, setBodyText] = useState(initial?.bodyText ?? '')
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(initial?.attachments ?? [])
  const [localDraftId, setLocalDraftId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [generatedDraft, setGeneratedDraft] = useState<string | null>(null)

  const value = (): ComposeMessage => ({
    to: addresses(to),
    cc: addresses(cc),
    subject,
    bodyText,
    threadId: initial?.threadId,
    inReplyTo: initial?.inReplyTo,
    references: initial?.references,
    attachments,
  })
  const save = async () => {
    setBusy(true); setMessage(null)
    try {
      if (generatedDraft && generatedDraft !== bodyText) {
        await window.mail.recordDraftEdit(accountId, addresses(to), generatedDraft, bodyText)
      }
      const result = (await window.mail.saveDraft(accountId, localDraftId, value())) as { localDraftId: string }
      setLocalDraftId(result.localDraftId); setMessage('Draft saved to Gmail')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const send = async () => {
    setBusy(true); setMessage(null)
    try {
      if (generatedDraft && generatedDraft !== bodyText) {
        await window.mail.recordDraftEdit(accountId, addresses(to), generatedDraft, bodyText)
      }
      const pending = await window.mail.requestSend(accountId, value(), undefined, localDraftId)
      if (pending.status === 'pending') { onPending(); onClose() }
      else setMessage(`Send ${pending.status}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const writeWithAI = async () => {
    setBusy(true); setMessage('Learning your writing style…')
    try {
      const draft = await window.mail.generateDraft({
        accountId,
        recipients: addresses(to),
        subject,
        instruction: bodyText.trim() || `Write an email about ${subject || 'this topic'}`,
      })
      setGeneratedDraft(draft); setBodyText(draft); setMessage('Personalized draft generated')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const attach = async (files: FileList | null) => {
    if (!files) return
    const added = await Promise.all([...files].map(async (file) => ({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
    })))
    setAttachments((current) => [...current, ...added])
  }
  return (
    <div className="absolute inset-0 z-20 flex items-end justify-end bg-black/15 p-5">
      <section className="flex h-[72%] w-[620px] flex-col overflow-hidden rounded-xl border border-separator bg-surface shadow-2xl">
        <header className="drag flex h-10 items-center border-b border-separator px-3"><strong className="text-sm">New Message</strong><button onClick={onClose} className="no-drag ml-auto"><X className="size-4" /></button></header>
        <div className="divide-y divide-separator border-b border-separator text-sm">
          <input aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} placeholder="To" className="w-full bg-transparent px-3 py-2 outline-none" />
          <input aria-label="Cc" value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Cc" className="w-full bg-transparent px-3 py-2 outline-none" />
          <input aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" className="w-full bg-transparent px-3 py-2 outline-none" />
        </div>
        <textarea aria-label="Message body" value={bodyText} onChange={(event) => setBodyText(event.target.value)} className="selectable min-h-0 flex-1 resize-none bg-transparent p-4 text-sm outline-none" />
        {attachments.length > 0 && <div className="flex gap-2 overflow-x-auto px-3 py-2 text-xs">{attachments.map((item, index) => <button key={`${item.filename}:${index}`} onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))} className="rounded-full bg-surface-raised px-2 py-1">{item.filename} ×</button>)}</div>}
        {message && <p className="px-3 py-1 text-xs text-text-secondary">{message}</p>}
        <footer className="flex items-center gap-2 border-t border-separator p-2">
          <button disabled={busy} onClick={() => void send()} className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-white"><Send className="size-3" /> Review Send</button>
          <button disabled={busy} onClick={() => void save()} className="rounded-control border border-separator px-3 py-1.5 text-xs">Save Draft</button>
          <label className="cursor-pointer rounded-control p-1.5 hover:bg-surface-raised"><Paperclip className="size-4" /><input type="file" multiple className="hidden" onChange={(event) => void attach(event.target.files)} /></label>
          <button disabled={busy} onClick={() => void writeWithAI()} className="flex items-center gap-1 rounded-control p-1.5 text-xs text-accent hover:bg-accent-fill disabled:opacity-40"><Sparkles className="size-4" /> Write with AI</button>
        </footer>
      </section>
    </div>
  )
}

function addresses(value: string): string[] { return splitAddresses(value) }
function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value); let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
