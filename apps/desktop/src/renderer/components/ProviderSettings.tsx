import { useEffect, useState } from 'react'
import type { ProviderName, ProviderStatus } from '../../main/ipc/contract'
import type { WritingProfileRecord } from '../../main/ipc/contract'

export function ProviderSettings({ accountId }: { accountId: number | null }) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [profiles, setProfiles] = useState<WritingProfileRecord[]>([])
  const refresh = () => void window.mail.providerStatus().then(setStatuses)
  useEffect(refresh, [])
  const refreshProfiles = () => {
    if (accountId) void window.mail.writingProfiles(accountId).then(setProfiles)
  }
  useEffect(refreshProfiles, [accountId])
  return (
    <div className="h-full overflow-y-auto bg-surface p-6 pt-[64px]">
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold">AI Providers</h1>
        <p className="mt-1 text-sm text-text-secondary">Keys are encrypted locally and never shown again.</p>
        <div className="mt-6 space-y-3">
          {(['voyage', 'perplexity'] as const).map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              configured={statuses.find((status) => status.provider === provider)?.configured ?? false}
              onChanged={refresh}
            />
          ))}
        </div>
        <div className="mt-10 flex items-center"><div><h2 className="font-semibold">Writing profile</h2><p className="text-xs text-text-secondary">Local voice and relationship style learned from Sent mail.</p></div>{accountId && <button onClick={() => void window.mail.rebuildWritingProfiles(accountId).then(setProfiles)} className="ml-auto rounded-control bg-accent px-3 py-1.5 text-xs text-white">Rebuild</button>}</div>
        <div className="mt-3 space-y-2">{profiles.map((record) => <div key={record.relationshipKey} className="flex items-center rounded-lg border border-separator p-3"><div><strong className="block text-sm">{record.relationshipKey === '*' ? 'Global style' : record.relationshipKey}</strong><span className="text-2xs text-text-secondary">Version {record.version} · {String(record.profile.tone ?? '')} · {String(record.profile.formality ?? '')}</span></div><button onClick={() => { if (!accountId) return; void window.mail.toggleWritingProfile(accountId, record.relationshipKey, !record.enabled).then(refreshProfiles) }} className="ml-auto text-xs text-accent">{record.enabled ? 'Disable' : 'Enable'}</button></div>)}</div>
        {accountId && profiles.length > 0 && <div className="mt-3 flex gap-2"><button onClick={() => void window.mail.exportWritingProfiles(accountId).then((value) => navigator.clipboard.writeText(value))} className="rounded-control border border-separator px-3 py-1.5 text-xs">Copy export</button><button onClick={() => void window.mail.resetWritingProfiles(accountId).then(() => setProfiles([]))} className="rounded-control border border-separator px-3 py-1.5 text-xs text-danger">Reset</button></div>}
      </div>
    </div>
  )
}

function ProviderRow({ provider, configured, onChanged }: { provider: ProviderName; configured: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true); setError(null)
    try { await window.mail.setProviderKey(provider, key); setKey(''); onChanged() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return (
    <div className="rounded-xl border border-separator p-4">
      <div className="flex items-center"><strong className="capitalize">{provider}</strong><span className={configured ? 'ml-auto text-xs text-accent' : 'ml-auto text-xs text-text-tertiary'}>{configured ? 'Connected' : 'Not configured'}</span></div>
      <div className="mt-3 flex gap-2">
        <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste API key" className="min-w-0 flex-1 rounded-control border border-separator bg-surface px-2 py-1.5 text-sm outline-none" />
        <button disabled={busy || !key.trim()} onClick={() => void save()} className="rounded-control bg-accent px-3 text-xs font-medium text-white disabled:opacity-40">Validate & save</button>
        {configured && <button onClick={() => void window.mail.removeProviderKey(provider).then(onChanged)} className="rounded-control border border-separator px-3 text-xs text-danger">Remove</button>}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
