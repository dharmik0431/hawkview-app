'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  lastLogin?: string
  authMethods?: string[]
  licenses?: string[]
  groups?: string[]
  devices?: { name: string; os: string; lastSync: string; status: string }[]
  isSynced?: boolean
}

export type SignInResult = 'Success' | 'Failure'

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
  caPolicies: CaPolicy[]
  authMethods: AuthMethodRow[]
  namedLocations: NamedLocation[]
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

function formatSyncTimestamp(lastSyncIso?: string) {
  if (!lastSyncIso) return 'Awaiting collection'
  try {
    const d = new Date(lastSyncIso)
    if (isNaN(d.getTime())) return 'Awaiting collection'
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return 'Awaiting collection'
  }
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

export default function EntraOverviewSection({
  tenant,
  bundle,
  users,
  signIns,
  caPolicies,
  authMethods,
  namedLocations,
  onNavigateTab,
}: EntraOverviewSectionProps) {
  // DIRECTORY DATA CALCULATIONS
  const usersSynchronized = Array.isArray(bundle?.users) || users.length > 0
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
  const caPoliciesSynchronized =
    Array.isArray(bundle?.entra?.caPolicies) || caPolicies.length > 0
  const enabledCaPoliciesCount = caPolicies.filter(
    (p) => p.state === 'ON'
  ).length

  const authMethodsSynchronized =
    Array.isArray(bundle?.entra?.authMethods) &&
    bundle?.entra?.authMethods.length > 0

  const namedLocationsSynchronized =
    Array.isArray(bundle?.entra?.namedLocations) || namedLocations.length > 0

  const activeUsersCount = enabledUsers ?? 0
  const mfaEnforcedUsersCount = usersSynchronized
    ? users.filter(
        (u) =>
          u.status === 'Enabled' &&
          (u.mfa === 'Enforced' || u.mfa === 'Enabled')
      ).length
    : 0
  const mfaCoveragePct =
    activeUsersCount > 0
      ? Math.round((mfaEnforcedUsersCount / activeUsersCount) * 100)
      : 0

  const formattedSyncTime = formatSyncTimestamp(tenant?.lastSync)

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
  const uniqueUsersCount = useMemo(
    () => new Set(signIns.map((e) => e.userId || e.userPrincipalName)).size,
    [signIns]
  )
  const mostRecentSignInTime = useMemo(() => {
    if (signIns.length === 0) return null
    return signIns[0]?.createdAt || null
  }, [signIns])

  // Overall posture status logic
  const overallStatus: 'Healthy' | 'Needs attention' | 'Incomplete data' =
    useMemo(() => {
      if (
        !caPoliciesSynchronized &&
        !usersSynchronized &&
        !authMethodsSynchronized
      ) {
        return 'Incomplete data'
      }
      if (
        failedSignInsCount > 0 ||
        (caPoliciesSynchronized && enabledCaPoliciesCount === 0) ||
        (usersSynchronized && mfaCoveragePct < 80) ||
        (bundle?.entra?.riskyUsers?.length || 0) > 0
      ) {
        return 'Needs attention'
      }
      return 'Healthy'
    }, [
      caPoliciesSynchronized,
      usersSynchronized,
      authMethodsSynchronized,
      failedSignInsCount,
      enabledCaPoliciesCount,
      mfaCoveragePct,
      bundle?.entra?.riskyUsers,
    ])

  // Security posture checklist items
  const securityRows = useMemo(() => {
    return [
      {
        id: 'ca',
        name: 'Conditional Access',
        value: caPoliciesSynchronized
          ? `${enabledCaPoliciesCount} of ${caPolicies.length} policies enabled`
          : 'Awaiting collection',
        detail: 'Access control and risk enforcement',
        status: !caPoliciesSynchronized
          ? 'neutral'
          : enabledCaPoliciesCount > 0
            ? 'healthy'
            : 'warning',
        action: () => onNavigateTab('security', 'policies'),
      },
      {
        id: 'mfa',
        name: 'MFA coverage',
        value: usersSynchronized
          ? `${mfaEnforcedUsersCount} of ${activeUsersCount} registered (${mfaCoveragePct}%)`
          : 'Awaiting collection',
        detail: 'Multi-factor authentication status',
        status: !usersSynchronized
          ? 'neutral'
          : mfaCoveragePct >= 80
            ? 'healthy'
            : 'warning',
        action: () => onNavigateTab('identity'),
      },
      {
        id: 'auth',
        name: 'Authentication methods',
        value: authMethodsSynchronized
          ? `${authMethods.length} methods configured`
          : 'Awaiting collection',
        detail: 'FIDO2, Authenticator & SMS settings',
        status: !authMethodsSynchronized ? 'neutral' : 'healthy',
        action: authMethodsSynchronized
          ? () => onNavigateTab('security', 'auth')
          : undefined,
      },
      {
        id: 'locations',
        name: 'Named locations',
        value: namedLocationsSynchronized
          ? `${namedLocations.length} locations configured`
          : 'Awaiting collection',
        detail: 'Trusted corporate network boundaries',
        status: !namedLocationsSynchronized ? 'neutral' : 'healthy',
        action: namedLocationsSynchronized
          ? () => onNavigateTab('security', 'locations')
          : undefined,
      },
      {
        id: 'failures',
        name: 'Failed sign-ins',
        value: `${failedSignInsCount} authentication failure${failedSignInsCount === 1 ? '' : 's'}`,
        detail: 'Authentication failures in current dataset',
        status: failedSignInsCount > 0 ? 'warning' : 'healthy',
        action: () => onNavigateTab('security', 'sign-ins'),
      },
      {
        id: 'sync',
        name: 'Synchronization health',
        value:
          formattedSyncTime !== 'Awaiting collection'
            ? `Last sync: ${formattedSyncTime}`
            : 'Awaiting collection',
        detail: 'Directory data freshness',
        status:
          formattedSyncTime !== 'Awaiting collection' ? 'healthy' : 'neutral',
        action: undefined,
      },
    ]
  }, [
    caPoliciesSynchronized,
    enabledCaPoliciesCount,
    caPolicies.length,
    usersSynchronized,
    mfaEnforcedUsersCount,
    activeUsersCount,
    mfaCoveragePct,
    authMethodsSynchronized,
    authMethods.length,
    namedLocationsSynchronized,
    namedLocations.length,
    failedSignInsCount,
    formattedSyncTime,
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
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2.5 py-1 rounded-md">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <span>
                Synced:{' '}
                <strong className="font-semibold text-slate-700 dark:text-slate-300">
                  {formattedSyncTime}
                </strong>
              </span>
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
                      Total users
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
                    {caPoliciesSynchronized
                      ? `${enabledCaPoliciesCount} of ${caPolicies.length} Conditional Access policies enabled`
                      : usersSynchronized
                        ? `MFA coverage at ${mfaCoveragePct}% across ${activeUsersCount} active users`
                        : 'Directory identity security posture'}
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
    </div>
  )
}
