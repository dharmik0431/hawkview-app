'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  Building,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Globe,
  History,
  Info,
  KeyRound,
  Lock,
  Mail,
  MoreHorizontal,
  RefreshCcw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  UserX,
  X,
} from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import { useAuth } from '@/components/providers/auth-provider'
import { Button } from '@/components/ui/button'
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
  joinedAt?: string
  createdAt?: string
  hasHawkViewAccount?: boolean
  disabled?: boolean
}

type AuditEntry = {
  id: string
  organizationId: string
  actorUserId?: string | null
  actorEmail: string | null
  targetUserId?: string | null
  targetEmail: string | null
  action: string
  outcome: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

type WorkspaceResponse = {
  organization: { id: string; name: string }
  canManage?: boolean
  members: Member[]
}

type AuditResponse = { items: AuditEntry[] }

type NotificationPref = {
  id: string
  organizationId: string
  securityEnabled: boolean
  connectionEnabled: boolean
  synchronizationEnabled: boolean
  accountEnabled: boolean
  inAppEnabled: boolean
  emailEnabled: boolean
  minimumSeverity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  digestMode: 'off' | 'daily' | 'weekly'
}

type AdminTab =
  | 'overview'
  | 'users'
  | 'workspace'
  | 'security'
  | 'notifications'
  | 'audit'

type SortField = 'member' | 'role' | 'status' | 'createdAt'
type SortDirection = 'asc' | 'desc'

type ConfirmModal = {
  type: 'PASSWORD_RESET' | 'MFA_RESET' | 'REMOVE' | 'SUSPEND' | 'REACTIVATE' | 'ROLE_CHANGE'
  member: Member
  targetRole?: MembershipRole
} | null

const roles: Array<{ value: MembershipRole; label: string; description: string }> = [
  { value: 'MSP_OWNER', label: 'MSP owner', description: 'Full workspace and team control.' },
  { value: 'MSP_ADMIN', label: 'MSP admin', description: 'Manages tenant operations and settings.' },
  { value: 'MSP_TECHNICIAN', label: 'Technician', description: 'Works with assigned tenant data.' },
  { value: 'MSP_VIEWER', label: 'Viewer', description: 'Read-only workspace access.' },
]

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function roleLabel(role: MembershipRole): string {
  return roles.find((item) => item.value === role)?.label ?? role
}

function formatActionLabel(action: string): string {
  return action
    .replace(/^WORKSPACE_/, '')
    .replace(/^HAWKVIEW_/, '')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function getInitials(displayName: string | null | undefined, email: string): string {
  if (displayName && displayName.trim()) {
    const parts = displayName.trim().split(/\s+/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return displayName.slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function MemberActionMenu({
  member,
  isFinalOwner,
  onAccountDetails,
  onChangeRole,
  onResendInvitation,
  onPasswordReset,
  onMfaReset,
  onToggleStatus,
  onAuditHistory,
  onRemove,
}: {
  member: Member
  isFinalOwner: boolean
  onAccountDetails: (m: Member) => void
  onChangeRole: (m: Member) => void
  onResendInvitation: (m: Member) => void
  onPasswordReset: (m: Member) => void
  onMfaReset: (m: Member) => void
  onToggleStatus: (m: Member) => void
  onAuditHistory: (m: Member) => void
  onRemove: (m: Member) => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={`Actions for ${member.email}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg text-left animate-in fade-in zoom-in-95 focus:outline-none"
        >
          {/* View Account Details */}
          <DropdownMenu.Item
            onSelect={() => onAccountDetails(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
          >
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            <span>View account details</span>
          </DropdownMenu.Item>

          {/* Change Role */}
          <DropdownMenu.Item
            disabled={isFinalOwner}
            onSelect={() => onChangeRole(member)}
            className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
          >
            <span className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Change role</span>
            </span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </DropdownMenu.Item>

          {/* Resend Invitation (for setup required / pending) */}
          {!member.hasHawkViewAccount && (
            <DropdownMenu.Item
              onSelect={() => onResendInvitation(member)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
            >
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Resend invitation</span>
            </DropdownMenu.Item>
          )}

          {/* Password Reset */}
          <DropdownMenu.Item
            onSelect={() => onPasswordReset(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
          >
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Send HawkView password reset</span>
          </DropdownMenu.Item>

          {/* Reset HawkView MFA */}
          <DropdownMenu.Item
            onSelect={() => onMfaReset(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Reset HawkView MFA</span>
          </DropdownMenu.Item>

          {/* Suspend or Reactivate */}
          <DropdownMenu.Item
            disabled={isFinalOwner}
            onSelect={() => onToggleStatus(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
          >
            {member.status === 'ACTIVE' ? (
              <>
                <UserX className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
                <span>Suspend account</span>
              </>
            ) : (
              <>
                <UserCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>Reactivate account</span>
              </>
            )}
          </DropdownMenu.Item>

          {/* View Administrative History */}
          <DropdownMenu.Item
            onSelect={() => onAuditHistory(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
          >
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span>View administrative history</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="h-px bg-border my-1" />

          {/* Remove Member */}
          <DropdownMenu.Item
            disabled={isFinalOwner}
            onSelect={() => onRemove(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 focus:bg-rose-500/10 focus:outline-none cursor-pointer data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Remove from workspace</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export default function AdminPanelPage() {
  const { session, isLoading: authLoading } = useAuth()
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')

  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPref | null>(null)

  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [prefSaving, setPrefSaving] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Invite form state & modal
  const [inviteModalOpen, setInviteModalOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<MembershipRole>('MSP_TECHNICIAN')
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null)

  // Search & Filter state for Users
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('ALL')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [authStatusFilter, setAuthStatusFilter] = useState<string>('ALL')

  // Sorting state for Users
  const [sortField, setSortField] = useState<SortField>('member')
  const [sortDir, setSortDir] = useState<SortDirection>('asc')

  // Search & Filter state for Audit Log
  const [auditSearch, setAuditSearch] = useState('')
  const [auditActionFilter, setAuditActionFilter] = useState<string>('ALL')
  const [auditOutcomeFilter, setAuditOutcomeFilter] = useState<string>('ALL')

  // Active row overflow menu, modals, and drawers
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [confirmModal, setConfirmModal] = useState<ConfirmModal>(null)
  const [roleChangeMember, setRoleChangeMember] = useState<Member | null>(null)
  const [accountDrawerMember, setAccountDrawerMember] = useState<Member | null>(null)
  const [memberAuditMember, setMemberAuditMember] = useState<Member | null>(null)
  const [auditDrawerEntry, setAuditDrawerEntry] = useState<AuditEntry | null>(null)

  const menuContainerRef = useRef<HTMLDivElement | null>(null)

  const isMspOwner = Boolean(
    session?.user?.memberships?.some((m) => m.role === 'MSP_OWNER')
  )

  const currentUserId = session?.user?.id

  // Primary workspace organization info from session or loaded workspace
  const activeMembership = session?.user?.memberships?.find((m) => m.role === 'MSP_OWNER') || session?.user?.memberships?.[0]
  const orgName = workspace?.organization.name || activeMembership?.organization.name || 'HawkView Workspace'
  const orgSlug = activeMembership?.organization.slug || 'N/A'
  const orgId = workspace?.organization.id || activeMembership?.organization.id || 'N/A'
  const orgStatus = activeMembership?.organization.status || 'ACTIVE'

  const loadAllData = useCallback(async (keepCurrent = false) => {
    if (!keepCurrent) setLoading(true)
    setError(null)
    try {
      const [membersData, auditData, prefsData] = await Promise.all([
        apiClient.get<WorkspaceResponse>('/api/workspace/members'),
        apiClient.get<AuditResponse>('/api/workspace/audit-logs'),
        apiClient.get<NotificationPref>('/api/notifications/preferences').catch(() => null),
      ])
      setWorkspace(membersData)
      setAuditEntries(Array.isArray(auditData?.items) ? auditData.items : [])
      if (prefsData) setNotificationPrefs(prefsData)
    } catch (requestError) {
      setError(errorMessage(requestError, 'Admin Panel information could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isMspOwner) {
      void loadAllData()
    } else {
      setLoading(false)
    }
  }, [isMspOwner, loadAllData])

  // Close menus & drawers on Esc or outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(event.target as Node)
      ) {
        setActiveMenuId(null)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setActiveMenuId(null)
        setInviteModalOpen(false)
        setConfirmModal(null)
        setRoleChangeMember(null)
        setAccountDrawerMember(null)
        setMemberAuditMember(null)
        setAuditDrawerEntry(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Member metrics computations
  const activeOwners = useMemo(() => {
    return (
      workspace?.members.filter(
        (m) => m.role === 'MSP_OWNER' && m.status === 'ACTIVE'
      ) ?? []
    )
  }, [workspace?.members])

  const activeMembersCount = useMemo(() => {
    return workspace?.members.filter((m) => m.status === 'ACTIVE').length ?? 0
  }, [workspace?.members])

  const suspendedMembersCount = useMemo(() => {
    return workspace?.members.filter((m) => m.status === 'SUSPENDED').length ?? 0
  }, [workspace?.members])

  const pendingSetupCount = useMemo(() => {
    return workspace?.members.filter((m) => m.hasHawkViewAccount === false).length ?? 0
  }, [workspace?.members])

  const isFinalActiveOwner = useCallback(
    (member: Member) => {
      return (
        member.role === 'MSP_OWNER' &&
        member.status === 'ACTIVE' &&
        activeOwners.length <= 1
      )
    },
    [activeOwners.length]
  )

  // Filter & sort members
  const filteredMembers = useMemo(() => {
    if (!workspace?.members) return []
    return workspace.members.filter((member) => {
      const q = searchQuery.trim().toLowerCase()
      const matchesSearch =
        !q ||
        (member.displayName && member.displayName.toLowerCase().includes(q)) ||
        member.email.toLowerCase().includes(q)

      const matchesRole = roleFilter === 'ALL' || member.role === roleFilter
      const matchesStatus = statusFilter === 'ALL' || member.status === statusFilter
      const matchesAuthStatus =
        authStatusFilter === 'ALL' ||
        (authStatusFilter === 'CONFIGURED' && member.hasHawkViewAccount === true) ||
        (authStatusFilter === 'AWAITING_SETUP' && member.hasHawkViewAccount === false)

      return matchesSearch && matchesRole && matchesStatus && matchesAuthStatus
    })
  }, [workspace?.members, searchQuery, roleFilter, statusFilter, authStatusFilter])

  const sortedMembers = useMemo(() => {
    return [...filteredMembers].sort((a, b) => {
      let cmp = 0
      if (sortField === 'member') {
        const nameA = (a.displayName || a.email).toLowerCase()
        const nameB = (b.displayName || b.email).toLowerCase()
        cmp = nameA.localeCompare(nameB)
      } else if (sortField === 'role') {
        const roleRank = {
          MSP_OWNER: 1,
          MSP_ADMIN: 2,
          MSP_TECHNICIAN: 3,
          MSP_VIEWER: 4,
        }
        cmp = (roleRank[a.role] || 99) - (roleRank[b.role] || 99)
      } else if (sortField === 'status') {
        cmp = a.status.localeCompare(b.status)
      } else if (sortField === 'createdAt') {
        const dateA = new Date(a.joinedAt || a.createdAt || 0).getTime()
        const dateB = new Date(b.joinedAt || b.createdAt || 0).getTime()
        cmp = dateA - dateB
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredMembers, sortField, sortDir])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  // Filter audit logs
  const filteredAuditLogs = useMemo(() => {
    return auditEntries.filter((entry) => {
      const q = auditSearch.trim().toLowerCase()
      const matchesSearch =
        !q ||
        entry.action.toLowerCase().includes(q) ||
        (entry.actorEmail && entry.actorEmail.toLowerCase().includes(q)) ||
        (entry.targetEmail && entry.targetEmail.toLowerCase().includes(q))

      const matchesAction =
        auditActionFilter === 'ALL' || entry.action === auditActionFilter
      const matchesOutcome =
        auditOutcomeFilter === 'ALL' || entry.outcome === auditOutcomeFilter

      return matchesSearch && matchesAction && matchesOutcome
    })
  }, [auditEntries, auditSearch, auditActionFilter, auditOutcomeFilter])

  // Action runners
  const runAction = async (action: () => Promise<unknown>, successNotice: string) => {
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(successNotice)
      await loadAllData(true)
    } catch (requestError) {
      setError(errorMessage(requestError, 'That administrative action could not be completed.'))
    } finally {
      setSubmitting(false)
      setActiveMenuId(null)
      setConfirmModal(null)
      setRoleChangeMember(null)
    }
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    setInviteEmailError(null)

    const trimmedEmail = inviteEmail.trim()
    if (!trimmedEmail) {
      setInviteEmailError('Email address is required.')
      return
    }
    if (!isValidEmail(trimmedEmail)) {
      setInviteEmailError('Please enter a valid email address.')
      return
    }

    await runAction(
      () =>
        apiClient.post('/api/workspace/members/invite', {
          email: trimmedEmail,
          displayName: inviteName.trim() || undefined,
          role: inviteRole,
        }),
      `Invitation sent to ${trimmedEmail}. The member will receive a secure HawkView setup link.`
    )
    setInviteModalOpen(false)
    setInviteEmail('')
    setInviteName('')
    setInviteRole('MSP_TECHNICIAN')
    setInviteEmailError(null)
  }

  const handleResendInvitation = async (member: Member) => {
    await runAction(
      () =>
        apiClient.post('/api/workspace/members/invite', {
          email: member.email,
          displayName: member.displayName || undefined,
          role: member.role,
        }),
      `Invitation re-sent to ${member.email}. The member will receive a secure HawkView setup link.`
    )
  }

  const handleExecuteModalAction = async () => {
    if (!confirmModal) return
    const { type, member, targetRole } = confirmModal

    if (type === 'ROLE_CHANGE' && targetRole) {
      await runAction(
        () =>
          apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { role: targetRole }
          ),
        `Role updated to ${roleLabel(targetRole)} for ${member.email}.`
      )
    } else if (type === 'SUSPEND' || type === 'REACTIVATE') {
      const nextStatus = type === 'SUSPEND' ? 'SUSPENDED' : 'ACTIVE'
      await runAction(
        () =>
          apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { status: nextStatus }
          ),
        `${member.email} is now ${nextStatus === 'ACTIVE' ? 'active' : 'suspended'}.`
      )
    } else if (type === 'PASSWORD_RESET') {
      await runAction(
        () =>
          apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/password-reset`
          ),
        `A HawkView account password-reset email was sent to ${member.email}.`
      )
    } else if (type === 'MFA_RESET') {
      await runAction(
        () =>
          apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/mfa-reset`
          ),
        `HawkView MFA was reset for ${member.email}.`
      )
    } else if (type === 'REMOVE') {
      await runAction(
        () =>
          apiClient.delete(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`
          ),
        `${member.email} was removed from this HawkView workspace.`
      )
    }
  }

  const handleUpdateNotificationPref = async (field: keyof NotificationPref, value: unknown) => {
    if (!notificationPrefs) return
    setPrefSaving(true)
    setError(null)
    try {
      const updated = await apiClient.patch<NotificationPref>('/api/notifications/preferences', {
        [field]: value,
      })
      setNotificationPrefs(updated)
      setNotice('Notification preferences updated successfully.')
    } catch (requestError) {
      setError(errorMessage(requestError, 'Failed to update notification preferences.'))
    } finally {
      setPrefSaving(false)
    }
  }

  // Auth loading state
  if (authLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <p className="text-sm text-muted-foreground">Verifying workspace permissions…</p>
      </div>
    )
  }

  // Non-owner restriction card
  if (!isMspOwner) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4 space-y-4">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-3">
          <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-500 font-semibold text-base">
            <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>Access Restricted</span>
          </div>
          <p className="text-sm text-foreground">
            The Admin Panel and workspace member administration are reserved for HawkView MSP workspace owners.
          </p>
          <p className="text-xs text-muted-foreground">
            If you require administrative access, please contact an existing owner of your workspace.
          </p>
        </div>
      </div>
    )
  }

  const tabs: Array<{ id: AdminTab; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'users', label: 'User Management', icon: Users },
    { id: 'workspace', label: 'Workspace', icon: Building },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'audit', label: 'Audit History', icon: History },
  ]

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* 1. Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Admin Panel
            </h1>
            <span className="text-xs text-muted-foreground font-normal">
              · {orgName}
            </span>
          </div>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground">
            Manage your MSP workspace, team access, and HawkView security.
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
            <span>Controls in this area affect HawkView accounts only, not Microsoft 365 identities or credentials.</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadAllData(true)}
          disabled={loading || submitting}
          className="h-8 text-xs gap-1.5 shrink-0 self-start sm:self-auto"
        >
          <RefreshCcw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>Refresh</span>
        </Button>
      </div>

      {/* Global Alerts / Toasts */}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 hover:opacity-75 focus-visible:outline-none"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="flex items-center justify-between rounded-lg border border-emerald-300/80 bg-emerald-50/80 px-3.5 py-2.5 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="p-1 hover:opacity-75 focus-visible:outline-none"
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 2. Compact Navigation Tabs */}
      <div className="border-b border-border overflow-x-auto">
        <nav className="flex space-x-1 sm:space-x-2 min-w-max" aria-label="Admin panel sections">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-3 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-t-md ${
                  isActive
                    ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 bg-blue-50/30 dark:bg-blue-950/20'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* 3. SECTION CONTENT */}

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Workspace Summary Band */}
          <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 divide-y sm:divide-y-0 sm:divide-x divide-border">
              {/* Workspace */}
              <div className="sm:pr-4 space-y-0.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Workspace
                </p>
                <p className="text-sm font-semibold text-foreground truncate">{orgName}</p>
                <p className="text-xs text-muted-foreground">
                  Slug: <code className="text-foreground">{orgSlug}</code>
                </p>
              </div>

              {/* Team members */}
              <div className="pt-3 sm:pt-0 sm:px-4 space-y-0.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Team members
                </p>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-foreground">
                    {loading ? '…' : workspace?.members.length ?? 0} total
                  </span>
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    ({activeMembersCount} active)
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {suspendedMembersCount > 0 ? `${suspendedMembersCount} suspended` : 'No suspended accounts'}
                </p>
              </div>

              {/* Active owners */}
              <div className="pt-3 sm:pt-0 sm:px-4 space-y-0.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Active owners
                </p>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-foreground">
                    {loading ? '…' : activeOwners.length} active owner{activeOwners.length === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {activeOwners.length <= 1 ? 'Single owner protection' : 'Multi-owner redundancy'}
                </p>
              </div>

              {/* Authentication */}
              <div className="pt-3 sm:pt-0 sm:pl-4 space-y-0.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Authentication
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {session?.signInProvider ? `${session.signInProvider.toUpperCase()}` : 'Supabase Auth'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {pendingSetupCount > 0 ? `${pendingSetupCount} awaiting setup` : 'All members configured'}
                </p>
              </div>
            </div>
          </div>

          {/* Common Tasks */}
          <div className="space-y-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Common tasks
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <button
                type="button"
                onClick={() => setActiveTab('users')}
                className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card hover:bg-accent/60 transition-colors text-left group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    Invite team member
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">Add technician or owner</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('users')}
                className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card hover:bg-accent/60 transition-colors text-left group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Users className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    Manage team members
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">Roles, MFA & status</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('security')}
                className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card hover:bg-accent/60 transition-colors text-left group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    Review workspace security
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">Auth methods & policies</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('audit')}
                className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card hover:bg-accent/60 transition-colors text-left group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <History className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    View audit history
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">Administrative logs</p>
                </div>
              </button>
            </div>
          </div>

          {/* Recent Administrative Activity Preview */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-xs font-semibold text-foreground">Recent Administrative Activity</h3>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveTab('audit')}
                className="h-6 px-2 text-xs gap-1 text-blue-600 dark:text-blue-400 hover:text-blue-700"
              >
                <span>View all</span>
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>

            {auditEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">
                No administrative activity has been recorded.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {auditEntries.slice(0, 5).map((entry) => (
                  <div
                    key={entry.id}
                    className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs"
                  >
                    <div>
                      <span className="font-semibold text-foreground">
                        {formatActionLabel(entry.action)}
                      </span>
                      <span className="text-muted-foreground ml-2">
                        {entry.actorEmail || 'Unknown owner'} → {entry.targetEmail || 'Workspace'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 text-muted-foreground text-[11px]">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.2 rounded font-medium ${
                          entry.outcome === 'SUCCEEDED'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {entry.outcome}
                      </span>
                      <span>·</span>
                      <span>{formatDateTime(entry.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: USER MANAGEMENT */}
      {activeTab === 'users' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Members Card */}
          <div className="rounded-xl border border-border bg-card shadow-sm">
            {/* Header Toolbar */}
            <div className="p-4 border-b border-border space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span>Team members</span>
                    </h2>
                    {workspace?.members && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground border border-border/60">
                        {workspace.members.length}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Manage HawkView MSP accounts, administrative roles, security settings, and permissions.
                  </p>
                </div>

                <Button
                  size="sm"
                  onClick={() => {
                    setInviteEmailError(null)
                    setInviteModalOpen(true)
                  }}
                  className="h-8 text-xs font-semibold gap-1.5 shrink-0"
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Invite member</span>
                </Button>
              </div>

              {/* Toolbar Search & Filters */}
              <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2.5 pt-1">
                {/* Search */}
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search member by name or email…"
                    className="pl-8 h-8 text-xs"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Filter by role"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All roles</option>
                    {roles.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>

                  <select
                    aria-label="Filter by account status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All statuses</option>
                    <option value="ACTIVE">Active</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>

                  <select
                    aria-label="Filter by authentication state"
                    value={authStatusFilter}
                    onChange={(e) => setAuthStatusFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All auth states</option>
                    <option value="CONFIGURED">Authentication configured</option>
                    <option value="AWAITING_SETUP">Authentication setup required</option>
                  </select>

                  {(searchQuery || roleFilter !== 'ALL' || statusFilter !== 'ALL' || authStatusFilter !== 'ALL') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('')
                        setRoleFilter('ALL')
                        setStatusFilter('ALL')
                        setAuthStatusFilter('ALL')
                      }}
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-muted/60 border-b border-border">
                  <tr className="font-semibold text-muted-foreground">
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('member')}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Member</span>
                        {sortField === 'member' ? (
                          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('role')}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Role</span>
                        {sortField === 'role' ? (
                          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('status')}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Status</span>
                        {sortField === 'status' ? (
                          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>
                    <th scope="col" className="py-2.5 px-4">
                      Authentication
                    </th>
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('createdAt')}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Added</span>
                        {sortField === 'createdAt' ? (
                          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>
                    <th scope="col" className="py-2.5 px-4 text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading && !workspace ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">
                        Loading workspace team members…
                      </td>
                    </tr>
                  ) : sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground space-y-2">
                        <p>
                          {workspace?.members.length === 0
                            ? 'No workspace members available.'
                            : 'No members match your search or filter criteria.'}
                        </p>
                        {(searchQuery || roleFilter !== 'ALL' || statusFilter !== 'ALL' || authStatusFilter !== 'ALL') && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSearchQuery('')
                              setRoleFilter('ALL')
                              setStatusFilter('ALL')
                              setAuthStatusFilter('ALL')
                            }}
                            className="h-7 text-xs"
                          >
                            Reset filters
                          </Button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    sortedMembers.map((member) => {
                      const isSelf = member.userId === currentUserId
                      const isFinalOwner = isFinalActiveOwner(member)
                      const initials = getInitials(member.displayName, member.email)

                      return (
                        <tr
                          key={member.membershipId}
                          className="hover:bg-muted/30 transition-colors"
                        >
                          {/* Member Column */}
                          <td className="py-3 px-4 font-medium">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 border border-border/80 text-foreground text-xs font-bold flex items-center justify-center shrink-0">
                                {initials}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setAccountDrawerMember(member)}
                                    className="font-semibold text-foreground hover:text-blue-600 hover:underline text-left truncate focus-visible:outline-none"
                                  >
                                    {member.displayName || member.email}
                                  </button>
                                  {isSelf && (
                                    <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border/60 shrink-0">
                                      You
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-muted-foreground font-normal truncate">
                                  {member.email}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Role Column */}
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-border/80 bg-muted/40 text-foreground">
                              {roleLabel(member.role)}
                            </span>
                          </td>

                          {/* Status Column */}
                          <td className="py-3 px-4">
                            {member.status === 'ACTIVE' ? (
                              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-medium text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                Suspended
                              </span>
                            )}
                          </td>

                          {/* Authentication Column */}
                          <td className="py-3 px-4 text-xs">
                            {member.hasHawkViewAccount ? (
                              <div className="group relative inline-flex items-center gap-1 font-medium text-foreground cursor-help">
                                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                                <span>Authentication configured</span>
                                <div className="absolute left-0 bottom-full mb-1.5 hidden group-hover:block z-30 w-56 rounded-md bg-popover border border-border p-2 text-[11px] font-normal text-popover-foreground shadow-md pointer-events-none">
                                  HawkView MSP console login account is active and configured.
                                </div>
                              </div>
                            ) : (
                              <div className="group relative inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400 cursor-help">
                                <Clock className="h-3.5 w-3.5 shrink-0" />
                                <span>Authentication setup required</span>
                                <div className="absolute left-0 bottom-full mb-1.5 hidden group-hover:block z-30 w-56 rounded-md bg-popover border border-border p-2 text-[11px] font-normal text-popover-foreground shadow-md pointer-events-none">
                                  Member needs to set up their HawkView console password.
                                </div>
                              </div>
                            )}
                          </td>

                          {/* Added Column */}
                          <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                            {formatDate(member.joinedAt || member.createdAt)}
                          </td>

                          {/* Actions Column */}
                          <td className="py-3 px-4 text-right">
                            <MemberActionMenu
                              member={member}
                              isFinalOwner={isFinalOwner}
                              onAccountDetails={setAccountDrawerMember}
                              onChangeRole={setRoleChangeMember}
                              onResendInvitation={handleResendInvitation}
                              onPasswordReset={(m) => setConfirmModal({ type: 'PASSWORD_RESET', member: m })}
                              onMfaReset={(m) => setConfirmModal({ type: 'MFA_RESET', member: m })}
                              onToggleStatus={(m) =>
                                setConfirmModal({
                                  type: m.status === 'ACTIVE' ? 'SUSPEND' : 'REACTIVATE',
                                  member: m,
                                })
                              }
                              onAuditHistory={setMemberAuditMember}
                              onRemove={(m) => setConfirmModal({ type: 'REMOVE', member: m })}
                            />
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Member Cards */}
            <div className="block sm:hidden divide-y divide-border">
              {loading && !workspace ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  Loading workspace team members…
                </div>
              ) : sortedMembers.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
                  <p>
                    {workspace?.members.length === 0
                      ? 'No workspace members available.'
                      : 'No members match search or filter criteria.'}
                  </p>
                  {(searchQuery || roleFilter !== 'ALL' || statusFilter !== 'ALL' || authStatusFilter !== 'ALL') && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('')
                        setRoleFilter('ALL')
                        setStatusFilter('ALL')
                        setAuthStatusFilter('ALL')
                      }}
                      className="h-7 text-xs"
                    >
                      Reset filters
                    </Button>
                  )}
                </div>
              ) : (
                sortedMembers.map((member) => {
                  const isSelf = member.userId === currentUserId
                  const isFinalOwner = isFinalActiveOwner(member)
                  const initials = getInitials(member.displayName, member.email)

                  return (
                    <div key={member.membershipId} className="p-3.5 space-y-2.5 bg-card hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 border border-border/80 text-foreground text-xs font-bold flex items-center justify-center shrink-0">
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-xs text-foreground truncate">
                                {member.displayName || member.email}
                              </span>
                              {isSelf && (
                                <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border/60 shrink-0">
                                  You
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">{member.email}</p>
                          </div>
                        </div>

                        {/* Actions Button */}
                        <div>
                          <MemberActionMenu
                            member={member}
                            isFinalOwner={isFinalOwner}
                            onAccountDetails={setAccountDrawerMember}
                            onChangeRole={setRoleChangeMember}
                            onResendInvitation={handleResendInvitation}
                            onPasswordReset={(m) => setConfirmModal({ type: 'PASSWORD_RESET', member: m })}
                            onMfaReset={(m) => setConfirmModal({ type: 'MFA_RESET', member: m })}
                            onToggleStatus={(m) =>
                              setConfirmModal({
                                type: m.status === 'ACTIVE' ? 'SUSPEND' : 'REACTIVATE',
                                member: m,
                              })
                            }
                            onAuditHistory={setMemberAuditMember}
                            onRemove={(m) => setConfirmModal({ type: 'REMOVE', member: m })}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-border/40">
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Role</span>
                          <span className="font-medium text-foreground">{roleLabel(member.role)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Status</span>
                          {member.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                              Suspended
                            </span>
                          )}
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Authentication</span>
                          {member.hasHawkViewAccount ? (
                            <span className="text-foreground font-medium flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              Configured
                            </span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                              <Clock className="h-3.5 w-3.5" />
                              Setup required
                            </span>
                          )}
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Added</span>
                          <span className="text-muted-foreground">{formatDate(member.joinedAt || member.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: WORKSPACE */}
      {activeTab === 'workspace' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Building className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <h2 className="text-sm font-bold text-foreground">Workspace Settings & Details</h2>
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-border">
                Saving support coming later
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Workspace Name</Label>
                <Input value={orgName} readOnly className="h-8 text-xs bg-muted/30" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Organization Slug</Label>
                <Input value={orgSlug} readOnly className="h-8 text-xs bg-muted/30" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Workspace ID</Label>
                <Input value={orgId} readOnly className="h-8 text-xs bg-muted/30 font-mono text-[11px]" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Workspace Status</Label>
                <Input value={orgStatus} readOnly className="h-8 text-xs bg-muted/30" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Support Contact Email</Label>
                <Input value="Not configured" readOnly className="h-8 text-xs bg-muted/30 text-muted-foreground" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Default Time Zone</Label>
                <Input value={session?.user.timeZone || 'UTC'} readOnly className="h-8 text-xs bg-muted/30" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Default Date Format</Label>
                <Input value={session?.user.dateFormat || 'YYYY-MM-DD'} readOnly className="h-8 text-xs bg-muted/30" />
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Default Time Format</Label>
                <Input value={session?.user.timeFormat === '24h' ? '24-hour' : '12-hour'} readOnly className="h-8 text-xs bg-muted/30" />
              </div>
            </div>
          </div>

          {/* Owner-Only Danger Zone */}
          <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/20 dark:bg-rose-950/10 p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2 border-b border-rose-200 dark:border-rose-900/60 pb-2.5">
              <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
              <div>
                <h3 className="text-sm font-bold text-rose-900 dark:text-rose-200">Danger Zone</h3>
                <p className="text-xs text-rose-700 dark:text-rose-400">
                  Critical workspace operations. These actions do not delete or modify connected Microsoft 365 tenants.
                </p>
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
                <div>
                  <p className="text-xs font-semibold text-foreground">Transfer Workspace Ownership</p>
                  <p className="text-[11px] text-muted-foreground">Assign primary ownership to another active owner.</p>
                </div>
                <Button size="sm" variant="outline" disabled className="h-7 text-xs">
                  Backend support required
                </Button>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
                <div>
                  <p className="text-xs font-semibold text-foreground">Disable Workspace</p>
                  <p className="text-[11px] text-muted-foreground">Suspend access to this HawkView workspace console.</p>
                </div>
                <Button size="sm" variant="outline" disabled className="h-7 text-xs">
                  Backend support required
                </Button>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
                <div>
                  <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">Delete Workspace</p>
                  <p className="text-[11px] text-muted-foreground">Permanently erase this HawkView workspace data.</p>
                </div>
                <Button size="sm" variant="destructive" disabled className="h-7 text-xs">
                  Backend support required
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SECURITY */}
      {activeTab === 'security' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <div className="flex items-center gap-2 border-b border-border pb-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <h2 className="text-sm font-bold text-foreground">Authentication & MFA Status</h2>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Primary Auth Provider</span>
                  <span className="font-semibold text-foreground">Supabase Auth (Email & OAuth)</span>
                </div>
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Google Sign-In</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">Enabled</span>
                </div>
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Microsoft Sign-In</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">Enabled</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-muted-foreground">HawkView MFA</span>
                  <span className="font-semibold text-foreground">Supported (TOTP Enrollment)</span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <div className="flex items-center gap-2 border-b border-border pb-2.5">
                <Lock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <h2 className="text-sm font-bold text-foreground">Security Posture Metrics</h2>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Active MSP Owners</span>
                  <span className="font-semibold text-foreground">{activeOwners.length}</span>
                </div>
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Suspended Accounts</span>
                  <span className="font-semibold text-foreground">{suspendedMembersCount}</span>
                </div>
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted-foreground">Password Reset Events</span>
                  <span className="font-semibold text-foreground">
                    {auditEntries.filter((a) => a.action.includes('PASSWORD_RESET')).length}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-muted-foreground">MFA Reset Events</span>
                  <span className="font-semibold text-foreground">
                    {auditEntries.filter((a) => a.action.includes('MFA_RESET')).length}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-bold text-foreground">Workspace Security Policies</h2>
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-border">
                Configuration support coming later
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
                <div>
                  <p className="font-semibold text-foreground">Require HawkView MFA</p>
                  <p className="text-[11px] text-muted-foreground">Mandate multi-factor authentication for all workspace members.</p>
                </div>
                <input type="checkbox" disabled className="h-4 w-4 opacity-50" />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
                <div>
                  <p className="font-semibold text-foreground">Restrict Invitations by Email Domain</p>
                  <p className="text-[11px] text-muted-foreground">Allow invitations only to matching company domain addresses.</p>
                </div>
                <input type="checkbox" disabled className="h-4 w-4 opacity-50" />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
                <div>
                  <p className="font-semibold text-foreground">Session Timeout Duration</p>
                  <p className="text-[11px] text-muted-foreground">Current session inactivity timeout setting.</p>
                </div>
                <span className="text-muted-foreground font-mono">24 Hours (Default)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: NOTIFICATIONS */}
      {activeTab === 'notifications' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <h2 className="text-sm font-bold text-foreground">Administrative Notification Preferences</h2>
              </div>
              {prefSaving && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <RefreshCcw className="h-3 w-3 animate-spin" />
                  Saving…
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Configure delivery settings for workspace security alerts, team membership events, and tenant synchronization triggers.
            </p>

            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                <div>
                  <p className="text-xs font-semibold text-foreground">Security Alerts</p>
                  <p className="text-[11px] text-muted-foreground">Password resets, MFA resets, and role changes.</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationPrefs?.securityEnabled ?? true}
                  disabled={prefSaving || !notificationPrefs}
                  onChange={(e) => void handleUpdateNotificationPref('securityEnabled', e.target.checked)}
                  className="h-4 w-4 rounded border-input text-blue-600 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                <div>
                  <p className="text-xs font-semibold text-foreground">Tenant Connection Alerts</p>
                  <p className="text-[11px] text-muted-foreground">Microsoft 365 consent issues and connector authorization updates.</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationPrefs?.connectionEnabled ?? true}
                  disabled={prefSaving || !notificationPrefs}
                  onChange={(e) => void handleUpdateNotificationPref('connectionEnabled', e.target.checked)}
                  className="h-4 w-4 rounded border-input text-blue-600 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                <div>
                  <p className="text-xs font-semibold text-foreground">Synchronization Failures</p>
                  <p className="text-[11px] text-muted-foreground">Tenant sync errors and baseline compliance drift warnings.</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationPrefs?.synchronizationEnabled ?? true}
                  disabled={prefSaving || !notificationPrefs}
                  onChange={(e) => void handleUpdateNotificationPref('synchronizationEnabled', e.target.checked)}
                  className="h-4 w-4 rounded border-input text-blue-600 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border">
                <div>
                  <p className="text-xs font-semibold text-foreground">Team Member Events</p>
                  <p className="text-[11px] text-muted-foreground">Member invitations, account setup, and suspensions.</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationPrefs?.accountEnabled ?? true}
                  disabled={prefSaving || !notificationPrefs}
                  onChange={(e) => void handleUpdateNotificationPref('accountEnabled', e.target.checked)}
                  className="h-4 w-4 rounded border-input text-blue-600 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-foreground">Minimum Severity Threshold</Label>
                  <select
                    value={notificationPrefs?.minimumSeverity || 'info'}
                    disabled={prefSaving || !notificationPrefs}
                    onChange={(e) => void handleUpdateNotificationPref('minimumSeverity', e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                  >
                    <option value="info">Info (All notifications)</option>
                    <option value="low">Low severity and above</option>
                    <option value="medium">Medium severity and above</option>
                    <option value="high">High severity and above</option>
                    <option value="critical">Critical only</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs font-medium text-foreground">Digest Delivery Mode</Label>
                  <select
                    value={notificationPrefs?.digestMode || 'off'}
                    disabled={prefSaving || !notificationPrefs}
                    onChange={(e) => void handleUpdateNotificationPref('digestMode', e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                  >
                    <option value="off">Real-time / Instant</option>
                    <option value="daily">Daily Summary Digest</option>
                    <option value="weekly">Weekly Summary Digest</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: AUDIT HISTORY */}
      {activeTab === 'audit' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {/* Toolbar */}
            <div className="p-4 border-b border-border space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-bold text-foreground">Administrative Activity Audit History</h2>
                </div>
                <span className="text-xs text-muted-foreground font-medium">
                  {filteredAuditLogs.length} event(s)
                </span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="text"
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    placeholder="Search by action, actor, or target email…"
                    className="pl-8 h-8 text-xs"
                  />
                  {auditSearch && (
                    <button
                      type="button"
                      onClick={() => setAuditSearch('')}
                      className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <select
                    aria-label="Filter by outcome"
                    value={auditOutcomeFilter}
                    onChange={(e) => setAuditOutcomeFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All outcomes</option>
                    <option value="SUCCEEDED">Succeeded</option>
                    <option value="FAILED">Failed</option>
                  </select>

                  {(auditSearch || auditOutcomeFilter !== 'ALL') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAuditSearch('')
                        setAuditOutcomeFilter('ALL')
                      }}
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Audit Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/40 font-semibold text-muted-foreground">
                    <th scope="col" className="py-2.5 px-4">Date & Time</th>
                    <th scope="col" className="py-2.5 px-4">Action</th>
                    <th scope="col" className="py-2.5 px-4">Affected Target</th>
                    <th scope="col" className="py-2.5 px-4">Performed By</th>
                    <th scope="col" className="py-2.5 px-4">Outcome</th>
                    <th scope="col" className="py-2.5 px-4 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredAuditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">
                        No audit history entries found matching your search criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredAuditLogs.map((entry) => (
                      <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                          {formatDateTime(entry.createdAt)}
                        </td>
                        <td className="py-3 px-4 font-semibold text-foreground">
                          {formatActionLabel(entry.action)}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {entry.targetEmail || 'Workspace'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {entry.actorEmail || 'Unknown owner'}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                              entry.outcome === 'SUCCEEDED'
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {entry.outcome}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setAuditDrawerEntry(entry)}
                            className="h-7 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700"
                          >
                            View detail
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 4. MODALS & DRAWERS */}

      {/* Account Details Drawer */}
      {accountDrawerMember && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="drawer-title"
            className="w-full max-w-md bg-popover text-popover-foreground border-l border-border p-6 shadow-2xl space-y-5 overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="drawer-title" className="text-base font-bold text-foreground">
                  Member Account Details
                </h3>
                <p className="text-xs text-muted-foreground">{accountDrawerMember.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setAccountDrawerMember(null)}
                className="text-muted-foreground hover:text-foreground p-1"
                aria-label="Close drawer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <p className="text-[11px] font-medium text-muted-foreground">Full Name</p>
                <p className="font-semibold text-foreground">
                  {accountDrawerMember.displayName || 'Not specified'}
                </p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <p className="text-[11px] font-medium text-muted-foreground">Workspace Role</p>
                <p className="font-semibold text-foreground">{roleLabel(accountDrawerMember.role)}</p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <p className="text-[11px] font-medium text-muted-foreground">Account Status</p>
                <p className={`font-semibold ${accountDrawerMember.status === 'ACTIVE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
                  {accountDrawerMember.status}
                </p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <p className="text-[11px] font-medium text-muted-foreground">HawkView Account Status</p>
                <p className="font-semibold text-foreground">
                  {accountDrawerMember.hasHawkViewAccount
                    ? 'Configured (Active Auth Provider ID)'
                    : 'Awaiting initial setup / invitation acceptance'}
                </p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <p className="text-[11px] font-medium text-muted-foreground">Workspace Added Date</p>
                <p className="font-semibold text-foreground">
                  {formatDateTime(accountDrawerMember.joinedAt || accountDrawerMember.createdAt)}
                </p>
              </div>

              <div className="border-t border-border pt-3 space-y-2">
                <h4 className="font-bold text-foreground">Recent Audit Actions for this Account</h4>
                {auditEntries.filter((a) => a.targetEmail === accountDrawerMember.email).length === 0 ? (
                  <p className="text-muted-foreground">No recent administrative actions recorded for this account.</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {auditEntries
                      .filter((a) => a.targetEmail === accountDrawerMember.email)
                      .slice(0, 5)
                      .map((action) => (
                        <div key={action.id} className="p-2 rounded bg-muted/50 text-[11px] flex justify-between">
                          <span>{formatActionLabel(action.action)}</span>
                          <span className="text-muted-foreground">{formatDate(action.createdAt)}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-4 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAccountDrawerMember(null)}
                className="h-8 text-xs"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Detail Drawer */}
      {auditDrawerEntry && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-drawer-title"
            className="w-full max-w-md bg-popover text-popover-foreground border-l border-border p-6 shadow-2xl space-y-5 overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="audit-drawer-title" className="text-base font-bold text-foreground">
                  Audit Log Details
                </h3>
                <p className="text-xs text-muted-foreground">{formatActionLabel(auditDrawerEntry.action)}</p>
              </div>
              <button
                type="button"
                onClick={() => setAuditDrawerEntry(null)}
                className="text-muted-foreground hover:text-foreground p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <p className="text-muted-foreground text-[11px]">Event ID</p>
                <p className="font-mono text-[11px] text-foreground">{auditDrawerEntry.id}</p>
              </div>

              <div>
                <p className="text-muted-foreground text-[11px]">Timestamp</p>
                <p className="font-semibold text-foreground">{formatDateTime(auditDrawerEntry.createdAt)}</p>
              </div>

              <div>
                <p className="text-muted-foreground text-[11px]">Action</p>
                <p className="font-semibold text-foreground">{auditDrawerEntry.action}</p>
              </div>

              <div>
                <p className="text-muted-foreground text-[11px]">Outcome</p>
                <p className={`font-semibold ${auditDrawerEntry.outcome === 'SUCCEEDED' ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {auditDrawerEntry.outcome}
                </p>
              </div>

              <div>
                <p className="text-muted-foreground text-[11px]">Performed By</p>
                <p className="font-semibold text-foreground">{auditDrawerEntry.actorEmail || 'Unknown owner'}</p>
              </div>

              <div>
                <p className="text-muted-foreground text-[11px]">Affected Target</p>
                <p className="font-semibold text-foreground">{auditDrawerEntry.targetEmail || 'Workspace'}</p>
              </div>

              {auditDrawerEntry.metadata && (
                <div>
                  <p className="text-muted-foreground text-[11px] mb-1">Event Metadata</p>
                  <pre className="p-3 rounded-lg bg-muted text-[11px] font-mono overflow-x-auto">
                    {JSON.stringify(auditDrawerEntry.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="border-t border-border pt-4 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAuditDrawerEntry(null)}
                className="h-8 text-xs"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Role Change Modal */}
      {roleChangeMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="role-change-title"
            className="w-full max-w-md rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 id="role-change-title" className="text-sm font-bold">
                Change role for {roleChangeMember.displayName || roleChangeMember.email}
              </h3>
              <button
                type="button"
                onClick={() => setRoleChangeMember(null)}
                className="text-muted-foreground hover:text-foreground p-1"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground">
              Select the new workspace role for <strong>{roleChangeMember.email}</strong>:
            </p>

            <div className="space-y-2">
              {roles.map((r) => {
                const isSelected = roleChangeMember.role === r.value
                return (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => {
                      setConfirmModal({
                        type: 'ROLE_CHANGE',
                        member: roleChangeMember,
                        targetRole: r.value,
                      })
                      setRoleChangeMember(null)
                    }}
                    className={`w-full flex items-start justify-between p-3 rounded-lg border text-left text-xs transition-colors ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                        : 'border-border hover:bg-accent'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-foreground">{r.label}</p>
                      <p className="text-[11px] text-muted-foreground">{r.description}</p>
                    </div>
                    {isSelected && (
                      <span className="text-blue-600 dark:text-blue-400 font-medium text-[11px]">
                        Current
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRoleChangeMember(null)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-modal-title"
            className="w-full max-w-md rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl space-y-4"
          >
            <div className="flex items-center gap-2.5">
              {confirmModal.type === 'REMOVE' ? (
                <div className="p-2 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
                  <Trash2 className="h-5 w-5" />
                </div>
              ) : confirmModal.type === 'SUSPEND' ? (
                <div className="p-2 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <UserX className="h-5 w-5" />
                </div>
              ) : (
                <div className="p-2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
              )}

              <div>
                <h3 id="confirm-modal-title" className="text-sm font-bold">
                  {confirmModal.type === 'ROLE_CHANGE'
                    ? `Change role to ${roleLabel(confirmModal.targetRole!)}?`
                    : confirmModal.type === 'SUSPEND'
                    ? 'Suspend member account?'
                    : confirmModal.type === 'REACTIVATE'
                    ? 'Reactivate member account?'
                    : confirmModal.type === 'PASSWORD_RESET'
                    ? 'Send HawkView password reset?'
                    : confirmModal.type === 'MFA_RESET'
                    ? 'Reset HawkView MFA?'
                    : 'Remove from workspace?'}
                </h3>
                <p className="text-xs text-muted-foreground">{confirmModal.member.email}</p>
              </div>
            </div>

            <div className="text-xs text-muted-foreground space-y-2 bg-muted/40 p-3 rounded-lg border border-border">
              {confirmModal.type === 'PASSWORD_RESET' && (
                <p>
                  A password reset email will be sent for this user&apos;s <strong>HawkView account</strong>. This action does not affect Microsoft 365 passwords or tenant credentials.
                </p>
              )}
              {confirmModal.type === 'MFA_RESET' && (
                <p>
                  This removes multi-factor authentication enrollment for their <strong>HawkView account</strong>. The member will be required to re-enroll MFA on their next HawkView sign-in. This does not alter Microsoft Entra ID or M365 MFA.
                </p>
              )}
              {confirmModal.type === 'REMOVE' && (
                <p>
                  This will immediately remove <strong>{confirmModal.member.email}</strong> from this HawkView workspace.
                </p>
              )}
              {confirmModal.type === 'SUSPEND' && (
                <p>
                  The member will be suspended from logging into this HawkView workspace.
                </p>
              )}
              {confirmModal.type === 'REACTIVATE' && (
                <p>
                  The member&apos;s access to this HawkView workspace will be restored.
                </p>
              )}
              {confirmModal.type === 'ROLE_CHANGE' && (
                <p>
                  The member&apos;s role will be updated to <strong>{roleLabel(confirmModal.targetRole!)}</strong>.
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmModal(null)}
                disabled={submitting}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button
                variant={confirmModal.type === 'REMOVE' ? 'destructive' : 'default'}
                size="sm"
                onClick={() => void handleExecuteModalAction()}
                disabled={submitting}
                className="h-8 text-xs font-medium"
              >
                {submitting ? 'Updating…' : 'Confirm action'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Invite Member Modal */}
      {inviteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="invite-modal-title" className="text-base font-bold text-foreground">
                  Invite team member
                </h3>
                <p className="text-xs text-muted-foreground">
                  Send an invitation link to grant HawkView workspace access.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setInviteModalOpen(false)
                  setInviteEmailError(null)
                }}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={invite} className="space-y-4">
              {/* Name (optional) */}
              <div className="space-y-1">
                <Label htmlFor="invite-modal-name" className="text-xs font-medium">
                  Name <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="invite-modal-name"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Alex Smith"
                  className="h-8 text-xs"
                  disabled={submitting}
                />
              </div>

              {/* Email Address */}
              <div className="space-y-1">
                <Label htmlFor="invite-modal-email" className="text-xs font-medium">
                  Email address <span className="text-rose-500">*</span>
                </Label>
                <Input
                  id="invite-modal-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => {
                    setInviteEmail(e.target.value)
                    if (inviteEmailError) setInviteEmailError(null)
                  }}
                  placeholder="alex@example.com"
                  className={`h-8 text-xs ${inviteEmailError ? 'border-rose-500 focus-visible:ring-rose-500' : ''}`}
                  disabled={submitting}
                />
                {inviteEmailError && (
                  <p className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
                    {inviteEmailError}
                  </p>
                )}
              </div>

              {/* Workspace Role Selection */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">Workspace role</Label>
                <div className="space-y-1.5">
                  {roles.map((r) => {
                    const isSelected = inviteRole === r.value
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setInviteRole(r.value)}
                        disabled={submitting}
                        className={`w-full flex items-start justify-between p-2.5 rounded-lg border text-left text-xs transition-colors ${
                          isSelected
                            ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                            : 'border-border hover:bg-accent/60'
                        }`}
                      >
                        <div className="pr-2">
                          <p className="font-semibold text-foreground">{r.label}</p>
                          <p className="text-[11px] text-muted-foreground">{r.description}</p>
                        </div>
                        {isSelected && (
                          <span className="text-blue-600 dark:text-blue-400 font-semibold text-[11px] shrink-0 pt-0.5">
                            Selected
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Modal Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInviteModalOpen(false)
                    setInviteEmailError(null)
                  }}
                  disabled={submitting}
                  className="h-8 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={submitting || !inviteEmail.trim()}
                  className="h-8 text-xs font-medium gap-1.5"
                >
                  {submitting ? (
                    <>
                      <RefreshCcw className="h-3.5 w-3.5 animate-spin" />
                      <span>Sending…</span>
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-3.5 w-3.5" />
                      <span>Send invitation</span>
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Member Administrative History Modal */}
      {memberAuditMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-audit-title"
            className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="member-audit-title" className="text-base font-bold text-foreground">
                  Administrative History
                </h3>
                <p className="text-xs text-muted-foreground">{memberAuditMember.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setMemberAuditMember(null)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto">
              {auditEntries.filter(
                (a) => a.targetEmail === memberAuditMember.email || a.actorEmail === memberAuditMember.email
              ).length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No administrative events recorded for this member.
                </p>
              ) : (
                auditEntries
                  .filter(
                    (a) => a.targetEmail === memberAuditMember.email || a.actorEmail === memberAuditMember.email
                  )
                  .map((entry) => (
                    <div
                      key={entry.id}
                      className="p-2.5 rounded-lg border border-border bg-muted/30 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">
                          {formatActionLabel(entry.action)}
                        </span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium ${
                            entry.outcome === 'SUCCEEDED'
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {entry.outcome}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>By: {entry.actorEmail || 'System'}</span>
                        <span>{formatDateTime(entry.createdAt)}</span>
                      </div>
                    </div>
                  ))
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMemberAuditMember(null)}
                className="h-8 text-xs"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
