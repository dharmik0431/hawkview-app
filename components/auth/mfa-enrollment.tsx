'use client'

import { useState } from 'react'
import { Check, Copy, Loader2, QrCode, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/auth/supabase'

type Enrollment = {
  factorId: string
  qrCode: string
  secret: string
}

function mfaError(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : ''
  if (/invalid.*code|challenge.*verify/i.test(message)) {
    return 'That code was not accepted. Wait for a new code and try again.'
  }
  if (/factor.*exist/i.test(message)) {
    return 'An authenticator setup is already in progress. Cancel it or refresh this page.'
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

  const start = async () => {
    if (!supabase || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'HawkView Authenticator',
      })
      if (result.error) throw result.error
      setEnrollment({
        factorId: result.data.id,
        qrCode: result.data.totp.qr_code,
        secret: result.data.totp.secret,
      })
    } catch (failure) {
      setError(mfaError(failure))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (supabase && enrollment?.factorId) {
        const result = await supabase.auth.mfa.unenroll({
          factorId: enrollment.factorId,
        })
        if (result.error) throw result.error
      }
      setEnrollment(null)
      setCode('')
      await onCancel?.()
    } catch (failure) {
      setError(mfaError(failure))
    } finally {
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
      await onComplete()
    } catch (failure) {
      setError(mfaError(failure))
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
          disabled={busy || code.length !== 6}
          className="gap-2"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Verify and enable
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void cancel()}
          disabled={busy}
          className="gap-2"
        >
          <X className="h-4 w-4" /> Cancel
        </Button>
      </div>
    </div>
  )
}
