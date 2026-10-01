import { useEffect, useState } from 'react'
import type { IndexingStatus } from '../../main/ipc/contract'

export function KnowledgeView() {
  const [status, setStatus] = useState<IndexingStatus | null>(null)
  useEffect(() => {
    const refresh = () => void window.mail.indexingStatus().then(setStatus)
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [])
  const retry = () => void window.mail.retryFailedIndexing().then(() => window.mail.indexingStatus().then(setStatus))
  return (
    <div className="h-full overflow-y-auto bg-surface p-6 pt-[64px]">
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold">Knowledge</h1>
        <p className="mt-1 text-sm text-text-secondary">Your local, rebuildable semantic mail index.</p>
        <div className="mt-6 grid grid-cols-3 gap-3">
          <Metric label="Indexed chunks" value={status?.indexedChunks ?? 0} />
          <Metric label="Pending events" value={status?.pendingEvents ?? 0} />
          <Metric label="Generation" value={status?.activeGeneration ?? '—'} />
        </div>
        {status?.needsKey && (
          <p className="mt-4 rounded-lg bg-surface-raised p-3 text-xs text-text-secondary">
            Add a Voyage API key in provider settings to start indexing.
          </p>
        )}
        {status && status.waitingForSignIn > 0 && (
          <p className="mt-4 rounded-lg bg-surface-raised p-3 text-xs text-text-secondary">
            {status.waitingForSignIn} {status.waitingForSignIn === 1 ? 'message is' : 'messages are'} waiting for an
            account to be signed in again. Indexing resumes automatically after you sign in.
          </p>
        )}
        {status && status.failedJobs > 0 && (
          <div className="mt-4 flex items-center justify-between rounded-lg bg-danger/10 p-3 text-xs text-danger">
            <span>{status.failedJobs} {status.failedJobs === 1 ? 'message' : 'messages'} failed to index.</span>
            <button type="button" className="rounded-md border border-danger/40 px-2 py-1" onClick={retry}>
              Retry failed
            </button>
          </div>
        )}
        {status?.lastError && <p className="mt-4 rounded-lg bg-danger/10 p-3 text-xs text-danger">{status.lastError}</p>}
        <p className="mt-5 text-xs text-text-secondary">
          Email text and attachments stay on this Mac. Chunks are sent to Voyage to create vectors; only selected evidence is sent to the brain.
        </p>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border border-separator p-4"><strong className="block text-lg">{value}</strong><span className="text-xs text-text-secondary">{label}</span></div>
}
