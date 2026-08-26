'use client'

import { useState } from 'react'
import { Loader2, Plus, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MfaEnrollment } from '@/components/auth/mfa-enrollment'
import { useAuth } from '@/components/providers/auth-provider'
import { useNotifications } from '@/components/providers/notification-provider'
import { supabase } from '@/lib/auth/supabase'

function factorDate(value: string | null) {
  if (!value) return 'Date not reported'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date not reported'
    : `Added ${date.toLocaleDateString()}`
}

export function MfaSecurityPanel() {
  const { mfa, refreshMfa } = useAuth()
  const { notify } = useNotifications()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const removeFactor = async (factorId: string) => {
    if (!supabase || removing) return
    if (
      !window.confirm('Remove this authenticator from your HawkView account?')
    )
      return
    setRemoving(factorId)
    try {
      const result = await supabase.auth.mfa.unenroll({ factorId })
      if (result.error) throw result.error
      await refreshMfa()
      notify({
        title: 'Authenticator removed',
        description:
          mfa.factors.length === 1
            ? 'You must enroll a new authenticator before accessing HawkView again.'
            : 'The authenticator can no longer approve HawkView sign-ins.',
        category: 'success',
      })
    } catch {
      notify({
        title: 'Authenticator could not be removed',
        description: 'Verify MFA again, then retry the removal.',
        category: 'error',
      })
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Multi-Factor Authentication
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Protects your HawkView account and MSP workspace.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300">
          Required · Enabled
        </span>
      </div>

      {!adding && (
        <div className="space-y-3">
          {mfa.factors.map((factor) => (
            <div
              key={factor.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3"
            >
              <div className="flex items-center gap-3">
                <Smartphone className="h-4 w-4 text-blue-500" />
                <div>
                  <p className="text-xs font-semibold text-foreground">
                    {factor.friendlyName}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {factorDate(factor.createdAt)}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(removing)}
                onClick={() => void removeFactor(factor.id)}
                className="gap-2 text-xs"
              >
                {removing === factor.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
              Add a second authenticator as a backup. Supabase does not provide
              recovery codes, so a backup factor or an MSP-owner reset is the
              recovery path.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAdding(true)}
              className="gap-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" /> Add authenticator
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <MfaEnrollment
          compact
          onComplete={async () => {
            await refreshMfa()
            setAdding(false)
            notify({
              title: 'Authenticator added',
              description: 'The new factor can approve HawkView sign-ins.',
              category: 'success',
            })
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}
