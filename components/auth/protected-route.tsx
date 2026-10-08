'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/providers/auth-provider'
import {
  WorkspaceOnboardingGate,
  WorkspaceOnboardingUnavailable,
} from '@/components/auth/workspace-onboarding'
import { workspaceOnboardingState } from '@/lib/auth/workspace-onboarding'
import { MfaAccessGate } from '@/components/auth/mfa-access-gate'
import { IdleSessionWarning } from '@/components/auth/idle-session-warning'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const {
    identityUser,
    session,
    isLoading,
    configurationError,
    mfa,
    sessionBootstrapFailed,
    isRetryingSession,
    retrySessionBootstrap,
    idleSessionState,
    extendIdleSession,
    retryIdleSession,
  } = useAuth()

  useEffect(() => {
    if (
      !isLoading &&
      (!identityUser?.email_confirmed_at ||
        (mfa.status === 'verified' && !session && !sessionBootstrapFailed))
    ) {
      router.replace('/login')
    }
  }, [identityUser, isLoading, mfa.status, router, session, sessionBootstrapFailed])

  if (configurationError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <p>HawkView authentication has not been configured for this frontend.</p>
      </div>
    )
  }

  if (isLoading || !identityUser?.email_confirmed_at) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Verifying your HawkView access…
        </p>
      </div>
    )
  }

  if (mfa.status === 'loading' || mfa.status === 'signed-out') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Verifying multi-factor authentication…
        </p>
      </div>
    )
  }

  if (mfa.status !== 'verified') {
    return <MfaAccessGate />
  }

  if (!session) {
    // A bootstrap that failed after verification is recoverable and must stay
    // recoverable: the factor is verified and the code is consumed, so sending
    // the user back to /login would demand a new code that cannot help.
    if (sessionBootstrapFailed) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="max-w-md space-y-4 text-center">
            <p role="alert" className="text-sm">
              Your sign-in was verified, but HawkView could not load your
              workspace. You do not need a new code.
            </p>
            <button
              type="button"
              disabled={isRetryingSession}
              onClick={() => void retrySessionBootstrap()}
            >
              {isRetryingSession ? 'Retrying…' : 'Retry sign-in'}
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Loading your HawkView workspace…
        </p>
      </div>
    )
  }

  if (idleSessionState?.phase === 'checking' || idleSessionState?.phase === 'expired') {
    return <div className="flex min-h-screen items-center justify-center p-6"><div className="space-y-3 text-center">
      <p className="text-sm text-muted-foreground">{idleSessionState.verificationFailed ? 'Your session could not be verified. Check your connection and try again.' : 'Verifying your session…'}</p>
      {idleSessionState.verificationFailed && <button type="button" onClick={() => void retryIdleSession().catch(() => {})}>Retry session check</button>}
    </div></div>
  }

  const onboardingState = workspaceOnboardingState(session)
  if (onboardingState.state !== 'ready') {
    return <WorkspaceOnboardingUnavailable />
  }

  if (onboardingState.onboarding.required) {
    return <WorkspaceOnboardingGate onboarding={onboardingState.onboarding} />
  }

  return <>{children}{idleSessionState?.phase === 'warning' && <IdleSessionWarning remainingSeconds={idleSessionState.remainingSeconds} staySignedIn={extendIdleSession} />}</>
}
