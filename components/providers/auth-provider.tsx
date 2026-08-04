'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '@/lib/auth/supabase'
import { apiClient } from '@/lib/api/client'
import type { HawkViewSession } from '@/lib/auth/types'

interface AuthContextValue {
  identityUser: User | null
  session: HawkViewSession | null
  isLoading: boolean
  configurationError: boolean
  refreshSession: () => Promise<HawkViewSession | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [identityUser, setIdentityUser] = useState<User | null>(null)
  const [session, setSession] = useState<HawkViewSession | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const refreshSession = useCallback(async () => {
    const { data } = (await supabase?.auth.getSession()) ?? {
      data: { session: null },
    }
    if (!data.session?.user.email_confirmed_at) {
      setSession(null)
      return null
    }

    const nextSession = await apiClient.post<HawkViewSession>('/auth/bootstrap')
    setSession(nextSession)
    return nextSession
  }, [])

  useEffect(() => {
    if (!supabase) {
      setIsLoading(false)
      return
    }

    const { data } = supabase.auth.onAuthStateChange(async (_event, next) => {
      const user = next?.user ?? null
      setIdentityUser(user)

      try {
        if (user?.email_confirmed_at) {
          await refreshSession()
        } else {
          setSession(null)
        }
      } catch {
        setSession(null)
      } finally {
        setIsLoading(false)
      }
    })

    return () => data.subscription.unsubscribe()
  }, [refreshSession])

  const signOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut()
    }
    setIdentityUser(null)
    setSession(null)
  }, [])

  const value = useMemo(
    () => ({
      identityUser,
      session,
      isLoading,
      configurationError: !isSupabaseConfigured,
      refreshSession,
      signOut,
    }),
    [identityUser, isLoading, refreshSession, session, signOut]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.')
  }

  return context
}
