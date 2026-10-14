'use client'

import { useMemo } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { tenantUserMfaRegistration } from '@/lib/tenants/mfa-status'
import { conditionalAccessOverviewState } from '@/lib/tenants/conditional-access-overview'
import { PimScheduleObservationsPanel } from '@/components/tenant/pim-schedule-observations-panel'
import { DirectoryRoleAssignmentsPanel } from '@/components/tenant/directory-role-assignments-panel'
import type { PilotEvidenceView } from '@/lib/tenants/collection-readiness'
import {
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Activity,
} from 'lucide-react'

export type TenantUser = {
  id: string
  name: string
  email: string
  type: 'Member' | 'Guest'
  role: 'Global Administrator' | 'User' | 'External Auditor' | 'Service Account'
  status: 'Enabled' | 'Disabled'
  mfa: 'Enforced' | 'Enabled' | 'Disabled' | 'Unknown'
  mfaRegistration?: 'Registered' | 'Not registered' | 'Unknown'
  perUserMfaState?: 'Enabled' | 'Enforced' | 'Disabled' | 'Unknown'
  lastLogin?: string
  authMethods?: string[]
  licenses?: string[]
  groups?: string[]
  devices?: { name: string; os: string; lastSync: string; status: string }[]
  isSynced?: boolean
}

export type SignInResult = 'Success' | 'Failure' | 'Not reported'

export type SignInEvent = {
  id: string
  userId: string
  userDisplayName: string
  userPrincipalName: string
  createdAt: string
  ipAddress: string
  result: SignInResult
  appDisplayName: string
  clientAppUsed: string
  country: string
  city?: string
  latitude: number
  longitude: number
  riskLevel?: 'low' | 'medium' | 'high'
}

export type CaPolicyState = 'ON' | 'REPORT_ONLY' | 'OFF'
export type CaPolicyOrigin =
  | 'MICROSOFT_TEMPLATE'
  | 'MICROSOFT_ENFORCED'
  | 'CUSTOM'

export type CaPolicy = {
  id: string
  name: string
  targetSummary: string
  grantSummary: string
  origin: CaPolicyOrigin
  state: CaPolicyState
}

export type AuthMethodRow = {
  id?: string
  method: string
  enabled: boolean
  users: number
  lastUpdated?: string
}

export type NamedLocation = {
  id: string
  name: string
  type: string
  ipCount?: number
  countryCount?: number
  isTrusted?: boolean
}

interface EntraOverviewSectionProps {
  tenant: any
  bundle: any
  users: TenantUser[]
  signIns: SignInEvent[]
  caPolicies: unknown
  conditionalAccessEvidence: PilotEvidenceView['conditionalAccess'] | null
  authMethods: AuthMethodRow[]
  namedLocations: NamedLocation[]
  /** Route customer tenant id from the page (resolvedTenantId), not the Microsoft tenant id. */
  resolvedTenantId: string
  onNavigateTab: (
    tab:
      | 'overview'
      | 'users'
      | 'groups'
      | 'app-registrations'
      | 'enterprise-apps'
      | 'security'
      | 'licenses'
      | 'identity',
    securityView?: 'policies' | 'sign-ins' | 'auth' | 'locations'
  ) => void
}

function formatSignInTime(dateStr: string) {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return dateStr
  }
}

function collectionEvidence(sync: any) {
  const observed = Boolean(sync?.lastSuccessfulAt)
  const latestFailed = sync?.outcomeProjection?.recordedOutcome?.kind === 'FAILED'
  return {
    observed,
    supported: observed && !latestFailed,
    reason: latestFailed ? 'latest attempt failed' : !observed ? 'not reported' : null,
  }
}

export default function EntraOverviewSection({
  tenant,
  bundle,
  users,
  signIns,
  caPolicies,
  conditionalAccessEvidence,
  authMethods,
  namedLocations,
  resolvedTenantId,
  onNavigateTab,
}: EntraOverviewSectionProps) {
  // DIRECTORY DATA CALCULATIONS
  const usersCollection = collectionEvidence(bundle?.sync?.users)
  const authMethodsCollection = collectionEvidence(bundle?.sync?.authMethodPolicies)
  const authRegistrationsCollection = collectionEvidence(bundle?.sync?.authRegistrations)
  const namedLocationsCollection = collectionEvidence(bundle?.sync?.namedLocations)
  const signInsCollection = collectionEvidence(bundle?.sync?.signIns)
  const usersSynchronized = usersCollection.observed
  const totalUsers = usersSynchronized ? users.length : null
  const enabledUsers = usersSynchronized
    ? users.filter((u) => u.status === 'Enabled').length
    : null
  const disabledUsers = usersSynchronized
    ? users.filter((u) => u.status === 'Disabled').length
    : null
  const guestUsers = usersSynchronized
    ? users.filter((u) => u.type === 'Guest').length
    : null
  const licensedUsers = usersSynchronized
    ? users.filter((u) => Array.isArray(u.licenses) && u.licenses.length > 0)
        .length
    : null
  const adminUsers = usersSynchronized
    ? users.filter((u) => u.role && u.role.toLowerCase().includes('admin'))
        .length
    : null

  const groupsSynchronized =
    Array.isArray(bundle?.exchange?.groups) ||
    users.some((u) => u.groups?.length)
  const totalGroups = groupsSynchronized
    ? Array.from(
        new Set([
          ...(bundle?.exchange?.groups?.map(
            (g: any) => g.displayName || g.email || g.id
          ) || []),
          ...users.flatMap((u) => u.groups || []),
        ])
      ).length
    : null

  const devicesSynchronized = users.some(
    (u) => Array.isArray(u.devices) && u.devices.length > 0
  )
  const totalDevices = devicesSynchronized
    ? users.flatMap((u) => u.devices || []).length
    : null

  // SECURITY DATA CALCULATIONS
  const caOverview = useMemo(
    () => conditionalAccessOverviewState(conditionalAccessEvidence, caPolicies),
    [conditionalAccessEvidence, caPolicies]
  )

  const authMethodsSynchronized = authMethodsCollection.observed
  const namedLocationsSynchronized = namedLocationsCollection.observed

  const activeUsersCount = enabledUsers ?? 0
  const enabledUserRegistrations = usersSynchronized
    ? users.filter((u) => u.status === 'Enabled').map(tenantUserMfaRegistration)
    : []
  const mfaRegisteredUsersCount = enabledUserRegistrations.filter(
    (state) => state === 'Registered'
  ).length
  const mfaUnreportedUsersCount = enabledUserRegistrations.filter(
    (state) => state === 'Unknown'
  ).length
  // The same predicate controls both the default coverage warning and the
  // overall verdict. It covers the full stored enabled-user array, not a page.
  const mfaRegistrationEvidenceSupported =
    usersCollection.supported &&
    authRegistrationsCollection.supported &&
    mfaUnreportedUsersCount === 0
  const mfaRegistrationCoveragePct =
    mfaRegistrationEvidenceSupported && activeUsersCount > 0
      ? Math.round((mfaRegisteredUsersCount / activeUsersCount) * 100)
      : null


  // SIGN-INS CALCULATIONS FOR COMPACT SUMMARY ROW
  const totalSignInsCount = signIns.length
  const successSignInsCount = useMemo(
    () => signIns.filter((e) => e.result === 'Success').length,
    [signIns]
  )
  const failedSignInsCount = useMemo(
    () => signIns.filter((e) => e.result === 'Failure').length,
    [signIns]
  )
  const notReportedSignInsCount = totalSignInsCount - successSignInsCount - failedSignInsCount
  const signInEvidenceIncomplete = totalSignInsCount === 0 || notReportedSignInsCount > 0
  const uniqueUsersCount = useMemo(
    () => new Set(signIns.map((e) => e.userId || e.userPrincipalName)).size,
    [signIns]
  )
  const mostRecentSignInTime = useMemo(() => {
    if (signIns.length === 0) return null
    return signIns[0]?.createdAt || null
  }, [signIns])

  // This closed list is shared by the verdict gate and its evidence disclosure.
  const verdictEvidence = [
    { label: 'Users collection', supported: usersCollection.supported, reason: usersCollection.reason },
    { label: 'Authentication-method policies', supported: authMethodsCollection.supported, reason: authMethodsCollection.reason },
    {
      label: 'MFA registration',
      supported: mfaRegistrationEvidenceSupported,
      reason: authRegistrationsCollection.reason ??
        (mfaUnreportedUsersCount > 0 ? `${mfaUnreportedUsersCount} enabled user state${mfaUnreportedUsersCount === 1 ? '' : 's'} not reported` :
          !usersCollection.supported ? `users collection ${usersCollection.reason ?? 'not reported'}` : null),
    },
    { label: 'Conditional Access', supported: caOverview.authoritative, reason: caOverview.authoritative ? null : caOverview.value },
    {
      label: 'Sign-ins',
      supported: signInsCollection.supported && !signInEvidenceIncomplete,
      reason: signInsCollection.reason ?? (signInEvidenceIncomplete ? 'outcomes not fully reported' : null),
    },
  ] as const
  const unsupportedEvidence = verdictEvidence.filter((item) => !item.supported)
  const hasObservedWarning =
    failedSignInsCount > 0 ||
    caOverview.contributesWarning ||
    (mfaRegistrationCoveragePct !== null && mfaRegistrationCoveragePct < 80) ||
    (bundle?.entra?.riskyUsers?.length || 0) > 0
  const overallStatus: 'Healthy' | 'Needs attention' | 'Incomplete data' =
    hasObservedWarning
      ? 'Needs attention'
      : unsupportedEvidence.length > 0
        ? 'Incomplete data'
        : 'Healthy'

  // Security posture checklist items
  const securityRows = useMemo(() => {
    return [
      {
        id: 'ca',
        name: 'Conditional Access',
        value: caOverview.value,
        detail: caOverview.detail,
        status: caOverview.status,
        action: () => onNavigateTab('security', 'policies'),
      },
      {
        id: 'mfa',
        name: 'MFA registration coverage',
        value: !usersSynchronized
          ? 'Awaiting collection'
          : activeUsersCount === 0
            ? 'No enabled users reported'
            : mfaRegistrationCoveragePct !== null
              ? `${mfaRegisteredUsersCount} of ${activeUsersCount} registered (${mfaRegistrationCoveragePct}%)`
              : authRegistrationsCollection.supported && usersCollection.supported
                ? `${mfaRegisteredUsersCount} registered of ${activeUsersCount} enabled; ${mfaUnreportedUsersCount} not reported`
                : 'Coverage not fully reported',
        detail: mfaUnreportedUsersCount > 0 && authRegistrationsCollection.supported
          ? `${mfaUnreportedUsersCount} enabled user registration state${mfaUnreportedUsersCount === 1 ? ' was' : 's were'} not reported; no all-user percentage`
          : 'Registered methods; not enforcement state',
        status: mfaRegistrationCoveragePct === null
          ? 'neutral'
          : mfaRegistrationCoveragePct >= 80
            ? 'healthy'
            : 'warning',
        action: () => onNavigateTab('identity'),
      },
      {
        id: 'auth',
        name: 'Authentication methods',
        value: !authMethodsSynchronized
          ? 'Awaiting collection'
          : authMethodsCollection.supported
            ? `${authMethods.length} ${authMethods.length === 1 ? 'method' : 'methods'} configured`
            : `${authMethods.length} ${authMethods.length === 1 ? 'method' : 'methods'} last reported; latest collection failed`,
        detail: 'FIDO2, Authenticator & SMS settings',
        status: !authMethodsCollection.supported || authMethods.length === 0 ? 'neutral' : 'healthy',
        action: authMethodsSynchronized
          ? () => onNavigateTab('security', 'auth')
          : undefined,
      },
      {
        id: 'locations',
        name: 'Named locations',
        value: !namedLocationsSynchronized
          ? 'Awaiting collection'
          : namedLocationsCollection.supported
            ? `${namedLocations.length} ${namedLocations.length === 1 ? 'location' : 'locations'} configured`
            : `${namedLocations.length} ${namedLocations.length === 1 ? 'location' : 'locations'} last reported; latest collection failed`,
        detail: 'Trusted corporate network boundaries',
        status: !namedLocationsCollection.supported || namedLocations.length === 0 ? 'neutral' : 'healthy',
        action: namedLocationsSynchronized
          ? () => onNavigateTab('security', 'locations')
          : undefined,
      },
      {
        id: 'failures',
        name: 'Failed sign-ins',
        value: totalSignInsCount === 0
          ? 'No sign-in data'
          : `${failedSignInsCount} reported authentication failure${failedSignInsCount === 1 ? '' : 's'}`,
        detail: notReportedSignInsCount > 0
          ? `${notReportedSignInsCount} sign-in result${notReportedSignInsCount === 1 ? '' : 's'} not reported; evidence incomplete`
          : totalSignInsCount === 0 ? 'No sign-in outcomes available' : 'Authentication failures in current dataset',
        status: failedSignInsCount > 0 ? 'warning' : signInEvidenceIncomplete ? 'neutral' : 'healthy',
        action: () => onNavigateTab('security', 'sign-ins'),
      },

    ]
  }, [
    caOverview,
    usersSynchronized,
    mfaRegisteredUsersCount,
    activeUsersCount,
    mfaUnreportedUsersCount,
    mfaRegistrationCoveragePct,
    authRegistrationsCollection.supported,
    usersCollection.supported,
    authMethodsSynchronized,
    authMethodsCollection.supported,
    authMethods.length,
    namedLocationsSynchronized,
    namedLocationsCollection.supported,
    namedLocations.length,
    failedSignInsCount,
    totalSignInsCount,
    notReportedSignInsCount,
    signInEvidenceIncomplete,
    onNavigateTab,
  ])

  return (
    <div className="mt-4 space-y-6">

      {/* UNIFIED SURFACE: ENTRA AT A GLANCE */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
        {/* Header with subtle blue accent top gradient */}
        <div className="relative border-b border-slate-200 dark:border-slate-800 px-5 py-4 bg-slate-50/50 dark:bg-slate-800/40">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-600 via-indigo-500 to-sky-400" />
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2">
                Entra at a glance
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Directory inventory and identity security posture
              </p>
            </div>

          </div>
        </div>

        {/* Asymmetrical Layout: Directory (42%) / Security (58%) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
          {/* DIRECTORY INVENTORY (~42% -> lg:col-span-5) */}
          <div className="lg:col-span-5 p-5 flex flex-col justify-between space-y-6">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Directory Inventory
                </span>
              </div>

              {/* Big Number Header */}
              <div className="mt-3">
                {totalUsers !== null ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
                      {totalUsers}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      {usersCollection.supported ? 'Total users' : 'Last reported users'}
                    </span>
                  </div>
                ) : (
                  <div className="text-sm font-medium text-muted-foreground">
                    Awaiting collection
                  </div>
                )}
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Directory accounts
                </p>
              </div>

              {/* Composition Lines */}
              <div className="mt-5 space-y-4 text-xs">
                {/* Account status */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      Account status
                    </span>
                    {usersSynchronized && totalUsers !== null ? (
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        {enabledUsers} Enabled · {disabledUsers} Disabled
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Awaiting collection
                      </span>
                    )}
                  </div>
                  {usersSynchronized &&
                  totalUsers !== null &&
                  totalUsers > 0 ? (
                    <>
                      <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex gap-0.5">
                        <div
                          style={{
                            width: `${Math.round(((enabledUsers || 0) / totalUsers) * 100)}%`,
                          }}
                          className="bg-emerald-500 rounded-l-full h-full"
                        />
                        <div
                          style={{
                            width: `${100 - Math.round(((enabledUsers || 0) / totalUsers) * 100)}%`,
                          }}
                          className="bg-slate-300 dark:bg-slate-600 rounded-r-full h-full"
                        />
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{' '}
                          Enabled
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />{' '}
                          Disabled
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>

                {/* User type */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      User type
                    </span>
                    {usersSynchronized && totalUsers !== null ? (
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        {totalUsers - (guestUsers || 0)} Members ·{' '}
                        {guestUsers || 0} Guests
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Awaiting collection
                      </span>
                    )}
                  </div>
                  {usersSynchronized &&
                  totalUsers !== null &&
                  totalUsers > 0 ? (
                    <>
                      <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex gap-0.5">
                        <div
                          style={{
                            width: `${Math.round(
                              ((totalUsers - (guestUsers || 0)) / totalUsers) *
                                100
                            )}%`,
                          }}
                          className="bg-indigo-500 rounded-l-full h-full"
                        />
                        <div
                          style={{
                            width: `${
                              100 -
                              Math.round(
                                ((totalUsers - (guestUsers || 0)) /
                                  totalUsers) *
                                  100
                              )
                            }%`,
                          }}
                          className="bg-amber-500 rounded-r-full h-full"
                        />
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />{' '}
                          Members
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{' '}
                          Guests
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>

                {/* Licensing */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      Licensing
                    </span>
                    {usersSynchronized &&
                    totalUsers !== null &&
                    licensedUsers !== null ? (
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        {licensedUsers} Licensed ·{' '}
                        {Math.max(0, totalUsers - licensedUsers)} Unlicensed
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Awaiting collection
                      </span>
                    )}
                  </div>
                  {usersSynchronized &&
                  totalUsers !== null &&
                  totalUsers > 0 &&
                  licensedUsers !== null ? (
                    <>
                      <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex gap-0.5">
                        <div
                          style={{
                            width: `${Math.round((licensedUsers / totalUsers) * 100)}%`,
                          }}
                          className="bg-sky-500 rounded-l-full h-full"
                        />
                        <div
                          style={{
                            width: `${100 - Math.round((licensedUsers / totalUsers) * 100)}%`,
                          }}
                          className="bg-slate-300 dark:bg-slate-600 rounded-r-full h-full"
                        />
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />{' '}
                          Licensed
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />{' '}
                          Unlicensed
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Metadata Strip */}
            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 grid grid-cols-3 divide-x divide-slate-200 dark:divide-slate-800 text-center">
              <div className="px-2">
                <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                  Groups
                </div>
                <div className="text-sm font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                  {totalGroups !== null ? (
                    totalGroups
                  ) : (
                    <span className="text-xs font-normal text-muted-foreground">
                      Awaiting collection
                    </span>
                  )}
                </div>
              </div>
              <div className="px-2">
                <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                  Devices
                </div>
                <div className="text-sm font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                  {totalDevices !== null ? (
                    totalDevices
                  ) : (
                    <span className="text-xs font-normal text-muted-foreground">
                      Awaiting collection
                    </span>
                  )}
                </div>
              </div>
              <div className="px-2">
                <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                  Admins
                </div>
                <div className="text-sm font-bold text-purple-600 dark:text-purple-400 mt-0.5">
                  {adminUsers !== null ? (
                    adminUsers
                  ) : (
                    <span className="text-xs font-normal text-muted-foreground">
                      Awaiting collection
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* SECURITY POSTURE (~58% -> lg:col-span-7) */}
          <div className="lg:col-span-7 p-5 flex flex-col justify-between">
            <div>
              {/* Posture Header */}
              <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Security Posture
                  </span>
                  <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                    {caOverview.value}
                  </div>
                </div>
                {/* Overall Badge */}
                <div>
                  {overallStatus === 'Healthy' ? (
                    <Badge className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 font-normal text-[11px]">
                      Healthy
                    </Badge>
                  ) : overallStatus === 'Needs attention' ? (
                    <Badge className="bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 font-normal text-[11px]">
                      Needs attention
                    </Badge>
                  ) : (
                    <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 font-normal text-[11px]">
                      Incomplete data
                    </Badge>
                  )}
                </div>
              </div>

              {unsupportedEvidence.length > 0 ? (
                <div aria-label="Entra evidence not fully reported" className="py-3 text-[11px] text-slate-600 dark:text-slate-400">
                  <span className="font-semibold">Evidence not fully reported:</span>{' '}
                  {unsupportedEvidence.map((item) => `${item.label}: ${item.reason ?? 'not reported'}`).join(' · ')}
                </div>
              ) : null}

              {/* Checklist Rows */}
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {securityRows.map((row) => (
                  <div
                    key={row.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-50/50 dark:hover:bg-slate-800/30 px-1 rounded-md transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {row.status === 'healthy' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                      ) : row.status === 'warning' ? (
                        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                      ) : row.status === 'error' ? (
                        <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-slate-300 dark:border-slate-600 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 dark:text-slate-200 leading-tight">
                          {row.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {row.detail}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-xs font-medium ${
                          row.status === 'warning'
                            ? 'text-amber-600 dark:text-amber-400 font-semibold'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {row.value}
                      </span>
                      {row.action ? (
                        <button
                          onClick={row.action}
                          className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                          title="View details"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      ) : (
                        <div className="w-6" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3 — COMPACT SIGN-IN ACTIVITY SUMMARY ROW */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Sign-in activity
              </h3>
              <p className="text-xs text-muted-foreground">
                Recent authentication events across directory accounts
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigateTab('security', 'sign-ins')}
            className="h-8 text-xs gap-1.5 border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-blue-600 dark:text-blue-400 font-semibold shrink-0"
          >
            View sign-in activity
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div>
            <span className="text-[11px] font-medium text-muted-foreground block">
              Total sign-ins
            </span>
            <span className="text-base font-bold text-slate-900 dark:text-slate-100">
              {totalSignInsCount}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-medium text-muted-foreground block">
              Successful
            </span>
            <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
              {successSignInsCount}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-medium text-muted-foreground block">
              Failed
            </span>
            <span className="text-base font-bold text-red-600 dark:text-red-400">
              {failedSignInsCount}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-medium text-muted-foreground block">
              Not reported
            </span>
            <span className="text-base font-bold text-slate-600">
              {notReportedSignInsCount}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-medium text-muted-foreground block">
              Unique users
            </span>
            <span className="text-base font-bold text-slate-900 dark:text-slate-100">
              {uniqueUsersCount}
            </span>
          </div>

          <div className="col-span-2 sm:col-span-1">
            <span className="text-[11px] font-medium text-muted-foreground block">
              Most recent
            </span>
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate block mt-0.5">
              {mostRecentSignInTime
                ? formatSignInTime(mostRecentSignInTime)
                : 'N/A'}
            </span>
          </div>
        </div>
      </div>
      <DirectoryRoleAssignmentsPanel bundle={bundle} customerTenantId={resolvedTenantId} className="mt-6" />
      <PimScheduleObservationsPanel customerTenantId={resolvedTenantId} className="mt-6" />
    </div>
  )
}
