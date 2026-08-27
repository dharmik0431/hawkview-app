'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/components/providers/auth-provider'
import { useNotifications } from '@/components/providers/notification-provider'
import { supabase } from '@/lib/auth/supabase'
import { buildHawkViewAppUrl } from '@/lib/config/public-runtime-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MfaSecurityPanel } from '@/components/auth/mfa-security-panel'
import {
  KeyRound,
  Laptop,
  Lock,
  Loader2,
  CheckCircle2,
  Info,
  Globe,
} from 'lucide-react'
function parseAuthError(error: any): string {
  if (!error) return 'An unexpected error occurred.'
  const code = error.code || ''
  switch (code) {
    case 'auth/invalid-email':
      return 'The sign-in email address is invalid.'
    case 'auth/user-not-found':
      return 'No registered account found with this email address.'
    case 'auth/too-many-requests':
      return 'Too many password reset attempts. Please wait a few minutes before trying again.'
    case 'auth/network-request-failed':
      return 'Network request failed. Please check your connection and try again.'
    case 'auth/user-disabled':
      return 'This user account has been disabled.'
    default:
      return 'Failed to send password reset email. Please retry.'
  }
}

export default function SecuritySettingsPage() {
  const { session, identityUser } = useAuth()
  const { notify } = useNotifications()

  const userEmail =
    session?.user.email || identityUser?.email || 'Not reported'
  const signInProvider = session?.signInProvider || 'Not reported'
  const isProviderReported = signInProvider !== 'Not reported'

  // Determine if user uses standard email/password or SSO
  const isSsoUser = useMemo(() => {
    const provider = signInProvider.toLowerCase()
    return (
      provider.includes('microsoft') ||
      provider.includes('google') ||
      provider.includes('oauth') ||
      provider.includes('saml')
    )
  }, [signInProvider])

  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false)
  const [isSendingReset, setIsSendingReset] = useState(false)
  const [resetSentSuccess, setResetSentSuccess] = useState(false)

  // System environment info
  const [userAgentInfo, setUserAgentInfo] = useState<{
    browser: string
    os: string
  }>({
    browser: 'Modern Web Browser',
    os: 'Unknown OS',
  })

  useEffect(() => {
    if (typeof window !== 'undefined' && navigator.userAgent) {
      const ua = navigator.userAgent
      let browser = 'Web Browser'
      let os = 'Desktop'

      if (ua.includes('Edg')) browser = 'Microsoft Edge'
      else if (ua.includes('Chrome')) browser = 'Google Chrome'
      else if (ua.includes('Safari')) browser = 'Apple Safari'
      else if (ua.includes('Firefox')) browser = 'Mozilla Firefox'

      if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS'
      else if (ua.includes('Windows')) os = 'Windows'
      else if (ua.includes('Linux')) os = 'Linux'
      else if (ua.includes('Android')) os = 'Android'
      else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS'

      setUserAgentInfo({ browser, os })
    }
  }, [])

  // Send password reset
  const handleConfirmResetPassword = async () => {
    if (isSendingReset) return
    setIsSendingReset(true)

    try {
      if (!supabase || !userEmail) {
        throw new Error('HawkView authentication is not configured.')
      }

      const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
        redirectTo: buildHawkViewAppUrl('/auth/confirm').href,
      })
      if (error) throw error

      notify({
        title: 'Password reset email sent.',
        description: `A reset link was sent to ${userEmail}.`,
        category: 'success',
      })

      setResetSentSuccess(true)
      setIsResetDialogOpen(false)
    } catch (err: any) {
      const friendlyError = parseAuthError(err)
      notify({
        title: 'Password reset failed',
        description: friendlyError,
        category: 'error',
      })
    } finally {
      setIsSendingReset(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* SECTION 1: PASSWORD */}
      <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3 border-b border-border pb-4 mb-5">
          <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Password Management
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage your password reset settings and authentication security.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label
              htmlFor="sec-email"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Sign-In Email
            </label>
            <div className="relative">
              <Input
                id="sec-email"
                type="email"
                value={userEmail}
                readOnly
                disabled
                className="w-full bg-muted/50 text-muted-foreground pr-8 cursor-not-allowed"
              />
              <Lock
                className="h-4 w-4 text-muted-foreground absolute right-2.5 top-2.5"
                aria-hidden="true"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="sec-provider"
              className="block text-xs font-medium text-foreground mb-1.5"
            >
              Authentication Provider
            </label>
            <Input
              id="sec-provider"
              type="text"
              value={signInProvider}
              readOnly
              disabled
              className="w-full bg-muted/50 text-muted-foreground cursor-not-allowed"
            />
          </div>
        </div>

        {/* Reset Password Action / Status */}
        <div className="mt-6 pt-5 border-t border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-foreground">
              Password Status
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {!isProviderReported
                ? 'Authentication method not reported by the identity service.'
                : isSsoUser
                ? `Managed via ${signInProvider} single sign-on.`
                : 'Password authentication active.'}
            </p>
          </div>

          {!isProviderReported ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded-lg border border-border">
              <Info className="h-4 w-4 text-blue-500 shrink-0" aria-hidden="true" />
              <span>Password controls are unavailable until the authentication method is reported.</span>
            </div>
          ) : isSsoUser ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded-lg border border-border">
              <Info className="h-4 w-4 text-blue-500 shrink-0" />
              <span>
                Password updates must be performed in your {signInProvider}{' '}
                portal.
              </span>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsResetDialogOpen(true)}
              className="text-xs gap-2 shrink-0"
            >
              <KeyRound className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              <span>Reset password</span>
            </Button>
          )}
        </div>

        {/* Small Inline Confirmation Message */}
        {resetSentSuccess && (
          <div className="mt-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              HawkView sent a secure password reset link to{' '}
              <strong>{userEmail}</strong>. Check your email inbox to complete
              the password update.
            </span>
          </div>
        )}
      </div>

      {/* SECTION 2: MULTI-FACTOR AUTHENTICATION */}
      <MfaSecurityPanel />

      {/* SECTION 3: CURRENT SESSION */}
      <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3 border-b border-border pb-4 mb-5">
          <div className="p-2 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
            <Laptop className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Current Browser Session
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Details about the browser currently signed in to HawkView.
            </p>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-border bg-muted/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 mt-0.5">
              <Globe className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-foreground">
                  {userAgentInfo.browser} ({userAgentInfo.os})
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Active now
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Current browser only &bull; Authenticated via{' '}
                {signInProvider}
              </p>
            </div>
          </div>

          <div className="text-right text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Signed in</p>
            <p className="text-[11px] text-muted-foreground">
              Other active sessions are not listed
            </p>
          </div>
        </div>
      </div>

      {/* RESET PASSWORD CONFIRMATION MODAL */}
      {isResetDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            className="w-full max-w-md rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-xl space-y-4"
          >
            <div className="flex items-center gap-3 text-foreground">
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <KeyRound className="h-5 w-5" />
              </div>
              <h3 id="reset-dialog-title" className="text-base font-bold">
                Reset your password?
              </h3>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              HawkView will send a secure password reset link to{' '}
              <strong className="text-foreground">{userEmail}</strong>.
            </p>

            <div className="pt-3 flex items-center justify-end gap-2.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsResetDialogOpen(false)}
                disabled={isSendingReset}
                className="text-xs"
              >
                Cancel
              </Button>

              <Button
                type="button"
                onClick={handleConfirmResetPassword}
                disabled={isSendingReset}
                className="text-xs gap-2"
              >
                {isSendingReset ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Sending reset link...</span>
                  </>
                ) : (
                  <span>Send reset link</span>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
