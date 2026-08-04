'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/lib/auth/supabase'

export function UpdatePasswordForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [hasSession, setHasSession] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!supabase) {
      setError('HawkView authentication is not configured.')
      setIsLoading(false)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setHasSession(Boolean(data.session))
      setIsLoading(false)
    })

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) {
        setHasSession(true)
        setIsLoading(false)
      }
    })

    return () => data.subscription.unsubscribe()
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (!supabase || !hasSession) {
      setError('This password reset link is invalid or has expired.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setIsLoading(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setSuccess(true)
    await supabase.auth.signOut()
    setTimeout(() => router.replace('/login'), 1200)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Choose a new password
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Enter a new password for your HawkView account.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-medium text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div role="status" className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Password updated. Returning to login...</span>
        </div>
      )}

      {!success && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input id="confirm-password" type="password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
          </div>
          <Button type="submit" className="h-11 w-full" disabled={isLoading || !hasSession}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
          </Button>
        </form>
      )}

      <div className="text-center text-xs">
        <Link href="/login" className="font-semibold text-blue-600 hover:text-blue-500">
          Back to login
        </Link>
      </div>
    </div>
  )
}
