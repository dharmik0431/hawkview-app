'use client'

import { useState } from 'react'
import { Check, Copy, Loader2, QrCode, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/auth/supabase'
import {
  cancelTotpEnrollment,
  mfaEnrollmentFailureMessage,
  startTotpEnrollment,
  type MfaEnrollmentClient,
} from '@/lib/auth/mfa-enrollment'

type Enrollment = {
  factorId: string
  qrCode: string
  secret: string
}

type SupabaseClient = NonNullable<typeof supabase>

/** Narrow the client to the three calls enrollment recovery needs, so that
 * logic stays unit-testable without a live provider. */
function enrollmentClient(client: SupabaseClient): MfaEnrollmentClient {
  return {
    listFactors: () => client.auth.mfa.listFactors(),
    unenroll: ({ factorId }) => client.auth.mfa.unenroll({ factorId }),
    enroll: ({ factorType, friendlyName }) =>
      client.auth.mfa.enroll({ factorType, friendlyName }),
  }
}

/** Only needs to be collision-free, not unguessable: it disambiguates a
 * retry's authenticator name when a previous setup could not be cleared. */
function enrollmentToken() {
  const api = globalThis.crypto
  if (api && typeof api.randomUUID === 'function') return api.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function verificationError(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : ''
  if (/invalid.*code|challenge.*verify|totp/i.test(message)) {
    return 'That code was not accepted. Wait for a new code and try again.'
  }
  return 'Authenticator setup could not be completed. Please try again.'
}

export function MfaEnrollment({
  onComplete,
  onCancel,
  compact = false,
}: {
  onComplete: () => Promise<void> | void
  onCancel?: () => Promise<void> | void
  compact?: boolean
}) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // Set the instant the provider confirms the factor, which is before the
  // caller's onComplete runs. Once true the factor is a working authenticator,
  // not a pending enrollment, and nothing on this screen may delete it.
  const [enrolled, setEnrolled] = useState(false)

  // An enrollment that was started and never verified keeps its factor on the
  // account and blocks every later attempt under the same name, so recovery
  // clears that leftover state before enrolling instead of reporting a dead end.
  const start = async () => {
    if (!supabase || busy) return
    setBusy(true)
    setError('')
    try {
      const outcome = await startTotpEnrollment(enrollmentClient(supabase), {
        uniqueToken: enrollmentToken(),
      })
      if (outcome.ok) {
        setEnrollment({
          factorId: outcome.factorId,
          qrCode: outcome.qrCode,
          secret: outcome.secret,
        })
      } else {
        setError(mfaEnrollmentFailureMessage(outcome.reason))
      }
    } catch {
      setError(mfaEnrollmentFailureMessage('failed'))
    } finally {
      // Always clear busy. Leaving it set disables the only button on this
      // screen, which is the lockout this component exists to remove.
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // The sweep runs even with no factor id, which is the state left behind
      // when enroll() itself failed — previously nothing could clear it.
      // Once the provider has confirmed the factor, no provider cleanup runs at
      // all. Not the direct delete, which would undo working MFA, and not the
      // sweep either: the sweep's verified-id veto depends on the factor list
      // already reporting the new status, and a stale read must not be the only
      // thing standing between a failed refresh and a destroyed authenticator.
      if (supabase && !enrolled) {
        await cancelTotpEnrollment(
          enrollmentClient(supabase),
          enrollment?.factorId ?? null
        )
      }
      setEnrollment(null)
      setCode('')
      await onCancel?.()
    } catch {
      setError(mfaEnrollmentFailureMessage('failed'))
    } finally {
      // onCancel is declared async and callers await provider work in it, so it
      // can reject. Without this the screen kept busy set and disabled its only
      // button for good — a second lockout introduced while removing the first.
      setBusy(false)
    }
  }

  const verify = async () => {
    if (!supabase || !enrollment || busy) return
    const normalizedCode = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(normalizedCode)) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code: normalizedCode,
      })
      if (result.error) throw result.error
      // Record success before handing control to the caller. onComplete awaits
      // provider work and can reject; letting that rejection fall into the
      // verification catch below made a verified factor look like a pending
      // enrollment, and cancelling then deleted the authenticator the user had
      // just set up.
      setEnrolled(true)
      try {
        await onComplete()
      } catch {
        setError(
          'Your authenticator is set up, but HawkView could not refresh this page. Reload to continue — do not set it up again.'
        )
      }
    } catch (failure) {
      setError(verificationError(failure))
    } finally {
      setBusy(false)
    }
  }

  if (!enrollment) {
    return (
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Use Microsoft Authenticator, Google Authenticator, 1Password, or any
          app that supports time-based one-time passwords.
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="button" onClick={start} disabled={busy} className="gap-2">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <QrCode className="h-4 w-4" />
          )}
          Set up authenticator
        </Button>
      </div>
    )
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      <div className="grid gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
        <div className="mx-auto rounded-xl border border-border bg-white p-3">
          {/* Supabase returns a self-contained SVG data URL for this QR code. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enrollment.qrCode}
            alt="HawkView MFA enrollment QR code"
            width={156}
            height={156}
          />
        </div>
        <div className="space-y-3 text-xs">
          <p className="font-semibold text-foreground">1. Scan this QR code</p>
          <p className="leading-relaxed text-muted-foreground">
            Open your authenticator app, add an account, then scan the code.
          </p>
          <div>
            <p className="mb-1 font-medium text-foreground">
              Can&apos;t scan it?
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2">
              <code className="min-w-0 flex-1 break-all text-[11px]">
                {enrollment.secret}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Copy authenticator setup key"
                onClick={async () => {
                  await navigator.clipboard.writeText(enrollment.secret)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="mfa-enrollment-code"
          className="text-xs font-semibold text-foreground"
        >
          2. Enter the 6-digit code
        </label>
        <Input
          id="mfa-enrollment-code"
          value={code}
          onChange={(event) =>
            setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
          }
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          className="max-w-52 font-mono tracking-[0.35em]"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void verify()
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={verify}
          disabled={busy || code.length !== 6 || enrolled}
          className="gap-2"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Verify and enable
        </Button>
        {/* Withdrawn once the factor exists. Offering "Cancel" beside a working
            authenticator invites the user to destroy it while believing setup
            never completed. */}
        {!enrolled && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void cancel()}
            disabled={busy}
            className="gap-2"
          >
            <X className="h-4 w-4" /> Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
