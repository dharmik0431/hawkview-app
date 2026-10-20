'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiClient } from '@/lib/api/client'

type Check = { id: string; title: string; source: string; expected: string; guidance: string }
type Baseline = { id: string; name: string; checkIds: string[]; updatedAt: string }
type Result = Check & { outcome: 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS'; observed: string; observedAt: string | null; reason: string | null }
type View = {
  catalog: Check[]
  starter: { id: string; name: string; checkIds: string[] }
  baselines: Baseline[]
  assignment: { baselineId: string; assignedAt: string } | null
  results: Result[]
  summary: { selected: number; met: number; needsAction: number; unableToAssess: number }
  assessedAt: string
  canManage: boolean
  evidenceNote: string
}

const statusStyle = {
  MET: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  NEEDS_ACTION: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  UNABLE_TO_ASSESS: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
}
const statusText = { MET: 'Meets requirement', NEEDS_ACTION: 'Needs review', UNABLE_TO_ASSESS: 'Unable to assess' }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

export default function SecurityRequirementsPanel({ tenantId }: { tenantId: string }) {
  const baseUrl = `/api/tenants/${encodeURIComponent(tenantId)}/security-requirements`
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [checkIds, setCheckIds] = useState<string[]>([])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiClient.get<View>(baseUrl, { signal })
      if (!signal?.aborted) { setView(next); setError(null) }
    } catch (caught) {
      if (!signal?.aborted) setError(errorMessage(caught))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    const controller = new AbortController()
    setView(null)
    setLoading(true)
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const selected = view?.baselines.find((baseline) => baseline.id === view.assignment?.baselineId)
  const beginCreate = (useStarter: boolean) => {
    setEditingId(null)
    setName(useStarter ? 'My security standard' : '')
    setCheckIds(useStarter ? [...(view?.starter.checkIds ?? [])] : [])
    setError(null)
    setFormOpen(true)
  }
  const beginEdit = (baseline: Baseline) => {
    setEditingId(baseline.id)
    setName(baseline.name)
    setCheckIds([...baseline.checkIds])
    setError(null)
    setFormOpen(true)
  }
  const save = async () => {
    if (!view || saving) return
    setSaving(true)
    setError(null)
    try {
      const payload = { name, checkIds }
      if (editingId) await apiClient.patch(`${baseUrl}/baselines/${encodeURIComponent(editingId)}`, payload)
      else await apiClient.post(`${baseUrl}/baselines`, payload)
      setFormOpen(false)
      await load()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally { setSaving(false) }
  }
  const assign = async (baselineId: string | null) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await apiClient.put(`${baseUrl}/assignment`, { baselineId })
      await load()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally { setSaving(false) }
  }

  if (loading) return <div className="rounded-xl border bg-white p-6 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">Loading security requirements…</div>
  if (!view) return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">{error || 'Security requirements are unavailable.'} <button type="button" onClick={() => void load()} className="ml-2 underline">Retry</button></div>

  return <div className="space-y-5">
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/40">
      <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Your MSP standard</div>
      <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-white">{selected?.name ?? 'No baseline assigned to this tenant'}</h2>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{selected
        ? 'Only the checks your MSP selected in this baseline count toward this tenant’s review. HawkView does not change Microsoft settings.'
        : 'Choose or create a baseline below. HawkView’s starter is available as a template, but it is not your chosen standard until you create and assign one.'}</p>
      {selected && <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <span className="rounded-md bg-white px-3 py-1.5 dark:bg-slate-900">{view.summary.met} meet requirements</span>
        <span className="rounded-md bg-white px-3 py-1.5 dark:bg-slate-900">{view.summary.needsAction} need review</span>
        <span className="rounded-md bg-white px-3 py-1.5 dark:bg-slate-900">{view.summary.unableToAssess} unable to assess</span>
      </div>}
    </div>

    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900" aria-labelledby="baseline-library-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 id="baseline-library-title" className="font-semibold">Baseline library</h3><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Create named standards from offered checks, then apply one to this tenant.</p></div>
        {view.canManage && <button type="button" onClick={() => beginCreate(false)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Create baseline</button>}
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-900 dark:bg-blue-950/20">
          <div><div className="font-medium">HawkView starter <span className="ml-1 text-xs font-normal text-blue-700">Template</span></div><div className="text-xs text-slate-600 dark:text-slate-300">{view.starter.checkIds.length} suggested checks · Not assigned automatically</div></div>
          {view.canManage && <button type="button" onClick={() => beginCreate(true)} className="rounded-lg border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-800 dark:text-blue-200">Create from starter</button>}
        </div>
        {view.baselines.map((baseline) => <div key={baseline.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 dark:border-slate-700">
          <div><div className="font-medium">{baseline.name} {baseline.id === selected?.id && <span className="ml-1 text-xs text-emerald-700">Assigned here</span>}</div><div className="text-xs text-slate-600 dark:text-slate-300">{baseline.checkIds.length} selected checks</div></div>
          {view.canManage && <div className="flex gap-2">
            <button type="button" onClick={() => beginEdit(baseline)} className="rounded-lg border px-3 py-1.5 text-sm dark:border-slate-600">Edit</button>
            {baseline.id === selected?.id
              ? <button type="button" disabled={saving} onClick={() => void assign(null)} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600">Unassign</button>
              : <button type="button" disabled={saving} onClick={() => void assign(baseline.id)} className="rounded-lg border border-blue-300 px-3 py-1.5 text-sm text-blue-700 disabled:opacity-50 dark:text-blue-300">Apply to tenant</button>}
          </div>}
        </div>)}
      </div>
    </section>

    {formOpen && view.canManage && <section className="rounded-xl border border-blue-300 bg-white p-5 dark:bg-slate-900" aria-labelledby="baseline-form-title">
      <h3 id="baseline-form-title" className="font-semibold">{editingId ? 'Edit MSP baseline' : 'Create MSP baseline'}</h3>
      {editingId && <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Edits to this named baseline affect every tenant where it is assigned.</p>}
      <label className="mt-4 block text-sm font-medium" htmlFor="baseline-name">Name</label>
      <input id="baseline-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-950" placeholder="For example, Standard customer controls" />
      <fieldset className="mt-4 space-y-2"><legend className="mb-2 text-sm font-medium">Checks to require</legend>
        {view.catalog.map((check) => <label key={check.id} className="flex cursor-pointer gap-3 rounded-lg border p-3 dark:border-slate-700">
          <input type="checkbox" checked={checkIds.includes(check.id)} onChange={(event) => setCheckIds((current) => event.target.checked ? [...current, check.id] : current.filter((id) => id !== check.id))} className="mt-1" />
          <span><span className="block font-medium">{check.title}</span><span className="block text-sm text-slate-600 dark:text-slate-300">{check.expected}</span></span>
        </label>)}
      </fieldset>
      <div className="mt-4 flex gap-2"><button type="button" disabled={saving || !name.trim() || !checkIds.length} onClick={() => void save()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save baseline'}</button><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm dark:border-slate-700">Cancel</button></div>
    </section>}

    <section aria-labelledby="requirements-results-title" className="space-y-3">
      <div><h3 id="requirements-results-title" className="text-lg font-semibold">Selected requirements</h3><p className="text-sm text-slate-600 dark:text-slate-300">{view.evidenceNote}</p></div>
      {!selected && <div className="rounded-xl border border-dashed p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">Assign an MSP baseline to see its assessment for this tenant.</div>}
      {view.results.map((result) => <article key={result.id} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-semibold">{result.title}</h4><span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyle[result.outcome]}`}>{statusText[result.outcome]}</span></div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">Expected</dt><dd>{result.expected}</dd></div><div><dt className="text-slate-500">Observed</dt><dd>{result.observed}</dd></div><div><dt className="text-slate-500">Evidence source</dt><dd>{result.source}</dd></div><div><dt className="text-slate-500">Collected</dt><dd>{result.observedAt ? new Date(result.observedAt).toLocaleString() : 'No usable evidence'}</dd></div></dl>
        {result.reason && <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{result.reason}</p>}
        {result.outcome === 'NEEDS_ACTION' && <p className="mt-3 text-sm font-medium">Suggested next step: {result.guidance}</p>}
      </article>)}
    </section>
  </div>
}
