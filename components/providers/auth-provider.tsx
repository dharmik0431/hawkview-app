'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  onAuthStateChanged,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth, isFirebaseConfigured } from '@/lib/auth/firebase'
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
    if (!auth?.currentUser?.emailVerified) {
      setSession(null)
      return null
    }

    const nextSession = await apiClient.post<HawkViewSession>('/auth/bootstrap')
    setSession(nextSession)
    return nextSession
  }, [])

  useEffect(() => {
    if (!auth) {
      setIsLoading(false)
      return
    }

    return onAuthStateChanged(auth, async (user) => {
      setIdentityUser(user)

      try {
        if (user?.emailVerified) {
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
  }, [refreshSession])

  const signOut = useCallback(async () => {
    if (auth) {
      await firebaseSignOut(auth)
    }
    setIdentityUser(null)
    setSession(null)
  }, [])

  const value = useMemo(
    () => ({
      identityUser,
      session,
      isLoading,
      configurationError: !isFirebaseConfigured,
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

