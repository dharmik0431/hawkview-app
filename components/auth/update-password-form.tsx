'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/lib/auth/supabase'
import { readableAuthError } from '@/lib/auth/auth-errors'

export function UpdatePasswordForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [hasSession, setHasSession] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState(false)
  // Identity generation: bumped whenever the authenticated subject changes, so
  // a continuation dispatched for one account can refuse to act once another
  // account is active. It does not cancel an already dispatched mutation; it
  // only stops the follow-on work.
  const generation = useRef(0)
  const subjectRef = useRef<string | null>(null)
  // Events outrank the initial probe in BOTH directions, whichever resolves last.
  const eventSeen = useRef(false)
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // setIsLoading is asynchronous, so the submit button's disabled attribute is
  // not a guard: a second submit dispatched before React re-renders still runs
  // the handler. A ref updates synchronously and does.
  const submitting = useRef(false)
  // Separate from `submitting` on purpose. Once the password HAS changed the
  // form is finished: sign-out and the redirect are in motion, and a further
  // submit would mutate the password again and navigate over the pending one.
  // Widening `submitting` to cover that window is what produced the v6 lock,
  // because it also covered the failure paths that must stay retryable.
  const completed = useRef(false)
  // Component lifetime, readable from the submit continuation. The effect's own
  // `active` flag is effect-local and cannot be seen by an await that started
  // in a handler, so an unmounted form could still dispatch side effects.
  const mounted = useRef(true)
  // The operation's OWN sign-out legitimately ends the subject. That specific
  // transition must not invalidate the attempt that caused it, while a switch
  // to a different account, A->B->A, unmount and unrelated stale work still do.
  // Holds the generation the attempt was in when it armed, not a bare flag: a
  // later null must not revive an attempt that a replacement identity already
  // invalidated. It is ONE SHOT — the first subject change while armed clears
  // it, whatever that change is.
  const armedAtGeneration = useRef<number | null>(null)
  const ownSignOutGeneration = useRef<number | null>(null)

  useEffect(() => {
    if (!supabase) {
      setError('HawkView authentication is not configured.')
      setIsLoading(false)
      return
    }

    let active = true
    mounted.current = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        // A newer auth event has already decided this; a late probe must not
        // overwrite it, in either direction.
        if (active && !eventSeen.current) setHasSession(Boolean(data.session))
      })
      .catch(() => {
        // Without this the probe's rejection leaves isLoading true forever and
        // nothing is shown at all. Loading has to settle even when it fails.
        if (active && !eventSeen.current) {
          setError('HawkView could not check this password reset link. Reload the page to try again.')
        }
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      eventSeen.current = true
      const subject = (session as { user?: { id?: string } } | null)?.user?.id ?? null
      if (subject !== subjectRef.current) {
        subjectRef.current = subject
        generation.current += 1
        const armed = armedAtGeneration.current
        if (armed !== null) {
          armedAtGeneration.current = null
          // Accept only a transition DIRECTLY from the armed generation to a
          // signed-out state. An intervening replacement identity advances the
          // generation first, so this comparison fails and stays failed.
          if (subject === null && armed === generation.current - 1) {
            ownSignOutGeneration.current = generation.current
          }
        }
      }
      // Session authority, not an event label: PASSWORD_RECOVERY carrying a
      // null session is not a session, and must not grant the ability to set
      // a password.
      setHasSession(Boolean(session))
      setIsLoading(false)
    })

    return () => {
      active = false
      mounted.current = false
      data.subscription.unsubscribe()
      if (redirectTimer.current) clearTimeout(redirectTimer.current)
    }
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting.current || completed.current) return
    setError('')

    if (!supabase || !hasSession) {
      setError('This password reset link is invalid or has expired.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsLoading(true)
    const dispatchedFor = generation.current
    // One ownership test for the whole operation: still mounted AND still the
    // identity this attempt was dispatched for. Every post-await effect —
    // success, error, finally, timer scheduling and timer firing — is gated on
    // it, because any one of them acts on whoever is present now.
    submitting.current = true
    armedAtGeneration.current = null
    ownSignOutGeneration.current = null
    const owns = () =>
      mounted.current &&
      (generation.current === dispatchedFor ||
        generation.current === ownSignOutGeneration.current)

    let updateError: unknown = null
    try {
      // updateUser can REJECT as well as return an error; handling only the
      // returned shape skips setIsLoading(false) and shows nothing at all.
      const result = await supabase.auth.updateUser({ password })
      updateError = result.error
    } catch (thrown) {
      updateError = thrown
    } finally {
      // Release here, not after sign-out: the guard exists to stop a second
      // submit while THIS update is in flight. Releasing only on the success
      // path left every early return below — obsolete update, settled failure,
      // identity change — holding the lock forever, so a rejected password
      // could never be retried.
      submitting.current = false
      if (owns()) setIsLoading(false)
    }

    if (!owns()) return

    if (updateError) {
      setError(readableAuthError(updateError))
      return
    }

    // The password HAS changed. A failure past this point is not an update
    // failure and must not be reported as one, nor may it promise a navigation
    // that will not happen.
    if (generation.current !== dispatchedFor) {
      // Another account became active while this update was in flight. Signing
      // out now would end THAT account's session, and reporting success would
      // report it on their screen. The mutation already happened; this
      // continuation simply stops.
      return
    }
    completed.current = true
    setSuccess(true)
    let signOutError: unknown = null
    try {
      // signOut can RETURN an error as well as throw one; ignoring the
      // returned shape promises a navigation that never happens.
      armedAtGeneration.current = generation.current
      const result = await supabase.auth.signOut()
      signOutError = result?.error ?? null
    } catch (thrown) {
      signOutError = thrown
    } finally {
      // Settled: a null arriving later belongs to something else, not to this
      // attempt, so the expectation must not survive the call that raised it.
      armedAtGeneration.current = null
    }

    // Scheduling a timer after unmount or an identity change would navigate on
    // someone else's behalf; clearing already-existing timers is not enough,
    // the new one must never be created.
    if (!owns()) return

    if (signOutError) {
      setSignOutFailed(true)
      return
    }
    redirectTimer.current = setTimeout(() => {
      // Re-checked at firing: the identity can change during the delay.
      if (owns()) router.replace('/login')
    }, 1200)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Choose a new password
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Enter a new password for your HawkView account.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-medium text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div role="status" className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            {signOutFailed
              ? 'Password updated. Signing you out did not complete — use Back to login to continue.'
              : 'Password updated. Returning to login...'}
          </span>
        </div>
      )}

      {!success && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input id="confirm-password" type="password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
          </div>
          <Button type="submit" className="h-11 w-full" disabled={isLoading || !hasSession}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
          </Button>
        </form>
      )}

      <div className="text-center text-xs">
        <Link href="/login" className="font-semibold text-blue-600 hover:text-blue-500">
          Back to login
        </Link>
      </div>
    </div>
  )
}
