'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { auth } from '@/lib/auth/firebase'
import { useAuth } from '@/components/providers/auth-provider'

type LoginMode = 'sign-in' | 'sign-up' | 'reset'

const authErrors: Record<string, string> = {
  'auth/email-already-in-use': 'An account already exists for this email.',
  'auth/invalid-credential': 'The email or password is incorrect.',
  'auth/invalid-login-credentials': 'The email or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/invalid-api-key':
    'HawkView authentication is using an invalid Firebase API key.',
  'auth/missing-password': 'Enter your password.',
  'auth/network-request-failed':
    'HawkView could not reach Firebase. Check your connection and try again.',
  'auth/operation-not-allowed':
    'Email and password authentication is not enabled.',
  'auth/too-many-requests':
    'Too many attempts. Wait a few minutes and try again.',
  'auth/unauthorized-domain':
    'This HawkView web address is not authorized in Firebase.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/user-not-found': 'The email or password is incorrect.',
  'auth/weak-password': 'Choose a stronger password with at least 8 characters.',
}

function readableAuthError(error: unknown) {
  if (error instanceof FirebaseError) {
    return (
      authErrors[error.code] ||
      `Authentication could not be completed (${error.code}).`
    )
  }
  if (error instanceof Error) return error.message
  return 'Authentication could not be completed.'
}

export default function LoginPage() {
  const router = useRouter()
  const { identityUser, session, isLoading: isAuthLoading, refreshSession } =
    useAuth()
  const [mode, setMode] = useState<LoginMode>('sign-in')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!isAuthLoading && identityUser?.emailVerified && session) {
      router.replace('/dashboard')
    }
  }, [identityUser, isAuthLoading, router, session])

  const changeMode = (nextMode: LoginMode) => {
    setMode(nextMode)
    setError('')
    setNotice('')
    setPassword('')
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')

    if (!auth) {
      setError('HawkView authentication is not configured for this frontend.')
      return
    }

    setIsLoading(true)

    try {
      if (mode === 'reset') {
        await sendPasswordResetEmail(auth, email.trim())
        setNotice(
          'If an account exists for that email, password reset instructions have been sent.'
        )
        return
      }

      await setPersistence(
        auth,
        remember ? browserLocalPersistence : browserSessionPersistence
      )

      if (mode === 'sign-up') {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password
        )

        if (displayName.trim()) {
          await updateProfile(credential.user, {
            displayName: displayName.trim(),
          })
        }

        await sendEmailVerification(credential.user)
        setNotice(
          'Your account was created. Check your email and verify it before signing in.'
        )
        return
      }

      const credential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      )

      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user)
        setNotice(
          'Verify your email before continuing. We sent you a new verification message.'
        )
        return
      }

      await refreshSession()
      router.replace('/dashboard')
    } catch (authError) {
      setError(readableAuthError(authError))
    } finally {
      setIsLoading(false)
    }
  }

  const title =
    mode === 'sign-up'
      ? 'Create your account'
      : mode === 'reset'
        ? 'Reset your password'
        : 'Log in'

  const description =
    mode === 'sign-up'
      ? 'Create your HawkView identity. Your MSP workspace comes next.'
      : mode === 'reset'
        ? 'We will email you a secure password reset link.'
        : 'Access your HawkView workspace.'

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-100 p-4 dark:bg-gray-950">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-blue-600 dark:text-blue-400">
          HawkView
        </h1>
      </div>

      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="pt-6">
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {description}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'sign-up' && (
                <div className="space-y-2">
                  <Label htmlFor="displayName">Your name</Label>
                  <Input
                    id="displayName"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                    required
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                />
              </div>

              {mode !== 'reset' && (
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      mode === 'sign-up'
                        ? 'At least 8 characters'
                        : 'Enter your password'
                    }
                    autoComplete={
                      mode === 'sign-up' ? 'new-password' : 'current-password'
                    }
                    minLength={8}
                    required
                  />
                </div>
              )}

              {mode !== 'reset' && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="remember"
                      checked={remember}
                      onCheckedChange={(checked) => setRemember(checked === true)}
                    />
                    <Label
                      htmlFor="remember"
                      className="cursor-pointer text-sm font-normal"
                    >
                      Remember me
                    </Label>
                  </div>
                  {mode === 'sign-in' && (
                    <button
                      type="button"
                      onClick={() => changeMode('reset')}
                      className="text-sm text-blue-600 hover:text-blue-500 dark:text-blue-400"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
                >
                  {error}
                </p>
              )}

              {notice && (
                <p
                  role="status"
                  className="rounded-md bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                >
                  {notice}
                </p>
              )}

              <Button
                type="submit"
                disabled={isLoading || isAuthLoading}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                {isLoading
                  ? 'Please wait…'
                  : mode === 'sign-up'
                    ? 'Create account'
                    : mode === 'reset'
                      ? 'Send reset link'
                      : 'Log in'}
              </Button>
            </form>

            {mode === 'sign-in' && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <Button type="button" variant="outline" className="w-full" disabled>
                    Continue with Microsoft — coming next
                  </Button>
                  <Button type="button" variant="outline" className="w-full" disabled>
                    Continue with Google — coming next
                  </Button>
                </div>
              </>
            )}

            <p className="text-center text-sm text-muted-foreground">
              {mode === 'sign-in' && (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={() => changeMode('sign-up')}
                    className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                  >
                    Sign up
                  </button>
                </>
              )}
              {mode !== 'sign-in' && (
                <button
                  type="button"
                  onClick={() => changeMode('sign-in')}
                  className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                >
                  Back to login
                </button>
              )}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
