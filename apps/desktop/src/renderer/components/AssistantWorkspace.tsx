import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, ExternalLink, LoaderCircle, Plus, X } from 'lucide-react'
import type { AccountRow } from '@gmail/core'

type Answer = Awaited<ReturnType<typeof window.mail.assistantAsk>>
export type AssistantSeed = { question: string; threadIds?: string[] }

export function AssistantWorkspace({
  accounts,
  defaultAccountId,
  seed,
  onSeedConsumed,
  onOpenSource,
}: {
  accounts: AccountRow[]
  defaultAccountId: number | null
  seed?: AssistantSeed
  onSeedConsumed?: () => void
  onOpenSource: (accountId: number, threadId: string) => void
}) {
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [input, setInput] = useState(seed?.question ?? '')
  const [threadIds, setThreadIds] = useState<string[]>(seed?.threadIds ?? [])
  const [conversationId, setConversationId] = useState<string>()
  const [answers, setAnswers] = useState<Array<{ question: string; result: Answer }>>([])
  const [conversations, setConversations] = useState<Awaited<ReturnType<typeof window.mail.assistantConversations>>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (seed) {
      setInput(seed.question)
      setThreadIds(seed.threadIds ?? [])
      onSeedConsumed?.()
    }
  }, [seed, onSeedConsumed])
  useEffect(() => {
    window.mail.assistantConversations().then(setConversations, () => undefined)
  }, [conversationId])
  const accountIds = useMemo(
    () => (scope === 'all' ? accounts.map((account) => account.id) : defaultAccountId ? [defaultAccountId] : []),
    [accounts, defaultAccountId, scope],
  )

  const submit = async () => {
    const question = input.trim()
    if (!question || accountIds.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.mail.assistantAsk({
        conversationId,
        question,
        accountIds,
        ...(threadIds.length ? { threadIds } : {}),
      })
      setConversationId(result.conversationId)
      setAnswers((current) => [...current, { question, result }])
      setInput('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const openConversation = async (id: string) => {
    if (!id || busy) return
    setError(null)
    try {
      const messages = await window.mail.assistantConversationMessages(id)
      const turns: Array<{ question: string; result: Answer }> = []
      let question = ''
      for (const message of messages) {
        if (message.role === 'user' && 'text' in message.content) question = message.content.text
        else if (message.role === 'assistant' && 'answer' in message.content) {
          turns.push({ question, result: { ...message.content, conversationId: id } })
        }
      }
      setConversationId(id)
      setAnswers(turns)
      setThreadIds([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const latest = answers.at(-1)?.result
  return (
    <div className="flex h-full min-w-0 flex-1 bg-surface">
      <section className="flex min-w-0 flex-1 flex-col border-r border-separator">
        <header className="drag flex h-[52px] items-center border-b border-separator px-4">
          <h1 className="text-sm font-semibold">Assistant</h1>
          <select
            aria-label="Past conversations"
            value={conversationId ?? ''}
            onChange={(event) => void openConversation(event.target.value)}
            className="no-drag ml-auto max-w-48 rounded-control border border-separator bg-surface px-2 py-1 text-xs"
          >
            <option value="">{conversations.length ? 'New conversation' : 'No past conversations'}</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Assistant account scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'current' | 'all')}
            className="no-drag ml-2 rounded-control border border-separator bg-surface px-2 py-1 text-xs"
          >
            <option value="current">Current account</option>
            <option value="all">All accounts</option>
          </select>
          {threadIds.length > 0 && (
            <button
              type="button"
              onClick={() => setThreadIds([])}
              title="Questions only search the selected thread. Remove to search all mail."
              className="no-drag ml-2 flex items-center gap-1 rounded-full bg-accent-fill px-2 py-1 text-2xs text-accent hover:brightness-95"
            >
              Thread context
              <X className="size-3" aria-label="Remove thread context" />
            </button>
          )}
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {answers.length === 0 && (
            <div className="mx-auto mt-20 max-w-md text-center">
              <h2 className="text-lg font-semibold">Ask anything</h2>
              <p className="mt-2 text-sm text-text-secondary">
                Chat normally, ask about your mail with citations, or request a permission-controlled action.
              </p>
            </div>
          )}
          {answers.map(({ question, result }) => (
            <div key={`${result.conversationId}:${question}`} className="space-y-3">
              <p className="ml-auto max-w-[75%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-white">
                {question}
              </p>
              <div className="max-w-2xl whitespace-pre-wrap text-sm leading-relaxed">{result.answer}</div>
              {result.actions?.map((action) => (
                <div
                  key={action.callId}
                  className="max-w-2xl rounded-lg border border-separator bg-surface-raised px-3 py-2 text-xs"
                >
                  <span className="font-medium capitalize">{action.name.replaceAll('_', ' ')}</span>
                  <span className="ml-2 text-text-secondary">{action.status}</span>
                  <p className="mt-1 text-text-secondary">{action.message}</p>
                </div>
              ))}
              {result.verified === false && (
                <p className="max-w-2xl rounded-control bg-flag/10 px-3 py-2 text-2xs text-flag">
                  This answer could not be tied to your mail. Check the sources before relying on it.
                </p>
              )}
              {result.degraded && <p className="text-2xs text-flag">Reranking unavailable; showing local fused results.</p>}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <LoaderCircle className="size-4 animate-spin" /> Thinking…
            </div>
          )}
          {error && <p className="rounded-control bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="m-4 flex items-end gap-2 rounded-xl border border-separator p-2"
        >
          <button
            type="button"
            title="New conversation"
            onClick={() => {
              setConversationId(undefined)
              setAnswers([])
              setThreadIds([])
            }}
          >
            <Plus className="size-4 text-text-secondary" />
          </button>
          <textarea
            aria-label="Ask about your mail"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={2}
            placeholder="Ask about your mail or request an action…"
            className="min-h-10 flex-1 resize-none bg-transparent text-sm outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex size-7 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
      </section>
      <aside className="hidden w-[340px] shrink-0 flex-col bg-surface-raised lg:flex">
        <header className="flex h-[52px] items-center border-b border-separator px-4 text-sm font-semibold">Evidence</header>
        <div className="space-y-2 overflow-y-auto p-3">
          {latest?.evidence.map((item, index) => (
            <button
              key={item.citationId}
              onClick={() => onOpenSource(item.accountId, item.threadId)}
              className="w-full rounded-lg border border-separator bg-surface p-3 text-left hover:border-accent"
            >
              <span className="flex items-center gap-2 text-xs font-medium">
                <span className="flex size-5 items-center justify-center rounded-full bg-accent-fill text-2xs text-accent">
                  {index + 1}
                </span>
                {String(item.metadata.subject ?? '(no subject)')}
                <ExternalLink className="ml-auto size-3 text-text-tertiary" />
              </span>
              <span className="mt-2 line-clamp-3 text-2xs text-text-secondary">{item.content}</span>
              <span className="mt-2 block text-2xs text-text-tertiary">Account {item.accountId} · {item.sourceLocation}</span>
            </button>
          ))}
          {!latest?.evidence.length && <p className="p-4 text-center text-xs text-text-tertiary">Sources appear here.</p>}
        </div>
      </aside>
    </div>
  )
}
