import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Pause, Play, RefreshCw, Trash2, WandSparkles } from 'lucide-react'
import type { AutomationSimulation, AutomationSpec } from '@gmail/agent'

type Record = Awaited<ReturnType<typeof window.mail.listAutomations>>[number]

export function AutomationCenter({ defaultAccountId }: { defaultAccountId: number | null }) {
  const [records, setRecords] = useState<Record[]>([])
  const [instruction, setInstruction] = useState('')
  const [spec, setSpec] = useState<AutomationSpec | null>(null)
  const [simulation, setSimulation] = useState<{ id: string; result: AutomationSimulation } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runs, setRuns] = useState<Array<{ id: string; status: string; lastError: string | null; updatedAt: number }>>([])
  const refresh = useCallback(() => void window.mail.listAutomations().then(setRecords), [])
  useEffect(refresh, [refresh])
  const build = async () => {
    if (!defaultAccountId) return
    setBusy(true); setError(null); setSimulation(null)
    try {
      setSpec(await window.mail.buildAutomation(instruction, defaultAccountId, Intl.DateTimeFormat().resolvedOptions().timeZone))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const simulate = async () => {
    if (!spec) return
    setBusy(true); setError(null)
    try { setSimulation(await window.mail.simulateAutomation(spec)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const activate = async () => {
    if (!spec || !simulation) return
    setBusy(true); setError(null)
    try { await window.mail.activateAutomation(spec, simulation.id); setSpec(null); setSimulation(null); setInstruction(''); refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return (
    <div className="h-full overflow-y-auto bg-surface p-6 pt-[64px]">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">Automations</h1>
        <p className="mt-1 text-sm text-text-secondary">Describe the outcome, simulate it locally, then approve its exact permissions.</p>
        <div className="mt-5 rounded-xl border border-separator p-4">
          <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3} placeholder="When an invoice arrives, label it Finance and remind me three days before it is due…" className="w-full resize-none bg-transparent text-sm outline-none" />
          <button disabled={busy || !instruction.trim() || !defaultAccountId} onClick={() => void build()} className="mt-3 flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{busy ? <LoaderCircle className="size-3 animate-spin" /> : <WandSparkles className="size-3" />} Build specification</button>
        </div>
        {error && <p className="mt-3 rounded-lg bg-danger/10 p-3 text-xs text-danger">{error}</p>}
        {spec && <div className="mt-4 rounded-xl border border-accent/40 p-4"><h2 className="font-semibold">{spec.name}</h2><pre className="selectable mt-3 max-h-64 overflow-auto rounded-lg bg-surface-raised p-3 text-2xs">{JSON.stringify(spec, null, 2)}</pre><button disabled={busy} onClick={() => void simulate()} className="mt-3 rounded-control border border-separator px-3 py-1.5 text-xs">Simulate on recent mail</button></div>}
        {simulation && <div className="mt-4 rounded-xl border border-flag/40 p-4"><h2 className="font-semibold">Simulation</h2><p className="mt-1 text-xs text-text-secondary">Would match {simulation.result.matchedMessageIds.length} messages.</p><div className="mt-3 space-y-2">{simulation.result.examples.map((example) => <div key={example.messageId} className="rounded-lg bg-surface-raised p-3 text-xs"><strong>{example.subject}</strong><span className="ml-2 text-text-secondary">{example.from}</span><p className="mt-1 text-2xs">Would: {example.proposedActions.join(', ')}</p></div>)}</div><pre className="selectable mt-3 max-h-48 overflow-auto rounded-lg bg-surface-raised p-3 text-2xs">Grant: {JSON.stringify(simulation.result.requiredGrant, null, 2)}</pre>{simulation.result.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-flag">{warning}</p>)}<button disabled={busy} onClick={() => void activate()} className="mt-3 rounded-control bg-accent px-3 py-1.5 text-xs text-white">Approve and activate</button></div>}
        <h2 className="mt-8 font-semibold">Installed automations</h2>
        <div className="mt-3 space-y-3">{records.map((record) => <AutomationRow key={record.versionId} record={record} onChanged={refresh} onRuns={(items) => setRuns(items)} />)}{records.length === 0 && <p className="py-10 text-center text-sm text-text-tertiary">No automations yet.</p>}</div>
        {runs.length > 0 && <div className="mt-6"><h2 className="font-semibold">Recent runs</h2><div className="mt-2 space-y-2">{runs.map((run) => <div key={run.id} className="rounded-lg border border-separator p-3 text-xs"><strong>{run.status}</strong><span className="ml-2 text-text-secondary">{new Date(run.updatedAt).toLocaleString()}</span>{run.lastError && <p className="mt-1 text-danger">{run.lastError}</p>}</div>)}</div></div>}
      </div>
    </div>
  )
}

function AutomationRow({ record, onChanged, onRuns }: { record: Record; onChanged: () => void; onRuns: (runs: Awaited<ReturnType<typeof window.mail.automationRuns>>) => void }) {
  const setStatus = (status: 'active' | 'paused' | 'archived') => void window.mail.setAutomationStatus(record.versionId, status).then(onChanged)
  return <div className="rounded-xl border border-separator p-4"><div className="flex items-center gap-2"><strong>{record.spec.name}</strong><span className="rounded-full bg-surface-raised px-2 py-0.5 text-2xs capitalize">{record.status}</span><span className="ml-auto text-2xs text-text-secondary">v{record.spec.version} · {record.spec.timezone}</span></div><p className="mt-2 text-xs text-text-secondary">{record.spec.trigger.type} → {record.spec.actions.map((action) => action.kind).join(', ')}</p><div className="mt-3 flex gap-2"><button onClick={() => void window.mail.runAutomationNow(record.versionId)} title="Run now" className="rounded-control border border-separator p-1.5"><RefreshCw className="size-3" /></button>{record.status === 'active' ? <button onClick={() => setStatus('paused')} title="Pause" className="rounded-control border border-separator p-1.5"><Pause className="size-3" /></button> : <button onClick={() => setStatus('active')} title="Resume" className="rounded-control border border-separator p-1.5"><Play className="size-3" /></button>}<button onClick={() => setStatus('archived')} title="Archive" className="rounded-control border border-separator p-1.5 text-danger"><Trash2 className="size-3" /></button><button onClick={() => void window.mail.automationRuns(record.versionId).then(onRuns)} className="rounded-control border border-separator px-2 text-2xs">Run history</button></div></div>
}
