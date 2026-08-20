'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '@/lib/auth/supabase'
import { apiClient } from '@/lib/api/client'
import type { HawkViewSession } from '@/lib/auth/types'
import {
  AuthTransitionGuard,
  authDataScope,
  clearIdentityBoundCaches,
  type AuthTransitionTicket,
} from '@/lib/auth/data-isolation'

interface AuthContextValue {
  identityUser: User | null
  session: HawkViewSession | null
  isLoading: boolean
  configurationError: boolean
  cacheScope: string
  refreshSession: () => Promise<HawkViewSession | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [identityUser, setIdentityUser] = useState<User | null>(null)
  const [session, setSession] = useState<HawkViewSession | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const transitionGuard = useRef(new AuthTransitionGuard())
  const sessionRef = useRef<HawkViewSession | null>(null)
  const bootstrapInFlight = useRef<{
    ticket: AuthTransitionTicket
    promise: Promise<HawkViewSession | null>
  } | null>(null)

  const commitSession = useCallback((next: HawkViewSession | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  const beginIdentityTransition = useCallback(
    (user: User | null) => {
      // Clear all registered tenant/query caches synchronously before the new
      // identity is rendered. The provider key supplies a second hard edge.
      clearIdentityBoundCaches()
      const ticket = transitionGuard.current.begin(user?.id ?? null)
      bootstrapInFlight.current = null
      setIdentityUser(user)
      commitSession(null)
      setIsLoading(Boolean(user?.email_confirmed_at))
      return ticket
    },
    [commitSession]
  )

  const bootstrapIdentity = useCallback(
    (user: User, ticket: AuthTransitionTicket) => {
      const existing = bootstrapInFlight.current
      if (
        existing &&
        existing.ticket.generation === ticket.generation &&
        existing.ticket.subject === ticket.subject
      ) {
        return existing.promise
      }

      let promise!: Promise<HawkViewSession | null>
      promise = (async () => {
        try {
          const before = await supabase?.auth.getSession()
          if (
            !before?.data.session?.user.email_confirmed_at ||
            before.data.session.user.id !== user.id ||
            !transitionGuard.current.isCurrent(ticket)
          ) {
            return null
          }

          const nextSession = await apiClient.post<HawkViewSession>(
            '/auth/bootstrap'
          )
          const after = await supabase?.auth.getSession()
          if (
            after?.data.session?.user.id !== user.id ||
            !transitionGuard.current.isCurrent(ticket)
          ) {
            return null
          }

          commitSession(nextSession)
          return nextSession
        } catch {
          if (transitionGuard.current.isCurrent(ticket)) commitSession(null)
          return null
        } finally {
          if (transitionGuard.current.isCurrent(ticket)) setIsLoading(false)
          if (bootstrapInFlight.current?.promise === promise) {
            bootstrapInFlight.current = null
          }
        }
      })()

      bootstrapInFlight.current = { ticket, promise }
      return promise
    },
    [commitSession]
  )

  const refreshSession = useCallback(async () => {
    const { data } = (await supabase?.auth.getSession()) ?? {
      data: { session: null },
    }
    const user = data.session?.user ?? null
    if (!user?.email_confirmed_at) {
      if (transitionGuard.current.current().subject !== (user?.id ?? null)) {
        beginIdentityTransition(user)
      } else {
        commitSession(null)
        setIsLoading(false)
      }
      return null
    }

    const current = transitionGuard.current.current()
    const ticket =
      current.subject === user.id
        ? current
        : beginIdentityTransition(user)
    setIdentityUser(user)
    if (!sessionRef.current) setIsLoading(true)
    return bootstrapIdentity(user, ticket)
  }, [beginIdentityTransition, bootstrapIdentity, commitSession])

  useEffect(() => {
    if (!supabase) {
      setIsLoading(false)
      return
    }

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      const user = next?.user ?? null
      const current = transitionGuard.current.current()
      const subjectChanged = current.subject !== (user?.id ?? null)
      const ticket = subjectChanged
        ? beginIdentityTransition(user)
        : current

      setIdentityUser(user)
      if (!user?.email_confirmed_at) {
        commitSession(null)
        setIsLoading(false)
        return
      }

      if (subjectChanged || !sessionRef.current || _event === 'USER_UPDATED') {
        setIsLoading(true)
        // Return from the auth callback before invoking another Supabase auth
        // method; late results are guarded by the transition ticket.
        queueMicrotask(() => {
          void bootstrapIdentity(user, ticket)
        })
      } else {
        setIsLoading(false)
      }
    })

    return () => data.subscription.unsubscribe()
  }, [beginIdentityTransition, bootstrapIdentity, commitSession])

  const signOut = useCallback(async () => {
    beginIdentityTransition(null)
    setIsLoading(false)
    if (supabase) {
      await supabase.auth.signOut()
    }
  }, [beginIdentityTransition])

  const cacheScope = useMemo(
    () => authDataScope(identityUser?.id, session),
    [identityUser?.id, session]
  )

  const value = useMemo(
    () => ({
      identityUser,
      session,
      isLoading,
      configurationError: !isSupabaseConfigured,
      cacheScope,
      refreshSession,
      signOut,
    }),
    [cacheScope, identityUser, isLoading, refreshSession, session, signOut]
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
