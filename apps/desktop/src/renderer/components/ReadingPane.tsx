import { useMemo } from 'react'
import {
  Archive,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Folder,
  ReplyAll,
  Trash2,
  TriangleAlert,
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
}

export function ReadingPane({ messages, mailboxName, onArchive, onTrash, onJunk }: Props) {
  const latest = messages[messages.length - 1]

  // Prefer the plain-text body. Rendering remote HTML would run third-party
  // markup and load tracking pixels inside the app; that needs a sandboxed
  // frame and a remote-content policy, which is Phase 2 work.
  const body = useMemo(() => {
    if (!latest) return ''
    if (latest.bodyText.trim()) return latest.bodyText
    return latest.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }, [latest])

  const empty = messages.length === 0

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-separator px-3">
        <div className="no-drag flex items-center">
          <ToolbarButton title="Reply" disabled={empty}>
            <CornerUpLeft className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Reply All" disabled={empty}>
            <ReplyAll className="size-4" strokeWidth={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Forward" disabled={empty}>
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
            {latest && (
              <article className="px-5 py-4">
                <div className="flex gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-avatar text-xs font-semibold text-white">
                    {initials(senderName(latest.from))}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-semibold">
                        {senderName(latest.from)}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-2xs text-text-secondary">
                        <Folder className="size-3" strokeWidth={1.75} />
                        {mailboxName}
                        <span className="ml-1.5">{formatFullDate(latest.internalDate)}</span>
                      </span>
                    </div>

                    <p className="truncate text-sm text-text">{latest.subject}</p>

                    <dl className="mt-1 space-y-0.5 text-2xs text-text-secondary">
                      {latest.to.length > 0 && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">To:</dt>
                          <dd className="min-w-0 truncate text-accent">
                            {latest.to.map(senderAddress).join(', ')}
                          </dd>
                        </div>
                      )}
                      {latest.cc.length > 0 && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0">Cc:</dt>
                          <dd className="min-w-0 truncate text-accent">
                            {latest.cc.map(senderAddress).join(', ')}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>
                </div>

                <div className="selectable mt-6 whitespace-pre-wrap text-base leading-relaxed text-text">
                  {body || <span className="text-text-tertiary">This message has no text.</span>}
                </div>
              </article>
            )}
          </div>
        </>
      )}
    </div>
  )
}
