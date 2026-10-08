import { buildHawkViewApiUrl } from '@/lib/config/public-runtime-config'
import { IdleSessionController, IdleSessionError, idleIdentity } from './idle-session'

export const idleSession = new IdleSessionController({
  now: () => Date.now(),
  read: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  write: (key, value) => { if (typeof window !== 'undefined') window.localStorage.setItem(key, value) },
  request: async (action, token) => {
    const suffix = action === 'status' ? '' : `/${action}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(buildHawkViewApiUrl(`/auth/session${suffix}`).href, {
        method: action === 'status' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const code = body?.error?.code ?? body?.code
        if (response.status === 401) throw new IdleSessionError(code ?? 'SESSION_REAUTHENTICATION_REQUIRED')
        throw new Error('HawkView could not verify your session. Try again.')
      }
      return body
    } finally { clearTimeout(timeout) }
  },
})

export async function requireIdleSession(token: string) {
  const identity = idleIdentity(token)
  if (!identity) throw new IdleSessionError('SESSION_REAUTHENTICATION_REQUIRED')
  await idleSession.ensure(identity, token)
}

export function rejectIdleSession(token: string) {
  const identity = idleIdentity(token)
  if (identity?.sessionId === idleSession.currentIdentity()?.sessionId) idleSession.expire()
}

export function assertIdleResponse(token: string) {
  const identity = idleIdentity(token)
  if (identity?.sessionId !== idleSession.currentIdentity()?.sessionId) throw new IdleSessionError('SESSION_CHANGED')
  if (!idleSession.check()) throw new IdleSessionError()
}

export function observeIdleIdentity(token: string | undefined) {
  if (!token) { idleSession.clear(); return true }
  const identity = idleIdentity(token)
  if (!identity) return false
  idleSession.bind(identity, token)
  return idleSession.check()
}

/** Browser input is a liveness signal, not proof of a human to the server. */
export function attachIdleSessionEvents() {
  let trailing: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let dirty = false
  let lastAttempt = 0
  let stopped = false
  const send = async () => {
    if (stopped || busy || !dirty || document.visibilityState !== 'visible') return
    dirty = false
    busy = true
    lastAttempt = Date.now()
    try { await idleSession.activity() } catch { /* Only accepted receipts extend the deadline. */ }
    finally { busy = false; schedule() }
  }
  const schedule = () => {
    if (stopped || !dirty || trailing) return
    trailing = setTimeout(() => { trailing = null; void send() }, Math.max(0, 1000 - (Date.now() - lastAttempt)))
  }
  const input = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible' || !idleSession.check()) return
    const phase = idleSession.view().phase
    if (phase !== 'active' && phase !== 'warning') return
    dirty = true
    schedule()
  }
  const resume = () => { if (document.visibilityState === 'visible') void idleSession.resume().catch(() => {}) }
  const visibility = () => {
    dirty = false
    if (document.visibilityState === 'hidden') idleSession.suspend()
    else resume()
  }
  const suspend = () => { dirty = false; idleSession.suspend() }
  const storage = (event: StorageEvent) => {
    if (event.key?.startsWith('hawkview:idle:v1:')) idleSession.tick()
  }
  // Programmatic scrolling also produces trusted scroll events. Wheel, key,
  // pointer and touch input cover human scrolling without counting auto-scroll.
  const events = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'touchmove', 'wheel']
  events.forEach((name) => document.addEventListener(name, input, { capture: true, passive: true }))
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('focus', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('pagehide', suspend)
  window.addEventListener('storage', storage)
  const timer = setInterval(() => idleSession.tick(), 1000)
  if (document.visibilityState === 'hidden') idleSession.suspend()
  return () => {
    stopped = true
    clearInterval(timer)
    if (trailing) clearTimeout(trailing)
    events.forEach((name) => document.removeEventListener(name, input, true))
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('focus', resume)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('pagehide', suspend)
    window.removeEventListener('storage', storage)
  }
}
