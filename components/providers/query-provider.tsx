'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLayoutEffect, useState } from 'react'
import { useAuth } from '@/components/providers/auth-provider'
import { registerIdentityCacheReset } from '@/lib/auth/data-isolation'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const { cacheScope } = useAuth()

  // The key forces a brand-new client before descendants render for a new
  // identity/workspace. Cached tenant data is never shared across this edge.
  return (
    <IdentityQueryProvider key={cacheScope}>
      {children}
    </IdentityQueryProvider>
  )
}

function IdentityQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  useLayoutEffect(() => {
    const reset = () => {
      void queryClient.cancelQueries()
      queryClient.clear()
    }
    const unregister = registerIdentityCacheReset(reset)
    return () => {
      unregister()
      reset()
    }
  }, [queryClient])

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
