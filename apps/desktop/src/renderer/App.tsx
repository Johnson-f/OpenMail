import { useCallback, useEffect, useMemo, useState } from 'react'
import { PanelLeft, PenSquare, Search } from 'lucide-react'
import type {
  AccountRow,
  MailboxCounts,
  MessageWithLabels,
  SyncStatus,
  ThreadSummary,
} from '@gmail/core'
import { cn } from '@gmail/ui'
import { MAILBOX_ORDER, Sidebar } from './components/Sidebar'
import { MessageList } from './components/MessageList'
import { ReadingPane } from './components/ReadingPane'

const MAILBOX_LABELS: Record<string, string> = {
  IMPORTANT: 'Important',
  INBOX: 'Inbox',
  DRAFT: 'Drafts',
  SENT: 'Sent',
  SPAM: 'Junk',
  TRASH: 'Trash',
  STARRED: 'Starred',
}

function SignIn({ onDone }: { onDone: (id: number) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 pb-16">
        <div>
          <h1 className="text-center text-xl font-semibold tracking-tight">Mail</h1>
          <p className="mt-1 text-center text-sm text-text-secondary">
            Connect a Google account to get started.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            setError(null)
            setBusy(true)
            void window.mail.signIn().then(onDone, (e: Error) => {
              setError(e.message)
              setBusy(false)
            })
          }}
          className="rounded-control bg-accent px-4 py-1.5 text-sm font-medium text-accent-contrast hover:brightness-110 active:brightness-95 disabled:opacity-50"
        >
          {busy ? 'Waiting for your browser…' : 'Add Account'}
        </button>
        {error && <p className="max-w-sm text-center text-xs text-danger">{error}</p>}
      </div>
    </div>
  )
}

export function App() {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [counts, setCounts] = useState<Record<number, MailboxCounts[]>>({})
  const [selected, setSelected] = useState<{ accountId: number; labelId: string } | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithLabels[]>([])
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [query, setQuery] = useState('')

  const loadAccounts = useCallback(async () => {
    const list = await window.mail.listAccounts()
    setAccounts(list)
    const first = list[0]
    if (first && !selected) setSelected({ accountId: first.id, labelId: 'INBOX' })
    return list
  }, [selected])

  useEffect(() => {
    void loadAccounts()
    // Intentionally once: adding loadAccounts re-runs this on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll the local database. Sync writes to it in the background, so the UI
  // stays a pure reader — it never waits on Gmail for anything it displays.
  const refresh = useCallback(async () => {
    if (!selected) return
    const { accountId, labelId } = selected

    const [nextThreads, nextCounts, nextStatus] = await Promise.all([
      window.mail.listThreads(accountId, labelId, 200),
      window.mail.mailboxCounts(accountId, [...MAILBOX_ORDER]),
      window.mail.syncStatus(accountId),
    ])

    setThreads(nextThreads)
    setStatus(nextStatus)
    setCounts((prev) => ({ ...prev, [accountId]: nextCounts }))
  }, [selected])

  useEffect(() => {
    void refresh()
    const handle = setInterval(() => void refresh(), 3000)
    return () => clearInterval(handle)
  }, [refresh])

  // Opening a thread marks it read locally and queues the change for upload.
  useEffect(() => {
    if (!selected || !threadId) {
      setMessages([])
      return
    }
    const { accountId } = selected
    void window.mail.threadMessages(accountId, threadId).then(async (msgs) => {
      setMessages(msgs)
      const unread = msgs.filter((m) => m.effectiveLabelIds.includes('UNREAD'))
      if (unread.length > 0) {
        await Promise.all(
          unread.map((m) => window.mail.modifyLabels(accountId, m.id, [], ['UNREAD'])),
        )
        void refresh()
      }
    })
  }, [selected, threadId, refresh])

  const act = async (add: string[], remove: string[]): Promise<void> => {
    if (!selected || messages.length === 0) return
    await Promise.all(
      messages.map((m) => window.mail.modifyLabels(selected.accountId, m.id, add, remove)),
    )
    setThreadId(null)
    void refresh()
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter(
      (t) =>
        t.subject.toLowerCase().includes(q) ||
        t.from.toLowerCase().includes(q) ||
        t.snippet.toLowerCase().includes(q),
    )
  }, [threads, query])

  if (accounts.length === 0) {
    return <SignIn onDone={() => void loadAccounts()} />
  }

  const account = accounts.find((a) => a.id === selected?.accountId)
  const mailboxName = MAILBOX_LABELS[selected?.labelId ?? 'INBOX'] ?? 'Mailbox'
  const unreadHere =
    counts[selected?.accountId ?? -1]?.find((c) => c.labelId === selected?.labelId)?.unread ?? 0

  const subtitle = status?.backfillComplete
    ? `${threads.length} conversations, ${unreadHere} unread`
    : `Downloading… ${status?.backfillFetched ?? 0} messages`

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <Sidebar
          accounts={accounts}
          countsByAccount={counts}
          selected={selected}
          onSelect={(accountId, labelId) => {
            setSelected({ accountId, labelId })
            setThreadId(null)
          }}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="drag flex h-0 shrink-0" />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1">
            <MessageList
              title={`${mailboxName} — ${account?.email ?? ''}`}
              subtitle={subtitle}
              threads={visible}
              selectedId={threadId}
              loading={!status?.backfillComplete}
              onSelect={setThreadId}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {/* Window-level controls sit above the reading pane, matching
                  Mail: sidebar toggle and compose on the left, search right. */}
              <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-separator bg-surface px-3">
                <div className="no-drag flex items-center gap-1">
                  <button
                    title={sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
                    onClick={() => setSidebarOpen((v) => !v)}
                    className="flex size-[28px] items-center justify-center rounded-control text-text-secondary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                  >
                    <PanelLeft className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    title="New Message"
                    className="flex size-[28px] items-center justify-center rounded-control text-text-secondary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                  >
                    <PenSquare className="size-4" strokeWidth={1.75} />
                  </button>
                </div>

                <div className="no-drag ml-auto flex w-[260px] items-center gap-1.5 rounded-control bg-black/[0.05] px-2 py-[3px] dark:bg-white/[0.08]">
                  <Search className="size-3.5 shrink-0 text-text-tertiary" strokeWidth={2} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-tertiary"
                  />
                </div>

                {status && !status.backfillComplete && (
                  <span className="no-drag shrink-0 text-2xs text-text-secondary">
                    {status.backfillFetched}
                  </span>
                )}
                {status && status.pendingUploads > 0 && (
                  <span
                    title="Changes waiting to upload"
                    className={cn(
                      'no-drag shrink-0 rounded-full bg-accent-fill px-2 py-0.5 text-2xs text-accent',
                    )}
                  >
                    {status.pendingUploads} pending
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1">
                <ReadingPane
                  messages={messages}
                  mailboxName={mailboxName}
                  onArchive={() => void act([], ['INBOX'])}
                  onTrash={() => void act(['TRASH'], ['INBOX'])}
                  onJunk={() => void act(['SPAM'], ['INBOX'])}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
