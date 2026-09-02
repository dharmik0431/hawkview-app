'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { type AdminTab, adminTabs } from '@/lib/admin-tabs'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  Building,
  Building2,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
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
import { workspaceAdminErrorMessage } from '@/lib/auth/workspace-admin-errors'
import { useAuth } from '@/components/providers/auth-provider'
import { OrganizationProfileEditor } from '@/components/admin/organization-profile-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { getTenantDisplayStatus } from '@/components/tenants/tenant-status-badge'
import type { Tenant, TenantsResponse } from '@/types/api'
import {
  organizationProfileFromWorkspace,
  workspaceOnboardingState,
} from '@/lib/auth/workspace-onboarding'
import {
  WorkspaceOrganizationLoadGuard,
  workspaceOrganizationContext,
} from '@/lib/auth/workspace-organization-context'
import {
  PassiveWorkspaceRefreshLimiter,
  WorkspaceChangeSignalGuard,
  subscribeWorkspaceChanges,
} from '@/lib/auth/workspace-onboarding-sync'
import {
  workspaceAuditActorLabel,
  workspaceAuditMetadataRows,
  workspaceAuditSafeIdentifier,
  workspaceAuditTargetLabel,
} from '@/lib/workspace/audit-evidence'

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
  targetType?: string | null
  targetOpaqueId?: string | null
  action: string
  outcome: string
  stage?: string | null
  errorCode?: string | null
  requestId?: string | null
  operationId?: string | null
  eventVersion?: number
  metadata: Record<string, unknown> | null
  createdAt: string
}

type WorkspaceResponse = {
  organization: {
    id: string
    name: string
    businessDomain?: string | null
    businessDomainVerification?: string
    timeZone?: string | null
    onboardingCompletedAt?: string | null
  }
  canManage?: boolean
  canEditOrganization?: boolean
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

type SortField = 'member' | 'role' | 'status' | 'createdAt'
type SortDirection = 'asc' | 'desc'

type BulkActionType =
  | 'ROLE_CHANGE'
  | 'SUSPEND'
  | 'REACTIVATE'
  | 'RESEND_INVITE'
  | 'PASSWORD_RESET'
  | 'MFA_RESET'
  | 'REMOVE'

type BulkConfirmModalState = {
  action: BulkActionType
  targetRole?: MembershipRole
} | null

type ConfirmModal = {
  type:
    | 'PASSWORD_RESET' | 'MFA_RESET' | 'REMOVE' | 'SUSPEND' | 'REACTIVATE' | 'ROLE_CHANGE'
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
  return workspaceAdminErrorMessage(error, fallback)
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
  if (!action) return 'Unknown action'
  const normalized = action.toUpperCase().replace(/^WORKSPACE_/, '').replace(/^HAWKVIEW_/, '')
  const friendlyMap: Record<string, string> = {
    MEMBER_INVITED: 'Member invited',
    MEMBER_INVITE_REQUESTED: 'Member invitation requested',
    MEMBER_INVITE_PROVIDER_ACCEPTED: 'Invitation accepted by email provider',
    MEMBER_INVITE_FAILED: 'Member invitation failed',
    MEMBER_INVITE_RESEND_REQUESTED: 'Invitation resend requested',
    MEMBER_INVITE_RESEND_PROVIDER_ACCEPTED: 'Resent invitation accepted by email provider',
    MEMBER_INVITATION_RESENT: 'Invitation resent',
    MEMBER_INVITE_RESEND_FAILED: 'Invitation resend failed',
    INVITE_MEMBER: 'Member invited',
    ROLE_CHANGED: 'Role changed',
    MEMBER_ROLE_CHANGED: 'Role changed',
    MEMBER_ROLE_UPDATED: 'Role changed',
    MEMBER_UPDATE_FAILED: 'Member update failed',
    MEMBER_SUSPENDED: 'Member suspended',
    SUSPEND_MEMBER: 'Member suspended',
    MEMBER_RESTORED: 'Member restored',
    MEMBER_REACTIVATED: 'Member restored',
    REACTIVATE_MEMBER: 'Member restored',
    PASSWORD_RESET_SENT: 'Password reset sent',
    PASSWORD_RESET_REQUESTED: 'Password reset requested',
    PASSWORD_RESET_FAILED: 'Password reset failed',
    PASSWORD_RESET: 'Password reset sent',
    MFA_RESET: 'MFA reset',
    MFA_RESET_REQUESTED: 'MFA reset requested',
    MFA_RESET_FAILED: 'MFA reset failed',
    RESET_MFA: 'MFA reset',
    MEMBER_REMOVED: 'Workspace access removed',
    MEMBER_REMOVE_FAILED: 'Workspace access removal failed',
    REMOVE_MEMBER: 'Workspace access removed',
  }

  if (friendlyMap[normalized]) return friendlyMap[normalized]
  if (friendlyMap[action]) return friendlyMap[action]

  return normalized
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function auditOutcomeStyle(outcome: string) {
  if (outcome === 'SUCCEEDED') {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-300/40 dark:border-emerald-800/40'
  }
  if (outcome === 'STARTED') {
    return 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-300/40 dark:border-blue-800/40'
  }
  return 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-300/40 dark:border-rose-800/40'
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
  isSelf,
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
  isSelf: boolean
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

          {/* Password reset is distinct from accepting a pending invitation. */}
          {member.hasHawkViewAccount && (
            <DropdownMenu.Item
              onSelect={() => onPasswordReset(member)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
            >
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Send HawkView password reset</span>
            </DropdownMenu.Item>
          )}

          {/* Reset HawkView MFA */}
          <DropdownMenu.Item
            disabled={isSelf}
            onSelect={() => onMfaReset(member)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
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

export function AdminPanelPage({ initialTab = 'overview', }: { initialTab?: AdminTab }) {
  const { identityUser, session, isLoading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab)

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  const navigateToTab = useCallback(
    (tab: AdminTab) => {
      const organizationId = searchParams.get('organizationId')
      router.push(
        organizationId
          ? `/admin/${tab}?organizationId=${encodeURIComponent(organizationId)}`
          : `/admin/${tab}`
      )
    },
    [router, searchParams]
  )

  const [workspaceResponse, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const adminLoadGuard = useRef(new WorkspaceOrganizationLoadGuard())
  const adminWorkspaceSignalGuard = useRef(new WorkspaceChangeSignalGuard())
  const adminPassiveRefreshLimiter = useRef(
    new PassiveWorkspaceRefreshLimiter()
  )
  const [auditEntriesResponse, setAuditEntries] = useState<AuditEntry[]>([])
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

  // Selection & Bulk Action state
  const [selectedMembershipIds, setSelectedMembershipIds] = useState<Set<string>
  >(new Set())
  const [bulkConfirmModal, setBulkConfirmModal] = useState<BulkConfirmModalState>(null)

  // Tenants state for Overview summary
  const [tenantsResponse, setTenantsData] = useState<Tenant[] | null>(null)
  const [tenantsLoading, setTenantsLoading] = useState<boolean>(true)

  useEffect(() => {
    setSelectedMembershipIds(new Set())
  }, [activeTab])

  // Workspace tab state
  const [copySuccess, setCopySuccess] = useState(false)

  // Notifications tab form state
  const [formNotificationPrefs, setFormNotificationPrefs] = useState<NotificationPref | null>(null)

  useEffect(() => {
    if (notificationPrefs) {
      setFormNotificationPrefs(notificationPrefs)
    }
  }, [notificationPrefs])

  const isPrefDirty = useMemo(() => {
    if (!notificationPrefs || !formNotificationPrefs) return false
    return ( JSON.stringify(notificationPrefs) !== JSON.stringify(formNotificationPrefs))
  }, [notificationPrefs, formNotificationPrefs])

  // Audit Log Tab state
  const [auditSortField, setAuditSortField] = useState<'createdAt' | 'action' | 'target' | 'actor' | 'outcome'>('createdAt')
  const [auditSortDir, setAuditSortDir] = useState<'asc' | 'desc'>('desc')
  const [auditDateRange, setAuditDateRange] = useState<'ALL' | '24H' | '7D' | '30D' | 'CUSTOM'>('ALL')
  const [auditCustomStartDate, setAuditCustomStartDate] = useState<string>('')
  const [auditCustomEndDate, setAuditCustomEndDate] = useState<string>('')

  // Escape key listener for closing drawers/modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (auditDrawerEntry) setAuditDrawerEntry(null)
        if (accountDrawerMember) setAccountDrawerMember(null)
        if (roleChangeMember) setRoleChangeMember(null)
        if (confirmModal) setConfirmModal(null)
        if (inviteModalOpen) setInviteModalOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [auditDrawerEntry, accountDrawerMember, roleChangeMember, confirmModal, inviteModalOpen,])

  const menuContainerRef = useRef<HTMLDivElement | null>(null)

  const organizationContext = workspaceOrganizationContext(
    session,
    searchParams.get('organizationId')
  )
  const isMspOwner = organizationContext.organizations.length > 0
  const selectedOrganizationId =
    organizationContext.state === 'selected'
      ? organizationContext.selected.id
      : null

  useEffect(() => {
    adminLoadGuard.current.invalidate()
    setActiveMenuId(null)
    setConfirmModal(null)
    setRoleChangeMember(null)
    setAccountDrawerMember(null)
    setMemberAuditMember(null)
    setAuditDrawerEntry(null)
    setSelectedMembershipIds(new Set())
    setBulkConfirmModal(null)
    setInviteModalOpen(false)
  }, [selectedOrganizationId])

  const workspace =
    workspaceResponse?.organization.id === selectedOrganizationId
      ? workspaceResponse
      : null
  const auditEntries = useMemo(
    () =>
      selectedOrganizationId
        ? auditEntriesResponse.filter(
            (entry) => entry.organizationId === selectedOrganizationId
          )
        : [],
    [auditEntriesResponse, selectedOrganizationId]
  )
  const auditMembers = useMemo(() => workspace?.members ?? [], [workspace])
  const tenantsData = useMemo(
    () =>
      selectedOrganizationId
        ? ( tenantsResponse?.filter(
            (tenant) => tenant.organization.id === selectedOrganizationId
          ) ?? null)
        : null,
    [selectedOrganizationId, tenantsResponse]
  )

  const currentUserId = session?.user?.id

  // Primary workspace organization info from session or loaded workspace
  const activeMembership = selectedOrganizationId
    ? session?.user?.memberships?.find(
        (membership) =>
          membership.role === 'MSP_OWNER' &&
          membership.status === 'ACTIVE' &&
          membership.organization.status === 'ACTIVE' &&
          membership.organization.id.toLowerCase() === selectedOrganizationId
      )
    : undefined
  const onboardingState = workspaceOnboardingState(session)
  const bootstrapOrganizationProfile =
    onboardingState.state === 'ready' &&
    onboardingState.onboarding.organizationId === selectedOrganizationId
      ? onboardingState.onboarding
      : null
  const selectedOrganizationProfile = organizationProfileFromWorkspace(
    workspace?.organization
  )
  const organizationProfile =
    selectedOrganizationProfile ?? bootstrapOrganizationProfile
  const orgName =
    organizationProfile?.organizationName ||
    workspace?.organization.name ||
    activeMembership?.organization.name ||
    'HawkView Workspace'
  const orgId = workspace?.organization.id || activeMembership?.organization.id || 'N/A'
  const orgStatus = activeMembership?.organization.status || 'ACTIVE'
  const businessDomain =
    organizationProfile?.businessDomain ||
    activeMembership?.organization.businessDomain ||
    'Not configured'
  const organizationTimeZone =
    organizationProfile?.timeZone ||
    activeMembership?.organization.timeZone ||
    'Not configured'

  const loadAllData = useCallback(async (keepCurrent = false) => {
    if (!selectedOrganizationId) {
      setWorkspace(null)
      setAuditEntries([])
      setTenantsData(null)
      setLoading(false)
      setTenantsLoading(false)
      return
    }
    const ticket = adminLoadGuard.current.begin(selectedOrganizationId)
    if (!keepCurrent) {
      setLoading(true)
      setTenantsLoading(true)
    }
    setError(null)
    try {
      const [membersData, auditData, prefsData, tenantsRes] = await Promise.all([
        apiClient.get<WorkspaceResponse>('/api/workspace/members', {
          params: { organizationId: selectedOrganizationId },
        }),
        apiClient.get<AuditResponse>('/api/workspace/audit-logs', {
          params: { organizationId: selectedOrganizationId },
        }),
        apiClient.get<NotificationPref>('/api/notifications/preferences').catch(() => null),
        apiClient.get<TenantsResponse>('/api/tenants').catch(() => null),
      ])
      if (!adminLoadGuard.current.isCurrent(ticket, selectedOrganizationId)) return
      setWorkspace(membersData)
      setAuditEntries(Array.isArray(auditData?.items) ? auditData.items : [])
      if (prefsData) setNotificationPrefs(prefsData)
      if (tenantsRes && Array.isArray(tenantsRes.tenants)) {
        setTenantsData(tenantsRes.tenants)
      } else {
        setTenantsData(null)
      }
    } catch (requestError) {
      if (!adminLoadGuard.current.isCurrent(ticket, selectedOrganizationId)) return
      setError(errorMessage(requestError, 'Admin Panel information could not be loaded.'))
    } finally {
      if (adminLoadGuard.current.isCurrent(ticket, selectedOrganizationId)) {
        setLoading(false)
        setTenantsLoading(false)
      }
    }
  }, [selectedOrganizationId])

  useEffect(() => {
    if (isMspOwner && selectedOrganizationId) {
      void loadAllData()
    } else {
      setLoading(false)
      setTenantsLoading(false)
    }
  }, [isMspOwner, loadAllData, selectedOrganizationId])

  useEffect(() => {
    if (!selectedOrganizationId) return
    const refreshSelectedOrganization = () => {
      void loadAllData(true)
    }
    const unsubscribe = subscribeWorkspaceChanges((value) => {
      const accepted = adminWorkspaceSignalGuard.current.accept(
        value,
        identityUser?.id,
        session
      )
      if (accepted?.organizationId === selectedOrganizationId) {
        refreshSelectedOrganization()
      }
    })
    const passiveRefresh = () => {
      if (
        document.visibilityState === 'visible' &&
        adminPassiveRefreshLimiter.current.allow()
      ) {
        refreshSelectedOrganization()
      }
    }
    window.addEventListener('focus', passiveRefresh)
    document.addEventListener('visibilitychange', passiveRefresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', passiveRefresh)
      document.removeEventListener('visibilitychange', passiveRefresh)
    }
  }, [identityUser?.id, loadAllData, selectedOrganizationId, session])

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
    return ( workspace?.members.filter((m) => m.status === 'SUSPENDED').length ?? 0
    )
  }, [workspace?.members])

  const pendingSetupCount = useMemo(() => {
    return ( workspace?.members.filter((m) => m.hasHawkViewAccount === false).length ?? 0
    )
  }, [workspace?.members])

  const configuredAuthCount = useMemo(() => {
    return ( workspace?.members.filter((m) => m.hasHawkViewAccount === true).length ?? 0
    )
  }, [workspace?.members])

  const activeMembers = useMemo(() => {
    return workspace?.members.filter((m) => m.status === 'ACTIVE') ?? []
  }, [workspace?.members])

  const allActiveConfigured = useMemo(() => {
    return ( activeMembers.length > 0 && activeMembers.every((m) => m.hasHawkViewAccount === true))
  }, [activeMembers])

  const securityAttentionCount = useMemo(() => {
    return (
      workspace?.members.filter(
        (m) => m.status === 'SUSPENDED' || m.hasHawkViewAccount === false
      ).length ?? 0
    )
  }, [workspace?.members])

  const tenantMetrics = useMemo(() => {
    if (!tenantsData) return null
    let healthy = 0
    let needsAttention = 0

    tenantsData.forEach((t) => {
      const displayStatus = getTenantDisplayStatus(t)
      if (displayStatus.key === 'healthy') {
        healthy++
      } else if (
        displayStatus.key === 'needs_attention' ||
        displayStatus.key === 'disconnected' ||
        (t.attention && t.attention.length > 0)
      ) {
        needsAttention++
      }
    })

    return {
      total: tenantsData.length,
      healthy,
      needsAttention,
    }
  }, [tenantsData])

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
  }, [workspace?.members, searchQuery, roleFilter, statusFilter, authStatusFilter,])

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

  // Row selection helpers
  const toggleSelectMember = useCallback((membershipId: string) => {
    setSelectedMembershipIds((prev) => {
      const next = new Set(prev)
      if (next.has(membershipId)) {
        next.delete(membershipId)
      } else {
        next.add(membershipId)
      }
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    const visibleIds = sortedMembers.map((m) => m.membershipId)
    const allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedMembershipIds.has(id))
    setSelectedMembershipIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id))
      } else {
        visibleIds.forEach((id) => next.add(id))
      }
      return next
    })
  }, [sortedMembers, selectedMembershipIds])

  const clearSelection = useCallback(() => {
    setSelectedMembershipIds(new Set())
  }, [])

  const selectedMembers = useMemo(() => {
    if (!workspace?.members) return []
    return workspace.members.filter((m) => selectedMembershipIds.has(m.membershipId))
  }, [workspace?.members, selectedMembershipIds])

  const visibleSelectedCount = useMemo(() => {
    return sortedMembers.filter((m) => selectedMembershipIds.has(m.membershipId)).length
  }, [sortedMembers, selectedMembershipIds])

  const selectAllState: boolean | 'indeterminate' = useMemo(() => {
    if (sortedMembers.length === 0) return false
    if (visibleSelectedCount === sortedMembers.length) return true
    if (visibleSelectedCount > 0) return 'indeterminate'
    return false
  }, [sortedMembers.length, visibleSelectedCount])

  // CSV Export
  const handleExportCsv = useCallback(() => {
    if (sortedMembers.length === 0) return
    try {
      const headers = [
        'Display name',
        'Email address',
        'Workspace role',
        'Account status',
        'Account record status',
        'Added date',
        'Last activity',
        'Current user',
      ]

      const sanitizeCsv = (val: string | null | undefined): string => {
        if (val == null) return '""'
        let str = String(val).trim()
        if (/^[=+\-@]/.test(str)) {
          str = "'" + str
        }
        str = str.replace(/"/g, '""')
        return `"${str}"`
      }

      const rows = sortedMembers.map((member) => {
        const isSelf = member.userId === currentUserId
        return [
          sanitizeCsv(member.displayName || ''),
          sanitizeCsv(member.email),
          sanitizeCsv(roleLabel(member.role)),
          sanitizeCsv(member.status === 'ACTIVE' ? 'Active' : 'Suspended'),
          sanitizeCsv(
            member.hasHawkViewAccount
              ? 'HawkView account record present'
              : 'HawkView account record not reported'
          ),
          sanitizeCsv(formatDate(member.joinedAt || member.createdAt)),
          sanitizeCsv('Not available'),
          sanitizeCsv(isSelf ? 'Yes' : 'No'),
        ].join(',')
      })

      const csvContent =
        '\uFEFF' + [headers.map(sanitizeCsv).join(','), ...rows].join('\r\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const today = new Date().toISOString().slice(0, 10)
      link.setAttribute('href', url)
      link.setAttribute('download', `hawkview-team-members-${today}.csv`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      setNotice('Team members exported.')
    } catch (err) {
      setError('Team member export could not be created.')
    }
  }, [sortedMembers, currentUserId])

  // Bulk action execution
  const handleExecuteBulkAction = useCallback(async () => {
    if (
      !bulkConfirmModal ||
      selectedMembers.length === 0 ||
      !selectedOrganizationId
    )
      return
    const { action, targetRole } = bulkConfirmModal

    const eligibleMembers = selectedMembers.filter((m) => {
      const isSelf = m.userId === currentUserId
      const isFinal = isFinalActiveOwner(m)

      if (action === 'ROLE_CHANGE' && targetRole !== 'MSP_OWNER') {
        if (isSelf || isFinal) return false
      }
      if (action === 'SUSPEND' || action === 'REMOVE') {
        if (isSelf || isFinal) return false
      }
      if (action === 'MFA_RESET' && isSelf) return false
      if (action === 'RESEND_INVITE' && m.hasHawkViewAccount !== false) return false
      if (action === 'PASSWORD_RESET' && m.hasHawkViewAccount !== true) return false
      return true
    })

    if (eligibleMembers.length === 0) {
      setError(
        'None of the selected members are eligible for this operation due to owner protections.'
      )
      setBulkConfirmModal(null)
      return
    }

    setSubmitting(true)
    setError(null)
    setNotice(null)

    const succeededIds: string[] = []
    const failedItems: { email: string; reason: string }[] = []

    for (const member of eligibleMembers) {
      try {
        if (action === 'ROLE_CHANGE' && targetRole) {
          await apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { organizationId: selectedOrganizationId, role: targetRole }
          )
        } else if (action === 'SUSPEND') {
          await apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { organizationId: selectedOrganizationId, status: 'SUSPENDED' }
          )
        } else if (action === 'REACTIVATE') {
          await apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { organizationId: selectedOrganizationId, status: 'ACTIVE' }
          )
        } else if (action === 'RESEND_INVITE') {
          await apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/resend-invite`,
            { organizationId: selectedOrganizationId }
          )
        } else if (action === 'PASSWORD_RESET') {
          await apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/password-reset`,
            { organizationId: selectedOrganizationId }
          )
        } else if (action === 'MFA_RESET') {
          await apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/mfa-reset`,
            { organizationId: selectedOrganizationId }
          )
        } else if (action === 'REMOVE') {
          await apiClient.delete(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            undefined,
            { params: { organizationId: selectedOrganizationId } }
          )
        }
        succeededIds.push(member.membershipId)
      } catch (err) {
        failedItems.push({
          email: member.email,
          reason: errorMessage(err, 'Action failed.'),
        })
      }
    }

    setSelectedMembershipIds((prev) => {
      const next = new Set(prev)
      succeededIds.forEach((id) => next.delete(id))
      return next
    })

    await loadAllData(true)
    setSubmitting(false)
    setBulkConfirmModal(null)

    if (failedItems.length === 0) {
      setNotice(`${succeededIds.length} member(s) were successfully updated.`)
    } else if (succeededIds.length > 0) {
      setNotice(
        `${succeededIds.length} member(s) updated successfully. ${failedItems.length} member(s) failed: ${failedItems[0].reason}`
      )
    } else {
      setError(`Bulk action failed: ${failedItems[0].reason}`)
    }
  }, [
    bulkConfirmModal,
    selectedMembers,
    currentUserId,
    isFinalActiveOwner,
    loadAllData,
    selectedOrganizationId,
  ])

  // Copy Org ID handler
  const handleCopyOrgId = async () => {
    if (!orgId || orgId === 'N/A') return
    try {
      await navigator.clipboard.writeText(orgId)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch {
      // ignore
    }
  }

  // Filter and sort audit logs
  const filteredAndSortedAuditLogs = useMemo(() => {
    const logs = auditEntries.filter((entry) => {
      const q = auditSearch.trim().toLowerCase()
      const actorLabel = workspaceAuditActorLabel(entry, auditMembers)
      const targetLabel = workspaceAuditTargetLabel(entry, auditMembers)
      const matchesSearch =
        !q ||
        entry.action.toLowerCase().includes(q) ||
        actorLabel.toLowerCase().includes(q) ||
        targetLabel.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q) ||
        entry.requestId?.toLowerCase().includes(q) ||
        entry.operationId?.toLowerCase().includes(q)

      const matchesAction =
        auditActionFilter === 'ALL' || entry.action === auditActionFilter
      const matchesOutcome =
        auditOutcomeFilter === 'ALL' || entry.outcome === auditOutcomeFilter

      let matchesDate = true
      const entryDate = new Date(entry.createdAt).getTime()
      const now = Date.now()

      if (auditDateRange === '24H') {
        matchesDate = entryDate >= now - 24 * 60 * 60 * 1000
      } else if (auditDateRange === '7D') {
        matchesDate = entryDate >= now - 7 * 24 * 60 * 60 * 1000
      } else if (auditDateRange === '30D') {
        matchesDate = entryDate >= now - 30 * 24 * 60 * 60 * 1000
      } else if (auditDateRange === 'CUSTOM') {
        if (auditCustomStartDate) {
          const start = new Date(auditCustomStartDate).getTime()
          if (!isNaN(start)) matchesDate = matchesDate && entryDate >= start
        }
        if (auditCustomEndDate) {
          const end =
            new Date(auditCustomEndDate).getTime() + 24 * 60 * 60 * 1000 - 1
          if (!isNaN(end)) matchesDate = matchesDate && entryDate <= end
        }
      }

      return matchesSearch && matchesAction && matchesOutcome && matchesDate
    })

    logs.sort((a, b) => {
      let aVal: string | number = ''
      let bVal: string | number = ''

      if (auditSortField === 'createdAt') {
        aVal = new Date(a.createdAt).getTime()
        bVal = new Date(b.createdAt).getTime()
      } else if (auditSortField === 'action') {
        aVal = a.action.toLowerCase()
        bVal = b.action.toLowerCase()
      } else if (auditSortField === 'target') {
        aVal = workspaceAuditTargetLabel(a, auditMembers).toLowerCase()
        bVal = workspaceAuditTargetLabel(b, auditMembers).toLowerCase()
      } else if (auditSortField === 'actor') {
        aVal = workspaceAuditActorLabel(a, auditMembers).toLowerCase()
        bVal = workspaceAuditActorLabel(b, auditMembers).toLowerCase()
      } else if (auditSortField === 'outcome') {
        aVal = a.outcome.toLowerCase()
        bVal = b.outcome.toLowerCase()
      }

      if (aVal < bVal) return auditSortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return auditSortDir === 'asc' ? 1 : -1
      return 0
    })

    return logs
  }, [
    auditEntries,
    auditSearch,
    auditActionFilter,
    auditOutcomeFilter,
    auditDateRange,
    auditCustomStartDate,
    auditCustomEndDate,
    auditSortField,
    auditSortDir,
    auditMembers,
  ])

  // CSV Export handler
  const handleExportCSV = () => {
    if (filteredAndSortedAuditLogs.length === 0) return

    const sanitizeCSV = (str: string | null | undefined): string => {
      if (!str) return '""'
      let val = String(str).replace(/"/g, '""')
      if (/^[=+\-@\t\r]/.test(val)) {
        val = `'${val}`
      }
      return `"${val}"`
    }

    const headers = ['Event ID', 'Date & Time', 'Action', 'Affected Target', 'Performed By', 'Outcome',
      'Stage',
      'Error Code',
      'Request ID',
      'Operation ID',]
    const rows = filteredAndSortedAuditLogs.map((entry) => {
      return [
        sanitizeCSV(entry.id),
        sanitizeCSV(formatDateTime(entry.createdAt)),
        sanitizeCSV(entry.action),
        sanitizeCSV(workspaceAuditTargetLabel(entry, auditMembers)),
        sanitizeCSV(workspaceAuditActorLabel(entry, auditMembers)),
        sanitizeCSV(entry.outcome),
        sanitizeCSV(entry.stage || 'Not reported'),
        sanitizeCSV(entry.errorCode || 'Not reported'),
        sanitizeCSV(workspaceAuditSafeIdentifier(entry.requestId)),
        sanitizeCSV(workspaceAuditSafeIdentifier(entry.operationId)),
      ].join(',')
    })

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const dateStr = new Date().toISOString().split('T')[0]
    link.setAttribute('download', `hawkview_audit_history_${dateStr}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // Action runners
  const runAction = async (action: () => Promise<unknown>, successNotice: string) => {
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(successNotice)
      await loadAllData(true)
      return true
    } catch (requestError) {
      setError(errorMessage(requestError, 'That administrative action could not be completed.'))
      return false
    } finally {
      setSubmitting(false)
      setActiveMenuId(null)
      setConfirmModal(null)
      setRoleChangeMember(null)
    }
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedOrganizationId) {
      setInviteEmailError('Select an MSP workspace before inviting a member.')
      return
    }
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

    const invitationSent = await runAction(
      () =>
        apiClient.post('/api/workspace/members/invite', {
          organizationId: selectedOrganizationId,
          email: trimmedEmail,
          displayName: inviteName.trim() || undefined,
          role: inviteRole,
        }),
      `Invitation sent to ${trimmedEmail}. The member will receive a secure HawkView setup link.`
    )
    if (!invitationSent) return
    setInviteModalOpen(false)
    setInviteEmail('')
    setInviteName('')
    setInviteRole('MSP_TECHNICIAN')
    setInviteEmailError(null)
  }

  const handleResendInvitation = async (member: Member) => {
    if (!selectedOrganizationId) return
    await runAction(
      () =>
        apiClient.post(
          `/api/workspace/members/${encodeURIComponent(member.membershipId)}/resend-invite`,
          { organizationId: selectedOrganizationId }
        ),
      `Invitation resent to ${member.email}. The member will receive a fresh HawkView invitation link.`
    )
  }

  const handleExecuteModalAction = async () => {
    if (!confirmModal || !selectedOrganizationId) return
    const { type, member, targetRole } = confirmModal

    if (type === 'ROLE_CHANGE' && targetRole) {
      await runAction(
        () =>
          apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { organizationId: selectedOrganizationId, role: targetRole }
          ),
        `Role updated to ${roleLabel(targetRole)} for ${member.email}.`
      )
    } else if (type === 'SUSPEND' || type === 'REACTIVATE') {
      const nextStatus = type === 'SUSPEND' ? 'SUSPENDED' : 'ACTIVE'
      await runAction(
        () =>
          apiClient.patch(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            { organizationId: selectedOrganizationId, status: nextStatus }
          ),
        `${member.email} is now ${nextStatus === 'ACTIVE' ? 'active' : 'suspended'}.`
      )
    } else if (type === 'PASSWORD_RESET') {
      await runAction(
        () =>
          apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/password-reset`,
            { organizationId: selectedOrganizationId }
          ),
        `A HawkView account password-reset email was sent to ${member.email}.`
      )
    } else if (type === 'MFA_RESET') {
      await runAction(
        () =>
          apiClient.post(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}/mfa-reset`,
            { organizationId: selectedOrganizationId }
          ),
        `HawkView MFA was reset for ${member.email}.`
      )
    } else if (type === 'REMOVE') {
      await runAction(
        () =>
          apiClient.delete(
            `/api/workspace/members/${encodeURIComponent(member.membershipId)}`,
            undefined,
            { params: { organizationId: selectedOrganizationId } }
          ),
        `${member.email} was removed from this HawkView workspace.`
      )
    }
  }

  const handleSaveNotificationPrefs = async () => {
    if (!formNotificationPrefs) return
    setPrefSaving(true)
    setError(null)
    setNotice(null)
    try {
      const updated = await apiClient.patch<NotificationPref>('/api/notifications/preferences', formNotificationPrefs)
      setNotificationPrefs(updated)
      setFormNotificationPrefs(updated)
      setNotice('Notification preferences saved successfully.')
    } catch (requestError) {
      setError(errorMessage(requestError, 'Failed to save notification preferences.'))
    } finally {
      setPrefSaving(false)
    }
  }

  const handleCancelNotificationPrefs = () => {
    if (notificationPrefs) {
      setFormNotificationPrefs(notificationPrefs)
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

  if (organizationContext.state === 'selection-required') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2.5">
            <Building className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <h1 className="text-lg font-semibold text-foreground">Choose a workspace</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Select the MSP organization you want to administer. HawkView keeps team, audit, and profile operations scoped to this choice.
          </p>
          <Label htmlFor="admin-workspace-selector">MSP workspace</Label>
          <select
            id="admin-workspace-selector"
            defaultValue=""
            onChange={(event) => {
              if (!event.target.value) return
              router.replace(
                `/admin/${activeTab}?organizationId=${encodeURIComponent(event.target.value)}`
              )
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="" disabled>Select a workspace…</option>
            {organizationContext.organizations.map((organization) => (
              <option value={organization.id} key={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
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
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Admin Panel
            </h1>
            <span className="text-muted-foreground font-normal text-sm">·</span>
            <div className="flex items-center gap-1.5 bg-muted/60 px-2.5 py-0.5 rounded-md text-xs font-medium text-foreground border border-border/50">
              <Building className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="font-semibold">{orgName}</span>
            </div>
          </div>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
            Manage your MSP workspace, team access, and HawkView security.
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
            <span>Controls in this area affect HawkView accounts only, not Microsoft 365 identities or credentials.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {organizationContext.organizations.length > 1 && (
            <Label className="sr-only" htmlFor="admin-workspace-switcher">MSP workspace</Label>
          )}
          {organizationContext.organizations.length > 1 && (
            <select
              id="admin-workspace-switcher"
              value={selectedOrganizationId ?? ''}
              onChange={(event) => {
                setWorkspace(null)
                setAuditEntries([])
                setTenantsData(null)
                clearSelection()
                router.replace(
                  `/admin/${activeTab}?organizationId=${encodeURIComponent(event.target.value)}`
                )
              }}
              className="h-8 max-w-56 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {organizationContext.organizations.map((organization) => (
                <option value={organization.id} key={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadAllData(true)}
            disabled={loading || submitting}
            className="h-8 text-xs gap-1.5 shrink-0"
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </Button>
        </div>
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
                onClick={() => navigateToTab(tab.id)}
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
          {/* Operational Summary Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: Managed Tenants */}
            <Link
              href="/tenants"
              className="group p-4 rounded-xl border border-border bg-card hover:border-blue-500/50 hover:shadow-md transition-all text-left flex flex-col justify-between space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Managed tenants
                </span>
                <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-105 transition-transform">
                  <Building className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>

              <div>
                <div className="text-2xl font-bold tracking-tight text-foreground flex items-baseline gap-2">
                  {tenantsLoading ? (
                    <span className="text-muted-foreground text-lg">Loading…</span>
                  ) : tenantMetrics ? (
                    <span>{tenantMetrics.total}</span>
                  ) : (
                    <span className="text-muted-foreground text-base">Unavailable</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                  {tenantMetrics ? (
                    <>
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        {tenantMetrics.healthy} healthy
                      </span>
                      {tenantMetrics.needsAttention > 0 && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          · {tenantMetrics.needsAttention} need attention
                        </span>
                      )}
                    </>
                  ) : (
                    <span>Tenant summary unavailable</span>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-border/60 flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 font-semibold group-hover:underline">
                <span>View all tenants</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </Link>

            {/* Metric 2: Team Members */}
            <button
              type="button"
              onClick={() => navigateToTab('users')}
              className="group p-4 rounded-xl border border-border bg-card hover:border-blue-500/50 hover:shadow-md transition-all text-left flex flex-col justify-between space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Team members
                </span>
                <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-105 transition-transform">
                  <Users className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>

              <div>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {loading ? (
                    <span className="text-muted-foreground text-lg">Loading…</span>
                  ) : workspace ? (
                    <span>{workspace.members.length}</span>
                  ) : (
                    <span className="text-muted-foreground text-base">Unavailable</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    {activeMembersCount} active
                  </span>
                  {suspendedMembersCount > 0 && (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      · {suspendedMembersCount} suspended
                    </span>
                  )}
                  {pendingSetupCount > 0 && (
                    <span className="text-blue-600 dark:text-blue-400 font-medium">
                      · {pendingSetupCount} setup pending
                    </span>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-border/60 flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 font-semibold group-hover:underline">
                <span>Manage team members</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </button>

            {/* Metric 3: Active MSP Owners */}
            <button
              type="button"
              onClick={() => navigateToTab('users')}
              className={`group p-4 rounded-xl border transition-all text-left flex flex-col justify-between space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                activeOwners.length <= 1
                  ? 'border-amber-300 dark:border-amber-800/80 bg-amber-50/40 dark:bg-amber-950/20 hover:border-amber-400'
                  : 'border-border bg-card hover:border-blue-500/50 hover:shadow-md'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Active MSP owners
                </span>
                <div
                  className={`p-2 rounded-lg ${
                    activeOwners.length <= 1
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {activeOwners.length <= 1 ? (
                    <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  )}
                </div>
              </div>

              <div>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {loading ? '…' : activeOwners.length}
                </div>
                {activeOwners.length <= 1 ? (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Single active owner — no redundancy</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Assign another active owner to prevent lockout
                    </p>
                  </div>
                ) : (
                  <div className="mt-1">
                    <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Multi-owner redundancy active</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {activeOwners.length} active MSP owners configured
                    </p>
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-border/60 flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 font-semibold group-hover:underline">
                <span>Review owner access</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </button>

            {/* Metric 4: Account Security */}
            <button
              type="button"
              onClick={() => navigateToTab('security')}
              className="group p-4 rounded-xl border border-border bg-card hover:border-blue-500/50 hover:shadow-md transition-all text-left flex flex-col justify-between space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Account security
                </span>
                <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-105 transition-transform">
                  <Lock className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>

              <div>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {loading ? (
                    <span className="text-muted-foreground text-lg">Loading…</span>
                  ) : workspace ? (
                    <span>{configuredAuthCount} / {workspace.members.length}</span>
                  ) : (
                    <span className="text-muted-foreground text-base">Unavailable</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {allActiveConfigured ? (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>All active members configured</span>
                    </span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{pendingSetupCount} member{pendingSetupCount === 1 ? '' : 's'} awaiting setup</span>
                    </span>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-border/60 flex items-center justify-between text-xs text-blue-600 dark:text-blue-400 font-semibold group-hover:underline">
                <span>Security settings</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </button>
          </div>

          {/* Compact Common Tasks Bar */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Common tasks
            </h2>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInviteEmailError(null)
                  setInviteModalOpen(true)
                }}
                className="h-8 text-xs font-semibold gap-1.5 hover:bg-accent/80"
              >
                <UserPlus className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <span>Invite team member</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => navigateToTab('users')}
                className="h-8 text-xs font-semibold gap-1.5 hover:bg-accent/80"
              >
                <Users className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <span>Manage team members</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => navigateToTab('security')}
                className="h-8 text-xs font-semibold gap-1.5 hover:bg-accent/80"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <span>Review workspace security</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => navigateToTab('audit')}
                className="h-8 text-xs font-semibold gap-1.5 hover:bg-accent/80"
              >
                <History className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <span>View audit history</span>
              </Button>
            </div>
          </div>

          {/* Recent Administrative Activity Preview */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Recent Administrative Activity</h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateToTab('audit')}
                className="h-7 px-2.5 text-xs font-semibold gap-1 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                <span>View all</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>

            {auditEntries.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground space-y-1">
                <History className="h-6 w-6 mx-auto text-muted-foreground/40 mb-1" aria-hidden="true" />
                <p className="font-medium text-foreground">No administrative activity recorded</p>
                <p className="text-[11px] text-muted-foreground">
                  Audit events will appear here as administrative actions occur in your workspace.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-muted/50 border-b border-border">
                    <tr className="font-semibold text-muted-foreground text-[11px] uppercase tracking-wider">
                      <th scope="col" className="py-2 px-3">Action</th>
                      <th scope="col" className="py-2 px-3">Target member</th>
                      <th scope="col" className="py-2 px-3">Actor</th>
                      <th scope="col" className="py-2 px-3">Result</th>
                      <th scope="col" className="py-2 px-3 text-right">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {auditEntries.slice(0, 5).map((entry) => (
                      <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 px-3 font-semibold text-foreground whitespace-nowrap">
                          {formatActionLabel(entry.action)}
                        </td>
                        <td className="py-2.5 px-3 text-foreground/90 max-w-[180px] truncate">
                          {workspaceAuditTargetLabel(entry, auditMembers)}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground max-w-[180px] truncate">
                          {workspaceAuditActorLabel(entry, auditMembers)}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${auditOutcomeStyle(entry.outcome)}`}
                          >
                            {entry.outcome === 'SUCCEEDED' ? 'Succeeded' : entry.outcome}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-muted-foreground whitespace-nowrap">
                          {formatDateTime(entry.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExportCsv}
                    disabled={sortedMembers.length === 0}
                    className="h-8 text-xs font-semibold gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Export CSV</span>
                  </Button>

                  <Button
                    size="sm"
                    onClick={() => {
                      setInviteEmailError(null)
                      setInviteModalOpen(true)
                    }}
                    className="h-8 text-xs font-semibold gap-1.5"
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Invite member</span>
                  </Button>
                </div>
              </div>

              {/* Toolbar Search & Filters */}
              <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5 pt-1">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1">
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
                      <option value="CONFIGURED">Account record present</option>
                      <option value="AWAITING_SETUP">Account record not reported</option>
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

              {/* Contextual Selection Bar */}
              {selectedMembershipIds.size > 0 && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 p-2.5 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/70 dark:bg-blue-950/40 text-xs animate-in fade-in duration-150">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <CheckSquare className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                    <span>{selectedMembershipIds.size} {' '}
                      {selectedMembershipIds.size === 1 ? 'member' : 'members'}{' '} selected</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button
                          size="sm"
                          className="h-7 px-3 text-xs font-semibold gap-1.5"
                          disabled={submitting}
                        >
                          <span>Bulk actions</span>
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenu.Trigger>

                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={4}
                          className="z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg text-left animate-in fade-in zoom-in-95 focus:outline-none"
                        >
                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'ROLE_CHANGE', targetRole: 'MSP_TECHNICIAN', })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
                          >
                            <Users className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Change workspace role</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'PASSWORD_RESET' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
                          >
                            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Send HawkView password reset</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'MFA_RESET' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
                          >
                            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Reset HawkView MFA</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'RESEND_INVITE' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer"
                          >
                            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Resend invitations</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Separator className="h-px bg-border my-1" />

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'SUSPEND' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer text-amber-600 dark:text-amber-500"
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span>Suspend accounts</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'REACTIVATE' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer text-emerald-600 dark:text-emerald-400"
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                            <span>Reactivate accounts</span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Separator className="h-px bg-border my-1" />

                          <DropdownMenu.Item
                            onSelect={() => setBulkConfirmModal({ action: 'REMOVE' })}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 focus:bg-rose-500/10 focus:outline-none cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove from workspace</span>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearSelection}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear selection
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-muted/60 border-b border-border">
                  <tr className="font-semibold text-muted-foreground">
                    <th scope="col" className="py-2.5 px-3 w-10 text-center">
                      <Checkbox
                        checked={selectAllState}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all visible team members"
                      />
                    </th>
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('member')}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Member</span>
                        {sortField === 'member' ? (
                          sortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
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
                          sortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
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
                          sortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
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
                          sortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
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
                      <td colSpan={7} className="py-8 text-center text-muted-foreground">
                        Loading workspace team members…
                      </td>
                    </tr>
                  ) : sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-muted-foreground space-y-2">
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
                      const isSelected = selectedMembershipIds.has(member.membershipId)

                      return (
                        <tr
                          key={member.membershipId}
                          className={`hover:bg-muted/30 transition-colors ${isSelected ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''}`}
                        >
                          {/* Checkbox Column */}
                          <td className="py-3 px-3 w-10 text-center">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelectMember(member.membershipId)}
                              aria-label={`Select ${member.displayName || member.email}`}
                            />
                          </td>

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
                                <span>Account record present</span>
                                <div className="absolute left-0 bottom-full mb-1.5 hidden group-hover:block z-30 w-56 rounded-md bg-popover border border-border p-2 text-[11px] font-normal text-popover-foreground shadow-md pointer-events-none">
                                  HawkView has an account record for this member. This does not verify the authentication provider or recent sign-in activity.
                                </div>
                              </div>
                            ) : (
                              <div className="group relative inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400 cursor-help">
                                <Clock className="h-3.5 w-3.5 shrink-0" />
                                <span>Account record not reported</span>
                                <div className="absolute left-0 bottom-full mb-1.5 hidden group-hover:block z-30 w-56 rounded-md bg-popover border border-border p-2 text-[11px] font-normal text-popover-foreground shadow-md pointer-events-none">
                                  HawkView did not receive an account record for this member. The authentication provider and setup state are not inferred.
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
                              isSelf={isSelf}
                              onAccountDetails={setAccountDrawerMember}
                              onChangeRole={setRoleChangeMember}
                              onResendInvitation={handleResendInvitation}
                              onPasswordReset={(m) => setConfirmModal({ type: 'PASSWORD_RESET', member: m, })}
                              onMfaReset={(m) => setConfirmModal({ type: 'MFA_RESET', member: m, })}
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
                  const isSelected = selectedMembershipIds.has(member.membershipId)

                  return (
                    <div
                      key={member.membershipId}
                      className={`p-3.5 space-y-2.5 bg-card hover:bg-muted/20 transition-colors ${isSelected ? 'bg-blue-50/40 dark:bg-blue-950/20 border-l-2 border-l-blue-600' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleSelectMember(member.membershipId)}
                            aria-label={`Select ${member.displayName || member.email}`}
                          />
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
                            isSelf={isSelf}
                            onAccountDetails={setAccountDrawerMember}
                            onChangeRole={setRoleChangeMember}
                            onResendInvitation={handleResendInvitation}
                            onPasswordReset={(m) => setConfirmModal({ type: 'PASSWORD_RESET', member: m, })}
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
          {/* Section 1: Workspace Identity */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Building className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Workspace Identity</h2>
              </div>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-300/40 dark:border-emerald-800/40">
                {orgStatus}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Workspace Name
                </span>
                <p className="font-semibold text-foreground text-sm truncate">{orgName}</p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Business Domain
                </span>
                <p className="text-xs font-medium text-foreground bg-muted/50 px-2 py-1 rounded border border-border/50 truncate">
                  {businessDomain}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Informational; ownership is not verified
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Workspace ID
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground bg-muted/40 px-2 py-1 rounded border border-border/50 truncate flex-1">
                    {orgId}
                  </span>
                  {orgId && orgId !== 'N/A' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyOrgId}
                      className="h-7 px-2 text-[11px] gap-1 shrink-0"
                      title="Copy Workspace ID"
                    >
                      {copySuccess ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Workspace Status
                </span>
                <div>
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Active Console Workspace</span>
                  </span>
                </div>
              </div>
            </div>

            {organizationProfile && workspace?.canEditOrganization === true && (
              <OrganizationProfileEditor
                onboarding={organizationProfile}
                onSaved={() => loadAllData(true)}
              />
            )}
          </div>

          {/* Section 2: Regional Preferences */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Regional Preferences</h2>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs pt-1">
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Support Contact Email
                </span>
                <p className="font-medium text-muted-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50">
                  Not configured
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Time Zone
                </span>
                <p className="font-medium text-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50">
                  {organizationTimeZone}
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Date Format
                </span>
                <p className="font-medium text-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50">
                  {session?.user.dateFormat || 'YYYY-MM-DD'}
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Time Format
                </span>
                <p className="font-medium text-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50">
                  {session?.user.timeFormat === '24h' ? '24-hour' : '12-hour'}
                </p>
              </div>
            </div>
          </div>

          {/* Section 3: Workspace Lifecycle */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Workspace Lifecycle</h2>
              </div>
            </div>

            <div className="divide-y divide-border text-xs">
              {/* Action 1: Transfer ownership */}
              <div className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">Transfer Workspace Ownership</p>
                  <p className="text-[11px] text-muted-foreground">
                    Assign primary workspace ownership to another active MSP owner.
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Transferring workspace ownership requires backend support.
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled className="h-8 text-xs shrink-0 self-start sm:self-auto">
                  Unavailable
                </Button>
              </div>

              {/* Action 2: Disable workspace */}
              <div className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">Disable Workspace</p>
                  <p className="text-[11px] text-muted-foreground">
                    Suspend console access to this HawkView workspace.
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Disabling workspace console access requires backend support.
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled className="h-8 text-xs shrink-0 self-start sm:self-auto">
                  Unavailable
                </Button>
              </div>

              {/* Action 3: Delete workspace (Destructive) */}
              <div className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="font-semibold text-rose-600 dark:text-rose-400">Delete Workspace</p>
                  <p className="text-[11px] text-muted-foreground">
                    Permanently erase this HawkView workspace and all associated configuration data.
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Deleting a workspace permanently requires backend support.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  className="h-8 text-xs text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-800/80 shrink-0 self-start sm:self-auto opacity-60"
                >
                  Delete workspace
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SECURITY */}
      {activeTab === 'security' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Section 1: Authentication evidence */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Authentication Evidence</h2>
              </div>
            </div>

            <div className="py-3 flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold text-foreground">Workspace authentication configuration</p>
                <p className="text-[11px] text-muted-foreground">
                  Provider availability and enforcement are not included in the current workspace contract.
                </p>
              </div>
              <span className="inline-flex w-fit items-center rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                Not reported
              </span>
            </div>
          </div>

          {/* Section 2: Account Security Summary */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Account Security Summary</h2>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Active Owners</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : workspace ? activeOwners.length : 'Unavailable'}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Active Members</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : workspace ? activeMembersCount : 'Unavailable'}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Suspended</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : workspace ? suspendedMembersCount : 'Unavailable'}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Awaiting Setup</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : workspace ? pendingSetupCount : 'Unavailable'}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Password Resets</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : auditEntries ? auditEntries.filter((a) => a.action.includes('PASSWORD_RESET')).length : 'Unavailable'}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">MFA Resets</p>
                <p className="text-xl font-bold text-foreground">
                  {loading ? '…' : auditEntries ? auditEntries.filter((a) => a.action.includes('MFA_RESET')).length : 'Unavailable'}
                </p>
              </div>
            </div>
          </div>

          {/* Section 3: Workspace Security Policies */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Workspace Security Policies</h2>
              </div>
            </div>

            <div className="divide-y divide-border text-xs">
              <div className="py-3 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">Require HawkView MFA</p>
                  <p className="text-[11px] text-muted-foreground">Mandate multi-factor authentication for all workspace members.</p>
                </div>
                <span className="text-xs text-muted-foreground font-medium bg-muted px-2.5 py-1 rounded border border-border/60">
                  Enforced for all members
                </span>
              </div>

              <div className="py-3 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">Restrict Invitations by Email Domain</p>
                  <p className="text-[11px] text-muted-foreground">Allow invitations only to matching company domain addresses.</p>
                </div>
                <span className="text-xs text-muted-foreground font-medium bg-muted px-2.5 py-1 rounded border border-border/60">
                  Configuration unavailable
                </span>
              </div>

              <div className="py-3 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">Session Timeout Duration</p>
                  <p className="text-[11px] text-muted-foreground">Inactivity threshold before requiring re-authentication.</p>
                </div>
                <span className="text-xs font-mono text-muted-foreground bg-muted px-2.5 py-1 rounded border border-border/60">
                  24 Hours (Default)
                </span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border/60 text-xs text-muted-foreground flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
              <span>
                Note: Workspace security policies affect HawkView console access and accounts, not connected Microsoft 365 tenant identities.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: NOTIFICATIONS */}
      {activeTab === 'notifications' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-5">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <h2 className="text-sm font-bold text-foreground">Notification Preferences</h2>
              </div>
              {prefSaving && (
                <span className="text-xs text-muted-foreground flex items-center gap-1.5 font-medium">
                  <RefreshCcw className="h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  Saving preferences…
                </span>
              )}
            </div>

            {/* Read-only banner if notification preferences are not persisted */}
            {!notificationPrefs && !loading && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Notification preference saving is not available yet.</span>
              </div>
            )}

            <div className="space-y-6 text-xs">
              {/* Category 1: Security */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-1">
                  Security Alerts
                </h3>
                <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border bg-card hover:bg-muted/20 transition-colors">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-foreground">Password resets, MFA resets, and role changes</p>
                    <p className="text-[11px] text-muted-foreground">Receive immediate notifications for member authentication and privilege alterations.</p>
                  </div>
                  <Checkbox
                    checked={formNotificationPrefs?.securityEnabled ?? true}
                    disabled={!notificationPrefs || prefSaving}
                    onCheckedChange={(checked) => {
                      if (!formNotificationPrefs) return
                      setFormNotificationPrefs({ ...formNotificationPrefs, securityEnabled: Boolean(checked), })
                    }}
                    aria-label="Toggle Security Alerts"
                  />
                </div>
              </div>

              {/* Category 2: Tenant Operations */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-1">
                  Tenant Operations
                </h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border bg-card hover:bg-muted/20 transition-colors">
                    <div className="space-y-0.5">
                      <p className="font-semibold text-foreground">Connection or consent problems</p>
                      <p className="text-[11px] text-muted-foreground">Alerts when Microsoft 365 tenant authorization or partner consent degrades.</p>
                    </div>
                    <Checkbox
                      checked={formNotificationPrefs?.connectionEnabled ?? true}
                      disabled={!notificationPrefs || prefSaving}
                      onCheckedChange={(checked) => {
                        if (!formNotificationPrefs) return
                        setFormNotificationPrefs({ ...formNotificationPrefs, connectionEnabled: Boolean(checked), })
                      }}
                      aria-label="Toggle Connection or consent problems"
                    />
                  </div>

                  <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border bg-card hover:bg-muted/20 transition-colors">
                    <div className="space-y-0.5">
                      <p className="font-semibold text-foreground">Synchronization failures & stale tenant data</p>
                      <p className="text-[11px] text-muted-foreground">Alerts for automated sync job failures or stale security score telemetry.</p>
                    </div>
                    <Checkbox
                      checked={formNotificationPrefs?.synchronizationEnabled ?? true}
                      disabled={!notificationPrefs || prefSaving}
                      onCheckedChange={(checked) => {
                        if (!formNotificationPrefs) return
                        setFormNotificationPrefs({ ...formNotificationPrefs, synchronizationEnabled: Boolean(checked), })
                      }}
                      aria-label="Toggle Synchronization failures"
                    />
                  </div>
                </div>
              </div>

              {/* Category 3: Team */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-1">
                  Team Membership
                </h3>
                <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border bg-card hover:bg-muted/20 transition-colors">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-foreground">Invitations, account setup, suspensions, and removals</p>
                    <p className="text-[11px] text-muted-foreground">Notifications when members are invited, complete setup, or get suspended.</p>
                  </div>
                  <Checkbox
                    checked={formNotificationPrefs?.accountEnabled ?? true}
                    disabled={!notificationPrefs || prefSaving}
                    onCheckedChange={(checked) => {
                      if (!formNotificationPrefs) return
                      setFormNotificationPrefs({ ...formNotificationPrefs, accountEnabled: Boolean(checked), })
                    }}
                    aria-label="Toggle Team Membership notifications"
                  />
                </div>
              </div>

              {/* Category 4: Delivery */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-1">
                  Delivery Preferences
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-foreground">Minimum Severity Threshold</Label>
                    <select
                      value={formNotificationPrefs?.minimumSeverity || 'info'}
                      disabled={!notificationPrefs || prefSaving}
                      onChange={(e) => {
                        if (!formNotificationPrefs) return
                        setFormNotificationPrefs({
                          ...formNotificationPrefs,
                          minimumSeverity: e.target.value as NotificationPref['minimumSeverity'],
                        })
                      }}
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                    >
                      <option value="info">Info (All notifications)</option>
                      <option value="low">Low severity and above</option>
                      <option value="medium">Medium severity and above</option>
                      <option value="high">High severity and above</option>
                      <option value="critical">Critical only</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-foreground">Delivery Mode</Label>
                    <select
                      value={formNotificationPrefs?.digestMode || 'off'}
                      disabled={!notificationPrefs || prefSaving}
                      onChange={(e) => {
                        if (!formNotificationPrefs) return
                        setFormNotificationPrefs({
                          ...formNotificationPrefs,
                          digestMode: e.target.value as NotificationPref['digestMode'],
                        })
                      }}
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                    >
                      <option value="off">Real-time / Instant delivery</option>
                      <option value="daily">Daily summary digest</option>
                      <option value="weekly">Weekly summary digest</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              {notificationPrefs && (
                <div className="pt-4 border-t border-border flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCancelNotificationPrefs}
                    disabled={!isPrefDirty || prefSaving}
                    className="h-8 text-xs"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSaveNotificationPrefs}
                    disabled={!isPrefDirty || prefSaving}
                    className="h-8 text-xs font-semibold gap-1.5"
                  >
                    {prefSaving ? (
                      <>
                        <RefreshCcw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        <span>Saving…</span>
                      </>
                    ) : (
                      <span>Save changes</span>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: AUDIT HISTORY */}
      {activeTab === 'audit' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden space-y-0">
            {/* Toolbar */}
            <div className="p-4 border-b border-border space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-foreground">Administrative Activity Audit History</h2>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground font-medium">
                    Showing {filteredAndSortedAuditLogs.length} of{' '} {auditEntries.length} event(s)
                  </span>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleExportCSV}
                    disabled={filteredAndSortedAuditLogs.length === 0}
                    className="h-7 text-xs font-semibold gap-1.5 hover:bg-accent/80"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Export CSV</span>
                  </Button>
                </div>
              </div>

              {/* Filters row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    type="text"
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    placeholder="Search action, actor, or target…"
                    className="pl-8 h-8 text-xs"
                    aria-label="Search audit events"
                  />
                  {auditSearch && (
                    <button
                      type="button"
                      onClick={() => setAuditSearch('')}
                      className="absolute right-2 top-2 text-muted-foreground hover:text-foreground p-0.5"
                      aria-label="Clear search"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Outcome Filter */}
                <div>
                  <select
                    aria-label="Filter by outcome"
                    value={auditOutcomeFilter}
                    onChange={(e) => setAuditOutcomeFilter(e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All outcomes</option>
                    <option value="SUCCEEDED">Succeeded</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </div>

                {/* Date Range Preset */}
                <div>
                  <select
                    aria-label="Filter by date range"
                    value={auditDateRange}
                    onChange={(e) => setAuditDateRange(e.target.value as typeof auditDateRange)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <option value="ALL">All time</option>
                    <option value="24H">Last 24 hours</option>
                    <option value="7D">Last 7 days</option>
                    <option value="30D">Last 30 days</option>
                    <option value="CUSTOM">Custom date range</option>
                  </select>
                </div>

                {/* Reset Filters */}
                {(auditSearch || auditOutcomeFilter !== 'ALL' || auditDateRange !== 'ALL') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setAuditSearch('')
                      setAuditOutcomeFilter('ALL')
                      setAuditDateRange('ALL')
                      setAuditCustomStartDate('')
                      setAuditCustomEndDate('')
                    }}
                    className="h-8 text-xs text-muted-foreground hover:text-foreground justify-center"
                  >
                    Reset all filters
                  </Button>
                )}
              </div>

              {/* Custom Date Inputs if CUSTOM date range selected */}
              {auditDateRange === 'CUSTOM' && (
                <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground font-medium">Start:</span>
                    <Input
                      type="date"
                      value={auditCustomStartDate}
                      onChange={(e) => setAuditCustomStartDate(e.target.value)}
                      className="h-8 text-xs w-36"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground font-medium">End:</span>
                    <Input
                      type="date"
                      value={auditCustomEndDate}
                      onChange={(e) => setAuditCustomEndDate(e.target.value)}
                      className="h-8 text-xs w-36"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Audit Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-muted/50 border-b border-border">
                  <tr className="font-semibold text-muted-foreground text-[11px] uppercase tracking-wider">
                    {/* Sortable Column: Date & Time */}
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (auditSortField === 'createdAt') {
                            setAuditSortDir(auditSortDir === 'asc' ? 'desc' : 'asc')
                          } else {
                            setAuditSortField('createdAt')
                            setAuditSortDir('desc')
                          }
                        }}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Date & Time</span>
                        {auditSortField === 'createdAt' ? (
                          auditSortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>

                    {/* Sortable Column: Action */}
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (auditSortField === 'action') {
                            setAuditSortDir(auditSortDir === 'asc' ? 'desc' : 'asc')
                          } else {
                            setAuditSortField('action')
                            setAuditSortDir('asc')
                          }
                        }}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Action</span>
                        {auditSortField === 'action' ? (
                          auditSortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>

                    {/* Sortable Column: Affected Target */}
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (auditSortField === 'target') {
                            setAuditSortDir(auditSortDir === 'asc' ? 'desc' : 'asc')
                          } else {
                            setAuditSortField('target')
                            setAuditSortDir('asc')
                          }
                        }}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Affected Target</span>
                        {auditSortField === 'target' ? (
                          auditSortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>

                    {/* Sortable Column: Performed By */}
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (auditSortField === 'actor') {
                            setAuditSortDir(auditSortDir === 'asc' ? 'desc' : 'asc')
                          } else {
                            setAuditSortField('actor')
                            setAuditSortDir('asc')
                          }
                        }}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Performed By</span>
                        {auditSortField === 'actor' ? (
                          auditSortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>

                    {/* Sortable Column: Outcome */}
                    <th scope="col" className="py-2.5 px-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (auditSortField === 'outcome') {
                            setAuditSortDir(auditSortDir === 'asc' ? 'desc' : 'asc')
                          } else {
                            setAuditSortField('outcome')
                            setAuditSortDir('asc')
                          }
                        }}
                        className="flex items-center gap-1 hover:text-foreground focus-visible:outline-none"
                      >
                        <span>Outcome</span>
                        {auditSortField === 'outcome' ? (
                          auditSortDir === 'asc' ? ( <ArrowUp className="h-3 w-3" />
                          ) : ( <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    </th>

                    <th scope="col" className="py-2.5 px-4 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {auditEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-muted-foreground space-y-1">
                        <History className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" aria-hidden="true" />
                        <p className="font-medium text-foreground text-xs">No administrative activity recorded</p>
                        <p className="text-[11px] text-muted-foreground">
                          Audit events will automatically appear here as administrative actions occur.
                        </p>
                      </td>
                    </tr>
                  ) : filteredAndSortedAuditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-muted-foreground space-y-1">
                        <Search className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" aria-hidden="true" />
                        <p className="font-medium text-foreground text-xs">No matching audit events found</p>
                        <p className="text-[11px] text-muted-foreground">
                          Try adjusting your search keywords, outcome filter, or date range.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    filteredAndSortedAuditLogs.map((entry) => (
                      <tr
                        key={entry.id}
                        tabIndex={0}
                        onClick={() => setAuditDrawerEntry(entry)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setAuditDrawerEntry(entry)
                          }
                        }}
                        className="hover:bg-muted/40 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-muted/50"
                      >
                        <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                          {formatDateTime(entry.createdAt)}
                        </td>
                        <td className="py-3 px-4 font-semibold text-foreground whitespace-nowrap">
                          {formatActionLabel(entry.action)}
                        </td>
                        <td className="py-3 px-4 text-foreground/90 max-w-[180px] truncate">
                          {workspaceAuditTargetLabel(entry, auditMembers)}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground max-w-[180px] truncate">
                          {workspaceAuditActorLabel(entry, auditMembers)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${auditOutcomeStyle(entry.outcome)}`}
                          >
                            {entry.outcome === 'SUCCEEDED' ? (
                              <CheckCircle2
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            ) : entry.outcome === 'STARTED' ? (
                              <Clock className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <AlertCircle className="h-3 w-3" aria-hidden="true" />
                            )}
                            <span>{entry.outcome === 'SUCCEEDED' ? 'Succeeded' : entry.outcome}</span>
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              setAuditDrawerEntry(entry)
                            }}
                            className="h-7 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
                          >
                            View details
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
                    ? 'HawkView account record present'
                    : 'HawkView account record not reported'}
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
                {auditEntries.filter((a) => a.targetUserId === accountDrawerMember.userId ||
                    a.targetEmail === accountDrawerMember.email).length === 0 ? (
                  <p className="text-muted-foreground">No recent administrative actions recorded for this account.</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {auditEntries
                      .filter((a) =>
                          a.targetUserId === accountDrawerMember.userId || a.targetEmail === accountDrawerMember.email)
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
                  Audit Event Details
                </h3>
                <p className="text-xs text-muted-foreground">{formatActionLabel(auditDrawerEntry.action)}</p>
              </div>
              <button
                type="button"
                onClick={() => setAuditDrawerEntry(null)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                aria-label="Close audit log details"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Event ID</span>
                <p className="font-mono text-[11px] text-foreground select-all break-all">{auditDrawerEntry.id}</p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Timestamp</span>
                <p className="font-semibold text-foreground">{formatDateTime(auditDrawerEntry.createdAt)}</p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Action Code</span>
                <p className="font-mono text-xs font-semibold text-foreground">{auditDrawerEntry.action}</p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Outcome</span>
                <div>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
                      auditDrawerEntry.outcome === 'SUCCEEDED'
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-300/40 dark:border-emerald-800/40'
                        : auditDrawerEntry.outcome === 'STARTED'
                          ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-300/40 dark:border-blue-800/40'
                          : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-300/40 dark:border-rose-800/40'
                    }`}
                  >
                    {auditDrawerEntry.outcome === 'SUCCEEDED' ? (
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    ) : auditDrawerEntry.outcome === 'STARTED' ? (
                      <Clock className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <AlertCircle className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>{auditDrawerEntry.outcome}</span>
                  </span>
                </div>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Performed By</span>
                <p className="font-semibold text-foreground">{workspaceAuditActorLabel(auditDrawerEntry, auditMembers)}</p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Affected Target</span>
                <p className="font-semibold text-foreground">{workspaceAuditTargetLabel(auditDrawerEntry, auditMembers)}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Stage
                  </span>
                  <p className="font-mono text-[11px] break-all">
                    {auditDrawerEntry.stage || 'Not reported'}
                  </p>
                </div>
                <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Safe error code
                  </span>
                  <p className="font-mono text-[11px] break-all">
                    {auditDrawerEntry.errorCode || 'Not reported'}
                  </p>
                </div>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Request ID
                </span>
                <p className="font-mono text-[11px] text-foreground select-all break-all">
                  {workspaceAuditSafeIdentifier(auditDrawerEntry.requestId)}
                </p>
              </div>

              <div className="space-y-1 bg-muted/30 p-3 rounded-lg border border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Operation ID
                </span>
                <p className="font-mono text-[11px] text-foreground select-all break-all">
                  {workspaceAuditSafeIdentifier(auditDrawerEntry.operationId)}</p>
              </div>

              {workspaceAuditMetadataRows(auditDrawerEntry.metadata).length > 0 && (
                <dl className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    {workspaceAuditMetadataRows(auditDrawerEntry.metadata).map(
                    (row) => (
                      <div
                        key={row.key}
                        className="flex items-start justify-between gap-4"
                      >
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="text-right font-medium text-foreground">
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
              )}
            </div>

            <div className="border-t border-border pt-4 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAuditDrawerEntry(null)}
                className="h-8 text-xs font-semibold"
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
                Change role for {' '}
                {roleChangeMember.displayName || roleChangeMember.email}
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
              Select the new workspace role for{' '} <strong>{roleChangeMember.email}</strong>:
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
                  A password reset email will be sent for this user&apos;s{' '} <strong>HawkView account</strong>. This action does not affect Microsoft 365 passwords or tenant credentials.
                </p>
              )}
              {confirmModal.type === 'MFA_RESET' && (
                <p>
                  This removes every authenticator from their{' '} <strong>HawkView account</strong>, signs out their active sessions, and requires enrollment again. This does not alter Microsoft Entra ID or M365 MFA.
                </p>
              )}
              {confirmModal.type === 'REMOVE' && (
                <p>
                  This will immediately remove{' '} <strong>{confirmModal.member.email}</strong> from this HawkView workspace.
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
                  The member&apos;s role will be updated to{' '} <strong>{roleLabel(confirmModal.targetRole!)}</strong>.
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

      {/* Bulk Action Confirmation Modal */}
      {bulkConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-confirm-modal-title"
            className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2.5">
                {bulkConfirmModal.action === 'REMOVE' ? (
                  <div className="p-2 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
                    <Trash2 className="h-5 w-5" />
                  </div>
                ) : bulkConfirmModal.action === 'SUSPEND' ? (
                  <div className="p-2 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <UserX className="h-5 w-5" />
                  </div>
                ) : (
                  <div className="p-2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <Users className="h-5 w-5" />
                  </div>
                )}

                <div>
                  <h3 id="bulk-confirm-modal-title" className="text-sm font-bold">
                    {bulkConfirmModal.action === 'ROLE_CHANGE'
                      ? `Bulk change workspace role`
                      : bulkConfirmModal.action === 'SUSPEND'
                      ? `Bulk suspend ${selectedMembers.length} member accounts?`
                      : bulkConfirmModal.action === 'REACTIVATE'
                      ? `Bulk reactivate ${selectedMembers.length} member accounts?`
                      : bulkConfirmModal.action === 'PASSWORD_RESET'
                      ? `Send HawkView password reset to ${selectedMembers.length} members?`
                      : bulkConfirmModal.action === 'MFA_RESET'
                      ? `Reset HawkView MFA for ${selectedMembers.length} members?`
                      : bulkConfirmModal.action === 'RESEND_INVITE'
                      ? `Resend invitations to ${selectedMembers.length} members?`
                      : `Bulk remove ${selectedMembers.length} members from workspace?`}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedMembers.length} team member{selectedMembers.length === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setBulkConfirmModal(null)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="text-xs text-muted-foreground bg-muted/40 p-3 rounded-lg border border-border space-y-1">
              <p className="font-medium text-foreground">Important Note:</p>
              <p>
                This action affects HawkView accounts only and does not modify Microsoft 365 accounts.
              </p>
            </div>

            {bulkConfirmModal.action === 'ROLE_CHANGE' && (
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Select Target Role</Label>
                <div className="space-y-1.5">
                  {roles.map((r) => {
                    const isSelected = bulkConfirmModal.targetRole === r.value
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() =>
                          setBulkConfirmModal({ ...bulkConfirmModal, targetRole: r.value, })
                        }
                        className={`w-full flex items-start justify-between p-2.5 rounded-lg border text-left text-xs transition-colors ${
                          isSelected
                            ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                            : 'border-border hover:bg-accent/60'
                        }`}
                      >
                        <div>
                          <p className="font-semibold text-foreground">{r.label}</p>
                          <p className="text-[11px] text-muted-foreground">{r.description}</p>
                        </div>
                        {isSelected && (
                          <span className="text-blue-600 dark:text-blue-400 font-semibold text-[11px]">
                            Selected
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Selected Members List with Protection Badges */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-foreground">Affected Members ({selectedMembers.length})</p>
              <div className="max-h-48 overflow-y-auto divide-y divide-border border border-border rounded-lg bg-card text-xs">
                {selectedMembers.map((m) => {
                  const isSelf = m.userId === currentUserId
                  const isFinal = isFinalActiveOwner(m)
                  const isProtected =
                    (bulkConfirmModal.action === 'ROLE_CHANGE' && bulkConfirmModal.targetRole !== 'MSP_OWNER' && (isSelf || isFinal)) ||
                    ((bulkConfirmModal.action === 'SUSPEND' || bulkConfirmModal.action === 'REMOVE') && (isSelf || isFinal))

                  return (
                    <div key={m.membershipId} className="p-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground truncate">{m.displayName || m.email}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{m.email}</p>
                      </div>
                      {isProtected ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-800 shrink-0">
                          Protected — skipped
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground shrink-0">
                          Will update
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkConfirmModal(null)}
                disabled={submitting}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button
                variant={bulkConfirmModal.action === 'REMOVE' ? 'destructive' : 'default'}
                size="sm"
                onClick={() => void handleExecuteBulkAction()}
                disabled={
                  submitting ||
                  (bulkConfirmModal.action === 'ROLE_CHANGE' && !bulkConfirmModal.targetRole)
                }
                className="h-8 text-xs font-semibold gap-1.5"
              >
                {submitting ? (
                  <>
                    <RefreshCcw className="h-3.5 w-3.5 animate-spin" />
                    <span>Processing bulk action…</span>
                  </>
                ) : (
                  <span>Confirm bulk action</span>
                )}
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
                  Name{' '} <span className="text-muted-foreground font-normal">(optional)</span>
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
                (a) => a.targetUserId === memberAuditMember.userId ||
                  a.actorUserId === memberAuditMember.userId ||
                  a.targetEmail === memberAuditMember.email || a.actorEmail === memberAuditMember.email
              ).length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No administrative events recorded for this member.
                </p>
              ) : (
                auditEntries
                  .filter(
                    (a) =>
                      a.targetUserId === memberAuditMember.userId ||
                      a.actorUserId === memberAuditMember.userId || a.targetEmail === memberAuditMember.email || a.actorEmail === memberAuditMember.email
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
                          className={`inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium ${auditOutcomeStyle(entry.outcome)}`}
                        >
                          {entry.outcome}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>By: {workspaceAuditActorLabel(entry, auditMembers)}</span>
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

export default function LegacyAdminPanelPage() {
  return <AdminPanelPage />
}
