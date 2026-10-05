'use client'

import { FormEvent, useState } from 'react'
import { KeyRound, Loader2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MfaEnrollment } from '@/components/auth/mfa-enrollment'
import { useAuth } from '@/components/providers/auth-provider'
import { supabase } from '@/lib/auth/supabase'

export function MfaAccessGate() {
  const { mfa, refreshMfa, refreshSession, signOut, currentIdentityToken } = useAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedFactorId, setSelectedFactorId] = useState<string | null>(null)

  class IdentityChanged extends Error {}

  const finish = async (dispatchedFor?: string) => {
    const owns = () => dispatchedFor === undefined || currentIdentityToken() === dispatchedFor
    await refreshMfa()
    // Re-checked BETWEEN the awaits: the account can change while refreshMfa is
    // in flight, and starting refreshSession then would read the new identity's
    // session on the old attempt's behalf.
    if (!owns()) throw new IdentityChanged()
    const session = await refreshSession()
    if (!owns()) throw new IdentityChanged()
    // refreshSession RESOLVES null when the refresh did not succeed; treating
    // "resolved" as "succeeded" reports nothing at all. Recovery itself lives
    // in ProtectedRoute, which survives this component being unmounted.
    if (!session) throw new Error('SESSION_REFRESH_INCOMPLETE')
  }

  const verify = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || busy) return
    const normalizedCode = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(normalizedCode)) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    const factorId = selectedFactorId || mfa.factors[0]?.id
    if (!factorId) {
      setError(
        'No verified authenticator was found. Ask your MSP owner to reset MFA.'
      )
      return
    }
    setBusy(true)
    setError('')
    // Captured BEFORE the provider call: a verification dispatched for one
    // account must not drive refreshes for whoever is active when it returns.
    const dispatchedFor = currentIdentityToken()
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: normalizedCode,
      })
      if (result.error) throw result.error
    } catch {
      setError('That code was not accepted. Wait for a new code and try again.')
      setBusy(false)
      return
    }

    if (currentIdentityToken() !== dispatchedFor) {
      // The signed-in identity changed while this verification was in flight.
      // The code was still consumed, but refreshing now would act on a
      // different account's session.
      setBusy(false)
      return
    }

    // The provider has accepted the code, which consumes it. Any failure from
    // here is HawkView's and must be reported as such: telling the user their
    // code was rejected sends them to retry with a code that cannot work and
    // hides the refresh failure that actually occurred. The gate stays closed
    // either way, so this is an attribution fault, not an assurance one.
    try {
      await finish(dispatchedFor)
    } catch (thrown) {
      // An abandoned attempt reports nothing: the screen belongs to whoever is
      // signed in now, not to the identity this verification was dispatched for.
      if (thrown instanceof IdentityChanged) return
      setError(
        'Your code was accepted, but HawkView could not finish signing you in. ' +
          'You do not need a new code — reload to continue, or sign out and start again.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl sm:p-8">
        <div className="mb-6 flex items-start gap-3 border-b border-border pb-5">
          <div className="rounded-xl bg-blue-500/10 p-2.5 text-blue-600 dark:text-blue-400">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Protect your HawkView account</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Multi-factor authentication is required before MSP and customer
              data can be accessed.
            </p>
          </div>
        </div>

        {mfa.status === 'enrollment-required' && (
          <MfaEnrollment
            onComplete={finish}
            onCancel={async () => {
              await refreshMfa()
            }}
          />
        )}

        {mfa.status === 'challenge-required' && (
          <form onSubmit={verify} className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">
                Enter your authenticator code
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Open the authenticator app linked to your HawkView account.
              </p>
            </div>
            {mfa.factors.length > 1 && (
              <div className="space-y-1.5">
                <label htmlFor="mfa-factor" className="text-xs font-semibold">
                  Authenticator
                </label>
                <select
                  id="mfa-factor"
                  value={selectedFactorId || mfa.factors[0].id}
                  onChange={(event) => setSelectedFactorId(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {mfa.factors.map((factor) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.friendlyName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <label
                htmlFor="mfa-challenge-code"
                className="text-xs font-semibold"
              >
                6-digit code
              </label>
              <Input
                id="mfa-challenge-code"
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="000000"
                className="max-w-52 font-mono tracking-[0.35em]"
              />
            </div>
            {error && (
              <p
                role="alert"
                className="text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || code.length !== 6}
              className="gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Verify and continue
            </Button>
          </form>
        )}

        {mfa.status === 'error' && (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              HawkView could not verify MFA status. No workspace data has been
              loaded.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void refreshMfa()}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        )}

        <div className="mt-6 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void signOut()}
            className="gap-2 text-muted-foreground"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
