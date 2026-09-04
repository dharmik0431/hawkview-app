'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api/client'
import { parseMailboxInvestigation, type MailboxInvestigation as Investigation } from '@/lib/api/mailbox-investigation'

/** Sensitive identity lives only in this explicitly opened, auth-scoped view—not query cache. */
export function MailboxInvestigation({ tenantId, findingId }: { tenantId: string; findingId: string }) {
  const [result, setResult] = useState<Investigation | null>(null)
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function investigate() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setChecking(true)
    setResult(null)
    setFailed(false)
    try {
      const raw = await apiClient.get<unknown>(`/api/tenants/${encodeURIComponent(tenantId)}/identity-signals/findings/${encodeURIComponent(findingId)}/mailbox-investigation`, { signal: controller.signal, cache: 'no-store' })
      if (!controller.signal.aborted) setResult(parseMailboxInvestigation(raw, tenantId))
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }
  return (
    <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 text-xs dark:border-slate-800">
      <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => void investigate()}>
        {checking ? 'Checking mailbox…' : 'Investigate affected mailbox'}
      </Button>
      <div aria-live="polite" aria-busy={checking}>
        {checking && <p>Checking current authorized inventory.</p>}
        {failed && <p role="alert">Mailbox investigation could not be loaded. Check your access and try again.</p>}
        {result?.status === 'UNAVAILABLE' && <p>Current mailbox evidence is unavailable or insufficient. Refresh collection and retry; no mailbox identity is inferred.</p>}
        {result?.mailbox && <div className="space-y-1 break-words">
          <p><strong>Affected mailbox:</strong> {result.mailbox.label}</p>
          <p>Inventory observed: {new Date(result.mailbox.observedAt).toLocaleString()}</p>
          <Link prefetch={false} className="inline-block text-blue-700 underline focus-visible:outline focus-visible:outline-2 dark:text-blue-300" href={result.mailbox.inventoryPath}>Open Exchange inventory</Link>
          <Button type="button" variant="ghost" size="sm" onClick={() => setResult(null)}>Hide mailbox details</Button>
        </div>}
      </div>
    </div>
  )
}
