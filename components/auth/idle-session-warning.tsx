'use client'

import { useState } from 'react'

export function IdleSessionWarning({ remainingSeconds, staySignedIn }: {
  remainingSeconds: number
  staySignedIn: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const extend = async () => {
    setBusy(true)
    setError(false)
    try { await staySignedIn() } catch { setError(true) }
    finally { setBusy(false) }
  }
  return (
    <aside role="alert" className="fixed bottom-4 left-1/2 z-[100] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-amber-500 bg-background p-4 shadow-lg">
      <p className="font-semibold">Your session is about to end</p>
      <p className="mt-1 text-sm">You have been inactive. You will be signed out in {Math.max(1, Math.ceil(remainingSeconds / 60))} minute(s).</p>
      {error && <p className="mt-2 text-sm">We could not extend your session. Check your connection and try again.</p>}
      <button type="button" disabled={busy} onClick={() => void extend()} className="mt-3 rounded bg-primary px-3 py-2 text-sm text-primary-foreground focus-visible:outline focus-visible:outline-2 disabled:opacity-60">
        {busy ? 'Keeping you signed in…' : 'Stay signed in'}
      </button>
    </aside>
  )
}
