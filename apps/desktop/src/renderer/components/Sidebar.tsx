import type { ComponentType } from 'react'
import {
  Archive,
  File,
  Inbox,
  Send,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { AccountRow, MailboxCounts } from '@gmail/core'
import { cn } from '@gmail/ui'

/**
 * Gmail's system label ids, in the order macOS Mail lists mailboxes.
 * Ordering is not alphabetical anywhere in Mail — it is frequency of use,
 * which is why Inbox leads and Archive trails.
 */
export const MAILBOX_ORDER = [
  'IMPORTANT',
  'INBOX',
  'DRAFT',
  'SENT',
  'SPAM',
  'TRASH',
  'STARRED',
] as const

const MAILBOX_META: Record<string, { label: string; Icon: ComponentType<{ className?: string }> }> =
  {
    IMPORTANT: { label: 'Important', Icon: Tag },
    INBOX: { label: 'Inbox', Icon: Inbox },
    DRAFT: { label: 'Drafts', Icon: File },
    SENT: { label: 'Sent', Icon: Send },
    SPAM: { label: 'Junk', Icon: TriangleAlert },
    TRASH: { label: 'Trash', Icon: Trash2 },
    STARRED: { label: 'Starred', Icon: Star },
    ARCHIVE: { label: 'Archive', Icon: Archive },
  }

type Props = {
  accounts: AccountRow[]
  countsByAccount: Record<number, MailboxCounts[]>
  selected: { accountId: number; labelId: string } | null
  onSelect: (accountId: number, labelId: string) => void
}

function MailboxRow({
  labelId,
  counts,
  active,
  onClick,
}: {
  labelId: string
  counts: MailboxCounts | undefined
  active: boolean
  onClick: () => void
}) {
  const meta = MAILBOX_META[labelId] ?? { label: labelId, Icon: Tag }
  const { Icon } = meta

  // Mail shows unread count on Inbox-like mailboxes and total on archival
  // ones — the number you care about differs by mailbox, so showing the
  // same metric everywhere would be less useful, not more consistent.
  const badge =
    labelId === 'INBOX' || labelId === 'IMPORTANT' || labelId === 'SPAM'
      ? (counts?.unread ?? 0)
      : (counts?.total ?? 0)

  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex h-[26px] w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-sm',
        active ? 'bg-accent-fill font-medium' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
      )}
    >
      <Icon
        className={cn('size-[15px] shrink-0', active ? 'text-accent' : 'text-accent/85')}
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1 truncate text-left">{meta.label}</span>
      {badge > 0 && (
        <span className="shrink-0 text-2xs tabular-nums text-text-secondary">{badge}</span>
      )}
    </button>
  )
}

export function Sidebar({ accounts, countsByAccount, selected, onSelect }: Props) {
  return (
    <nav
      aria-label="Mailboxes"
      className="flex h-full w-[212px] shrink-0 flex-col overflow-y-auto bg-sidebar pb-3"
    >
      {/* Spacer for the inset traffic lights. The window is frameless, so
          without this the first row sits underneath the close button. */}
      <div className="drag h-[52px] shrink-0" />

      {accounts.map((account) => {
        const counts = countsByAccount[account.id] ?? []
        const byId = new Map(counts.map((c) => [c.labelId, c]))

        return (
          <section key={account.id} className="px-2 pb-2">
            <h2 className="truncate px-2 pb-1 pt-2 text-2xs font-medium text-text-secondary">
              {account.email}
            </h2>
            <div className="flex flex-col gap-px">
              {MAILBOX_ORDER.map((labelId) => (
                <MailboxRow
                  key={labelId}
                  labelId={labelId}
                  counts={byId.get(labelId)}
                  active={selected?.accountId === account.id && selected.labelId === labelId}
                  onClick={() => onSelect(account.id, labelId)}
                />
              ))}
            </div>
            {account.needsReauth && (
              <p className="mt-1 px-2 text-2xs text-danger">Sign in again to keep syncing</p>
            )}
          </section>
        )
      })}
    </nav>
  )
}
