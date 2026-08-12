'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  History,
  KeyRound,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type MembershipRole =
  | 'MSP_OWNER'
  | 'MSP_ADMIN'
  | 'MSP_TECHNICIAN'
  | 'MSP_VIEWER'

type Member = {
  membershipId: string
  userId: string
  email: string
  displayName: string | null
  role: MembershipRole
  status: 'ACTIVE' | 'SUSPENDED'
  createdAt: string
  updatedAt: string
}

type AuditEntry = {
  id: string
  action: string
  outcome: string
  actorEmail: string | null
  targetEmail: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

type WorkspaceResponse = {
  organization: { id: string; name: string }
  members: Member[]
}

type AuditResponse = { items: AuditEntry[] }

const roles: Array<{ value: MembershipRole; label: string; description: string }> = [
  { value: 'MSP_OWNER', label: 'MSP owner', description: 'Full workspace and team control.' },
  { value: 'MSP_ADMIN', label: 'MSP admin', description: 'Manages tenant operations and settings.' },
  { value: 'MSP_TECHNICIAN', label: 'Technician', description: 'Works with assigned tenant data.' },
  { value: 'MSP_VIEWER', label: 'Viewer', description: 'Read-only workspace access.' },
]

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString()
}

function roleLabel(role: MembershipRole) {
  return roles.find((item) => item.value === role)?.label ?? role
}

export default function TeamAccessPage() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<MembershipRole>('MSP_TECHNICIAN')

  const load = useCallback(async (keepCurrent = false) => {
    if (!keepCurrent) setLoading(true)
    setError(null)
    try {
      const [members, audit] = await Promise.all([
        apiClient.get<WorkspaceResponse>('/api/workspace/members'),
        apiClient.get<AuditResponse>('/api/workspace/audit-logs'),
      ])
      setWorkspace(members)
      setAuditEntries(Array.isArray(audit?.items) ? audit.items : [])
    } catch (requestError) {
      setError(errorMessage(requestError, 'Team access could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runAction = async (action: () => Promise<unknown>, success: string) => {
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(success)
      await load(true)
    } catch (requestError) {
      setError(errorMessage(requestError, 'That team action could not be completed.'))
    } finally {
      setSubmitting(false)
    }
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    await runAction(
      () => apiClient.post('/api/workspace/members/invite', {
        email: inviteEmail,
        displayName: inviteName || undefined,
        role: inviteRole,
      }),
      'Invitation sent. The member will receive a secure HawkView setup email.'
    )
    setInviteEmail('')
    setInviteName('')
    setInviteRole('MSP_TECHNICIAN')
  }

  const updateMember = (member: Member, data: Record<string, unknown>, success: string) =>
    runAction(
      () => apiClient.patch(`/api/workspace/members/${encodeURIComponent(member.membershipId)}`, data),
      success
    )

  const removeMember = (member: Member) => {
    if (!window.confirm(`Remove ${member.email} from this HawkView workspace?`)) return
    void runAction(
      () => apiClient.delete(`/api/workspace/members/${encodeURIComponent(member.membershipId)}`),
      `${member.email} was removed from this HawkView workspace.`
    )
  }

  const resetPassword = (member: Member) => {
    if (!window.confirm(`Send a HawkView password reset email to ${member.email}?`)) return
    void runAction(
      () => apiClient.post(`/api/workspace/members/${encodeURIComponent(member.membershipId)}/password-reset`),
      `A HawkView password-reset email was sent to ${member.email}.`
    )
  }

  const resetMfa = (member: Member) => {
    if (!window.confirm(`Reset HawkView MFA for ${member.email}? They will need to enroll again.`)) return
    void runAction(
      () => apiClient.post(`/api/workspace/members/${encodeURIComponent(member.membershipId)}/mfa-reset`),
      `HawkView MFA was reset for ${member.email}.`
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Team access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage HawkView workspace members, roles, recovery, and administrative history.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load(true)} disabled={loading || submitting}>
          <RefreshCcw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <strong>HawkView accounts only.</strong> These controls cannot reset a Microsoft 365 password, MFA method, or tenant role.
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">{notice}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UserPlus className="h-5 w-5" /> Add a team member</CardTitle>
          <CardDescription>Invited members create or access a HawkView account. Workspace owners retain responsibility for access.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-4" onSubmit={invite}>
            <div className="space-y-2"><Label htmlFor="member-name">Name (optional)</Label><Input id="member-name" value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="Alex Smith" /></div>
            <div className="space-y-2"><Label htmlFor="member-email">Email address</Label><Input id="member-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="alex@example.com" required /></div>
            <div className="space-y-2"><Label htmlFor="member-role">Workspace role</Label><select id="member-role" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as MembershipRole)}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></div>
            <div className="flex items-end"><Button type="submit" className="w-full" disabled={submitting || !inviteEmail.trim()}><UserPlus className="mr-2 h-4 w-4" /> Send invite</Button></div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> {workspace?.organization.name ?? 'Workspace'} members</CardTitle>
          <CardDescription>Only MSP owners can change membership. The final active owner cannot be demoted, suspended, or removed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && !workspace ? <p className="text-sm text-muted-foreground">Loading team members…</p> : null}
          {workspace?.members.map((member) => (
            <div key={member.membershipId} className="rounded-lg border p-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{member.displayName || member.email}</p>
                  <p className="text-sm text-muted-foreground">{member.email}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Status: {member.status === 'ACTIVE' ? 'Active' : 'Suspended'} · Added {formatDate(member.createdAt)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label={`Role for ${member.email}`} className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={member.role} disabled={submitting} onChange={(event) => void updateMember(member, { role: event.target.value }, `Role updated for ${member.email}.`)}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select>
                  <Button variant="outline" size="sm" disabled={submitting} onClick={() => void updateMember(member, { status: member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' }, `${member.email} is now ${member.status === 'ACTIVE' ? 'suspended' : 'active'}.`)}>{member.status === 'ACTIVE' ? 'Suspend' : 'Restore'}</Button>
                  <Button variant="outline" size="sm" disabled={submitting} onClick={() => resetPassword(member)}><KeyRound className="mr-1.5 h-3.5 w-3.5" /> Password</Button>
                  <Button variant="outline" size="sm" disabled={submitting} onClick={() => resetMfa(member)}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Reset MFA</Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={submitting} onClick={() => removeMember(member)}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove</Button>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{roles.find((role) => role.value === member.role)?.description}</p>
            </div>
          ))}
          {!loading && workspace?.members.length === 0 ? <p className="text-sm text-muted-foreground">No workspace members are available.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" /> Administrative activity</CardTitle>
          <CardDescription>Owner-initiated HawkView access changes and recovery actions are recorded here.</CardDescription>
        </CardHeader>
        <CardContent>
          {auditEntries.length === 0 ? <p className="text-sm text-muted-foreground">No team-administration actions have been recorded yet.</p> : <div className="space-y-3">{auditEntries.map((entry) => <div key={entry.id} className="flex flex-col gap-1 border-b pb-3 last:border-0"><p className="text-sm font-medium">{entry.action.replaceAll('_', ' ')}</p><p className="text-sm text-muted-foreground">{entry.actorEmail || 'Unknown owner'} → {entry.targetEmail || 'Workspace'} · {formatDate(entry.createdAt)}</p><p className="text-xs text-muted-foreground">Outcome: {entry.outcome}</p></div>)}</div>}
        </CardContent>
      </Card>
    </div>
  )
}
