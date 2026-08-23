'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useAuth } from '@/components/providers/auth-provider'
import { registerIdentityCacheReset } from '@/lib/auth/data-isolation'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const { cacheScope } = useAuth()

  return (
    <IdentityQueryProvider cacheScope={cacheScope}>
      {children}
    </IdentityQueryProvider>
  )
}

function IdentityQueryProvider({
  cacheScope,
  children,
}: {
  cacheScope: string
  children: React.ReactNode
}) {
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
  const previousScope = useRef(cacheScope)
  const reset = useCallback(() => {
    void queryClient.cancelQueries()
    queryClient.clear()
  }, [queryClient])

  useLayoutEffect(() => {
    const unregister = registerIdentityCacheReset(reset)
    return () => {
      unregister()
      reset()
    }
  }, [reset])

  useLayoutEffect(() => {
    if (previousScope.current === cacheScope) return
    previousScope.current = cacheScope
    reset()
  }, [cacheScope, reset])

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
