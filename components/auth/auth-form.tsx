'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
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
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { auth } from '@/lib/auth/firebase'
import { useAuth } from '@/components/providers/auth-provider'
import { ProviderButtons } from '@/components/auth/provider-buttons'
import { cn } from '@/lib/utils'

export type AuthMode = 'sign-in' | 'sign-up' | 'reset'

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
  'auth/weak-password':
    'Choose a stronger password with at least 8 characters.',
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

interface AuthFormProps {
  initialMode: AuthMode
}

export function AuthForm({ initialMode }: AuthFormProps) {
  const router = useRouter()
  const {
    identityUser,
    session,
    isLoading: isAuthLoading,
    refreshSession,
  } = useAuth()

  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Inline Validation States
  const [nameError, setNameError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')

  // Sync mode with prop if route changes
  useEffect(() => {
    setMode(initialMode)
    setError('')
    setNotice('')
    setNameError('')
    setEmailError('')
    setPasswordError('')
  }, [initialMode])

  useEffect(() => {
    if (!isAuthLoading && identityUser?.emailVerified && session) {
      router.replace('/dashboard')
    }
  }, [identityUser, isAuthLoading, router, session])

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setError('')
    setNotice('')
    setPassword('')
    setNameError('')
    setEmailError('')
    setPasswordError('')
  }

  const validateEmail = (val: string) => {
    const trimmed = val.trim()
    if (!trimmed) {
      setEmailError('Email address is required.')
      return false
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(trimmed)) {
      setEmailError('Enter a valid email address.')
      return false
    }
    setEmailError('')
    return true
  }

  const validatePassword = (val: string) => {
    if (mode === 'reset') return true
    if (!val) {
      setPasswordError('Password is required.')
      return false
    }
    if (mode === 'sign-up' && val.length < 8) {
      setPasswordError('Password must be at least 8 characters.')
      return false
    }
    setPasswordError('')
    return true
  }

  const validateName = (val: string) => {
    if (mode !== 'sign-up') return true
    if (!val.trim()) {
      setNameError('Your name is required.')
      return false
    }
    setNameError('')
    return true
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')

    const isEmailValid = validateEmail(email)
    const isPasswordValid = validatePassword(password)
    const isNameValid = validateName(displayName)

    if (!isEmailValid || !isPasswordValid || !isNameValid) {
      return
    }

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
      ? 'Create your HawkView account'
      : mode === 'reset'
        ? 'Reset your password'
        : 'Welcome back'

  const description =
    mode === 'sign-up'
      ? 'Start building your MSP workspace.'
      : mode === 'reset'
        ? 'We will email you a secure password reset link.'
        : 'Log in to your HawkView workspace.'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1.5 text-left">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {title}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {description}
        </p>
      </div>

      {/* Primary Server / Auth Errors */}
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200/80 dark:border-red-900/60 p-3.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2.5 shadow-xs"
        >
          <AlertCircle
            className="h-4 w-4 shrink-0 text-red-500 mt-0.5"
            aria-hidden="true"
          />
          <span className="leading-relaxed font-medium">{error}</span>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-900/60 p-3.5 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2.5 shadow-xs"
        >
          <CheckCircle2
            className="h-4 w-4 shrink-0 text-blue-500 mt-0.5"
            aria-hidden="true"
          />
          <span className="leading-relaxed font-medium">{notice}</span>
        </div>
      )}

      {/* Main Form */}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {mode === 'sign-up' && (
          <div className="space-y-1.5">
            <Label
              htmlFor="displayName"
              className="text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              Your name
            </Label>
            <Input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                if (nameError) validateName(e.target.value)
              }}
              onBlur={(e) => validateName(e.target.value)}
              placeholder="Alex Johnson"
              autoComplete="name"
              required
              aria-invalid={!!nameError}
              aria-describedby={nameError ? 'name-error' : undefined}
              className={cn(
                'h-10 text-sm transition-colors',
                nameError &&
                  'border-red-500 focus-visible:ring-red-500 dark:border-red-500'
              )}
            />
            {nameError && (
              <p
                id="name-error"
                className="text-[12px] font-medium text-red-600 dark:text-red-400"
              >
                {nameError}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label
            htmlFor="email"
            className="text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            Email address
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (emailError) validateEmail(e.target.value)
            }}
            onBlur={(e) => validateEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
            aria-invalid={!!emailError}
            aria-describedby={emailError ? 'email-error' : undefined}
            className={cn(
              'h-10 text-sm transition-colors',
              emailError &&
                'border-red-500 focus-visible:ring-red-500 dark:border-red-500'
            )}
          />
          {emailError && (
            <p
              id="email-error"
              className="text-[12px] font-medium text-red-600 dark:text-red-400"
            >
              {emailError}
            </p>
          )}
        </div>

        {mode !== 'reset' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="password"
                className="text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                Password
              </Label>
              {mode === 'sign-in' && (
                <button
                  type="button"
                  onClick={() => changeMode('reset')}
                  className="text-xs font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1"
                >
                  Forgot password?
                </button>
              )}
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (passwordError) validatePassword(e.target.value)
                }}
                onBlur={(e) => validatePassword(e.target.value)}
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
                aria-invalid={!!passwordError}
                aria-describedby={passwordError ? 'password-error' : undefined}
                className={cn(
                  'h-10 text-sm pr-10 transition-colors',
                  passwordError &&
                    'border-red-500 focus-visible:ring-red-500 dark:border-red-500'
                )}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded p-1 transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {passwordError && (
              <p
                id="password-error"
                className="text-[12px] font-medium text-red-600 dark:text-red-400"
              >
                {passwordError}
              </p>
            )}
          </div>
        )}

        {mode !== 'reset' && (
          <div className="flex items-center space-x-2 pt-1">
            <Checkbox
              id="remember"
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <Label
              htmlFor="remember"
              className="cursor-pointer text-xs font-normal text-slate-600 dark:text-slate-400 select-none"
            >
              Remember me on this device
            </Label>
          </div>
        )}

        {/* Submit Action Button */}
        <Button
          type="submit"
          disabled={isLoading || isAuthLoading}
          className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm rounded-xl shadow-xs focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed mt-2"
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Please wait…</span>
            </span>
          ) : mode === 'sign-up' ? (
            'Create account'
          ) : mode === 'reset' ? (
            'Send reset link'
          ) : (
            'Log in'
          )}
        </Button>
      </form>

      {/* Provider Buttons Section (shown on login and sign-up) */}
      {mode !== 'reset' && (
        <div className="space-y-4 pt-1">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-slate-200 dark:border-slate-800" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-slate-50 dark:bg-slate-950 px-3 text-slate-400 dark:text-slate-500 font-medium">
                or
              </span>
            </div>
          </div>

          <ProviderButtons />
        </div>
      )}

      {/* Footer Navigation Link */}
      <div className="text-center text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
        {mode === 'sign-in' && (
          <span>
            Don&apos;t have an account?{' '}
            <Link
              href="/signup"
              onClick={() => changeMode('sign-up')}
              className="font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1"
            >
              Sign up
            </Link>
          </span>
        )}

        {mode === 'sign-up' && (
          <span>
            Already have an account?{' '}
            <Link
              href="/login"
              onClick={() => changeMode('sign-in')}
              className="font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1"
            >
              Log in
            </Link>
          </span>
        )}

        {mode === 'reset' && (
          <button
            type="button"
            onClick={() => changeMode('sign-in')}
            className="font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1"
          >
            Back to login
          </button>
        )}
      </div>
    </div>
  )
}
