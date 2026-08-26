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

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { identityUser, session, isLoading, configurationError, mfa } = useAuth()

  useEffect(() => {
    if (
      !isLoading &&
      (!identityUser?.email_confirmed_at ||
        (mfa.status === 'verified' && !session))
    ) {
      router.replace('/login')
    }
  }, [identityUser, isLoading, mfa.status, router, session])

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
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Loading your HawkView workspace…
        </p>
      </div>
    )
  }

  const onboardingState = workspaceOnboardingState(session)
  if (onboardingState.state !== 'ready') {
    return <WorkspaceOnboardingUnavailable />
  }

  if (onboardingState.onboarding.required) {
    return <WorkspaceOnboardingGate onboarding={onboardingState.onboarding} />
  }

  return children
}
