'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/auth/supabase'
import {
  confirmationFailureMessage,
  HAWKVIEW_EMAIL_CONFIRMATION_PATH,
  parseHawkViewEmailConfirmation,
  verifyHawkViewEmailConfirmation,
  type EmailConfirmationResult,
} from '@/lib/auth/email-confirmation'

type FailureReason = Exclude<EmailConfirmationResult, { ok: true }>['reason']

export function ConfirmAuthEmail() {
  const router = useRouter()
  const requestRef = useRef<ReturnType<typeof parseHawkViewEmailConfirmation>>(null)
  const verificationStartedRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<FailureReason | null>(null)

  useEffect(() => {
    requestRef.current = parseHawkViewEmailConfirmation(window.location.hash)

    // Token hashes are single-use credentials. Remove them from browser history
    // immediately, and never log provider errors or input. Verification requires
    // a deliberate click so automated link scanners cannot consume the token.
    window.history.replaceState(
      window.history.state,
      '',
      HAWKVIEW_EMAIL_CONFIRMATION_PATH
    )

    if (!requestRef.current) setFailure('invalid')
    setReady(true)
  }, [])

  const confirm = async () => {
    if (verificationStartedRef.current || !requestRef.current) return
    verificationStartedRef.current = true

    if (!supabase) {
      setFailure('unavailable')
      return
    }

    setVerifying(true)
    const result = await verifyHawkViewEmailConfirmation(
      supabase,
      requestRef.current
    )
    if (!result.ok) {
      setFailure(result.reason)
      setVerifying(false)
      return
    }
    router.replace(result.destination)
  }

  if (!ready || verifying) {
    return (
      <div role="status" className="space-y-4 text-center">
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-blue-600" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Verifying your HawkView link
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Please wait while HawkView securely completes this request.
          </p>
        </div>
      </div>
    )
  }

  if (failure)
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            This link could not be verified
          </h1>
          <div
            role="alert"
            className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{confirmationFailureMessage(failure)}</span>
          </div>
        </div>
        <Button asChild className="h-11 w-full">
          <Link href="/login">Return to login</Link>
        </Button>
      </div>
    )

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Continue to HawkView
        </h1>
        <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
          Confirm that you want to complete this account request. This protects
          one-time links from automated email scanners.
        </p>
      </div>
      <Button className="h-11 w-full" onClick={() => void confirm()}>
        Continue securely
      </Button>
    </div>
  )
}
