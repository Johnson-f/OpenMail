import { useState } from 'react'
import {
  Archive,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Folder,
  ReplyAll,
  Trash2,
  TriangleAlert,
  Sparkles,
} from 'lucide-react'
import type { MessageWithLabels } from '@gmail/core'
import { cn } from '@gmail/ui'

function ToolbarButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex size-[28px] items-center justify-center rounded-control text-text-secondary',
        'hover:bg-black/[0.06] active:bg-black/[0.1] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.12]',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-separator-strong" />
}

function formatFullDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  if (d.getTime() >= startOfToday) return `Today at ${time}`
  if (d.getTime() >= startOfToday - 86_400_000) return `Yesterday at ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`
}

function initials(name: string): string {
  const words = name.replace(/[<>"]/g, '').trim().split(/[\s@.]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] ?? '?').slice(0, 1).toUpperCase()
  return ((words[0] ?? '').slice(0, 1) + (words[1] ?? '').slice(0, 1)).toUpperCase()
}

function senderName(from: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from)
  if (!m) return from.trim()
  const name = (m[1] ?? '').replace(/^"|"$/g, '').trim()
  return name || (m[2] ?? '').trim()
}

function senderAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from)
  return m?.[1] ?? from.trim()
}

type Props = {
  messages: MessageWithLabels[]
  mailboxName: string
  onArchive: () => void
  onTrash: () => void
  onJunk: () => void
  onAskAI: () => void
  onReply: () => void
  onReplyAll: () => void
  onForward: () => void
}

export function ReadingPane({
  messages,
  mailboxName,
  onArchive,
  onTrash,
  onJunk,
  onAskAI,
  onReply,
  onReplyAll,
  onForward,
}: Props) {
  const empty = messages.length === 0

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-separator px-3">
        <div className="no-drag flex items-center">
          <ToolbarButton title="Reply" onClick={onReply} disabled={empty}>
            <CornerUpLeft className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Reply All" onClick={onReplyAll} disabled={empty}>
            <ReplyAll className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Forward" onClick={onForward} disabled={empty}>
            <CornerUpRight className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <Divider />
          <ToolbarButton title="Archive" onClick={onArchive} disabled={empty}>
            <Archive className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Delete" onClick={onTrash} disabled={empty}>
            <Trash2 className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Move to Junk" onClick={onJunk} disabled={empty}>
            <TriangleAlert className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <Divider />
          <ToolbarButton title="Move to Folder" disabled={empty}>
            <Folder className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Flag" disabled={empty}>
            <Flag className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <Divider />
          <ToolbarButton title="Ask AI" onClick={onAskAI} disabled={empty}>
            <Sparkles className="size-4 text-accent" strokeWidth={1.75} />
          </ToolbarButton>
        </div>
      </header>

      {empty ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-text-tertiary">No message selected</p>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-separator px-5 py-1.5">
            <span className="text-2xs text-text-secondary">
              {messages.length === 1 ? '1 Message' : `${messages.length} Messages`}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {messages.map((message, index) => (
              <ThreadMessage
                key={message.id}
                message={message}
                mailboxName={mailboxName}
                initiallyExpanded={index === messages.length - 1}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function plainBody(message: MessageWithLabels): string {
  // Plain text only: rendering remote HTML would run third-party markup and
  // load tracking pixels, which needs a sandboxed frame and a remote-content policy.
  if (message.bodyText.trim()) return message.bodyText
  return message.bodyHtml
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function ThreadMessage({
  message,
  mailboxName,
  initiallyExpanded,
}: {
  message: MessageWithLabels
  mailboxName: string
  initiallyExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const name = senderName(message.from)

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-3 border-b border-separator px-5 py-2.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-avatar text-2xs font-semibold text-white">
          {initials(name)}
        </div>
        <span className="w-40 shrink-0 truncate text-sm font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{message.snippet}</span>
        <span className="shrink-0 text-2xs text-text-secondary">{formatFullDate(message.internalDate)}</span>
      </button>
    )
  }

  const body = plainBody(message)
  return (
    <article className="border-b border-separator px-5 py-4">
      <div className="flex gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-avatar text-xs font-semibold text-white">
          {initials(name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-2xs text-text-secondary">
              <Folder className="size-3" strokeWidth={1.75} />
              {mailboxName}
              <span className="ml-1.5">{formatFullDate(message.internalDate)}</span>
            </span>
          </div>

          <p className="truncate text-sm text-text">{message.subject}</p>

          <dl className="mt-1 space-y-0.5 text-2xs text-text-secondary">
            {message.to.length > 0 && (
              <div className="flex gap-1.5">
                <dt className="shrink-0">To:</dt>
                <dd className="min-w-0 truncate text-accent">{message.to.map(senderAddress).join(', ')}</dd>
              </div>
            )}
            {message.cc.length > 0 && (
              <div className="flex gap-1.5">
                <dt className="shrink-0">Cc:</dt>
                <dd className="min-w-0 truncate text-accent">{message.cc.map(senderAddress).join(', ')}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className="selectable mt-6 whitespace-pre-wrap text-base leading-relaxed text-text">
        {body || <span className="text-text-tertiary">This message has no text.</span>}
      </div>
    </article>
  )
}
