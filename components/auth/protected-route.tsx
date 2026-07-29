'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/providers/auth-provider'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { identityUser, session, isLoading, configurationError } = useAuth()

  useEffect(() => {
    if (!isLoading && (!identityUser?.emailVerified || !session)) {
      router.replace('/login')
    }
  }, [identityUser, isLoading, router, session])

  if (configurationError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <p>HawkView authentication has not been configured for this frontend.</p>
      </div>
    )
  }

  if (isLoading || !identityUser?.emailVerified || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Verifying your HawkView access…
        </p>
      </div>
    )
  }

  return children
}

