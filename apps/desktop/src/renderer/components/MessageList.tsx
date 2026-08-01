import { Ellipsis, ListFilter, Paperclip, Sparkles, Star } from 'lucide-react'
import type { ThreadSummary } from '@gmail/core'
import { cn } from '@gmail/ui'

/**
 * Mail's date column is relative, not absolute: today shows a time,
 * yesterday shows the word, this week shows the weekday, and older shows a
 * date. The point is that scanning the column tells you *recency* at a
 * glance without reading any of it.
 */
function formatListDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86_400_000

  if (d.getTime() >= startOfToday) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  if (d.getTime() >= startOfToday - dayMs) return 'Yesterday'
  if (d.getTime() >= startOfToday - 6 * dayMs) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' })
}

/** Initials for the avatar, from a display name or an address. */
function initials(name: string): string {
  const cleaned = name.replace(/[<>"]/g, '').trim()
  const words = cleaned.split(/[\s@.]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] ?? '?').slice(0, 1).toUpperCase()
  return ((words[0] ?? '').slice(0, 1) + (words[1] ?? '').slice(0, 1)).toUpperCase()
}

function Avatar({ name }: { name: string }) {
  return (
    <div
      aria-hidden
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-avatar text-2xs font-semibold text-white"
    >
      {initials(name)}
    </div>
  )
}

type Props = {
  title: string
  subtitle: string
  threads: ThreadSummary[]
  selectedId: string | null
  loading: boolean
  onSelect: (threadId: string) => void
}

export function MessageList({
  title,
  subtitle,
  threads,
  selectedId,
  loading,
  onSelect,
}: Props) {
  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-r border-separator bg-surface">
      <header className="drag flex h-[52px] shrink-0 items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="truncate text-2xs text-text-secondary">{subtitle}</p>
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1 pt-0.5">
          <button
            title="Filter"
            className="flex size-[26px] items-center justify-center rounded-control text-text-secondary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            <ListFilter className="size-4" strokeWidth={1.75} />
          </button>
          <button
            title="More"
            className="flex size-[26px] items-center justify-center rounded-control text-text-secondary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            <Ellipsis className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <ul className="flex-1 overflow-y-auto">
        {threads.length === 0 && (
          <li className="px-4 py-10 text-center text-xs text-text-secondary">
            {loading ? 'Downloading your mail…' : 'No messages'}
          </li>
        )}

        {threads.map((t) => {
          const active = t.threadId === selectedId
          return (
            <li key={t.threadId}>
              <button
                onClick={() => onSelect(t.threadId)}
                aria-current={active}
                className={cn(
                  'flex w-full gap-2 border-b border-separator px-3 py-2 text-left',
                  active ? 'bg-select-unfocused' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                )}
              >
                {/* The unread dot occupies a fixed gutter whether or not it
                    is shown, so sender names stay on one vertical line. */}
                <span className="flex w-2 shrink-0 justify-center pt-2">
                  {t.unread && <span className="size-2 rounded-full bg-accent" />}
                </span>

                <Avatar name={t.from} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm',
                        t.unread ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {t.from || '(unknown sender)'}
                    </span>
                    <span className="shrink-0 text-2xs tabular-nums text-text-secondary">
                      {formatListDate(t.lastMessageAt)}
                    </span>
                  </div>

                  <div className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {t.subject || '(no subject)'}
                    </span>
                    {t.hasAttachment && (
                      <Paperclip className="size-3 shrink-0 text-text-tertiary" strokeWidth={2} />
                    )}
                    {t.starred && (
                      <Star className="size-3 shrink-0 fill-flag text-flag" strokeWidth={2} />
                    )}
                    {t.messageCount > 1 && (
                      <span className="shrink-0 text-2xs tabular-nums text-accent">
                        {t.messageCount}
                      </span>
                    )}
                  </div>

                  {t.snippet && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{t.snippet}</p>
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Section divider used above grouped rows, e.g. Priority. */
export function ListSectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-separator bg-surface-raised px-3 py-1.5">
      <Sparkles className="size-3.5 text-text-tertiary" strokeWidth={1.75} />
      <span className="text-2xs font-medium text-text-secondary">{label}</span>
    </div>
  )
}
