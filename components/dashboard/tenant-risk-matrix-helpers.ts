'use client'

import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Info,
  LucideIcon,
} from 'lucide-react'
import type { Tenant } from '@/types/api'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'

export type MatrixOverallStateKey =
  | 'critical'
  | 'disconnected'
  | 'needs_attention'
  | 'partially_synchronized'
  | 'stale'
  | 'syncing'
  | 'pending_setup'
  | 'healthy'

export interface MatrixOverallStateInfo {
  key: MatrixOverallStateKey
  label: string
  badgeClass: string
  icon: LucideIcon
  rank: number
}

export function getTenantMatrixOverallState(
  tenant: Tenant
): MatrixOverallStateInfo {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const missingPerms = tenant.missingPermissions || []

  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)

  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  const hasCriticalAttention = attentionItems.some(
    (item) => item.severity === 'critical'
  )

  // 1. Critical
  if (hasCriticalAttention) {
    return {
      key: 'critical',
      label: 'Critical',
      badgeClass:
        'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900/60',
      icon: ShieldAlert,
      rank: 1,
    }
  }

  // 2. Disconnected
  if (isDisconnected) {
    return {
      key: 'disconnected',
      label: 'Disconnected',
      badgeClass:
        'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900/60',
      icon: XCircle,
      rank: 2,
    }
  }

  // 3. Needs Attention
  if (
    attentionItems.length > 0 ||
    missingPerms.length > 0 ||
    (tenant.mfaCoverage !== null && tenant.mfaCoverage !== undefined && tenant.mfaCoverage < 85)
  ) {
    return {
      key: 'needs_attention',
      label: 'Needs Attention',
      badgeClass:
        'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/60',
      icon: AlertTriangle,
      rank: 3,
    }
  }

  // 4. Stale / Awaiting Sync
  if (!tenant.lastSync) {
    return {
      key: 'stale',
      label: 'Awaiting Sync',
      badgeClass:
        'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-900/60',
      icon: RefreshCw,
      rank: 4,
    }
  }

  const syncTime = new Date(tenant.lastSync).getTime()
  const hoursOld = (Date.now() - syncTime) / (1000 * 60 * 60)
  if (hoursOld > 24) {
    return {
      key: 'stale',
      label: 'Stale Data',
      badgeClass:
        'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60',
      icon: Clock,
      rank: 4,
    }
  }

  // 5. Pending Setup
  if (isPending) {
    return {
      key: 'pending_setup',
      label: 'Pending Setup',
      badgeClass:
        'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
      icon: Clock,
      rank: 5,
    }
  }

  // 6. Healthy
  return {
    key: 'healthy',
    label: 'Healthy',
    badgeClass:
      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900/60',
    icon: CheckCircle2,
    rank: 6,
  }
}

export function getTenantActiveIssuesInfo(tenant: Tenant) {
  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const missingPerms = tenant.missingPermissions || []
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(
      String(tenant.connectionStatus || '').toLowerCase()
    ) ||
    ['suspended', 'disconnected'].includes(
      String(tenant.status || '').toLowerCase()
    )

  if (isDisconnected) {
    return {
      count: attentionItems.length || 1,
      highestSeverity: 'critical' as const,
      summaryText: 'Microsoft connection lost',
    }
  }

  const totalCount = attentionItems.length
  if (totalCount === 0) {
    return {
      count: 0,
      highestSeverity: 'none' as const,
      summaryText: 'No active issues',
    }
  }

  const hasCritical = attentionItems.some((i) => i.severity === 'critical')
  const hasHigh = attentionItems.some((i) => i.severity === 'high')
  const highestSeverity = hasCritical
    ? ('critical' as const)
    : hasHigh
    ? ('high' as const)
    : ('medium' as const)

  let summaryParts: string[] = []
  if (missingPerms.length > 0) {
    summaryParts.push('Missing permissions')
  }
  if (
    tenant.mfaCoverage !== null &&
    tenant.mfaCoverage !== undefined &&
    tenant.mfaCoverage < 85
  ) {
    summaryParts.push(`MFA registration: ${tenant.mfaCoverage}% covered`)
  }
  if (tenant.riskyIdentityCount > 0) {
    summaryParts.push(`${tenant.riskyIdentityCount} risky identities`)
  }

  if (summaryParts.length === 0 && attentionItems.length > 0) {
    summaryParts.push(attentionItems[0].label)
  }

  const summaryText =
    totalCount === 1
      ? `1 issue · ${summaryParts[0] || 'Attention required'}`
      : `${totalCount} issues · ${summaryParts.slice(0, 2).join(' & ')}`

  return {
    count: totalCount,
    highestSeverity,
    summaryText,
  }
}

export function getTenantIdentityInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(String(tenant.status || '').toLowerCase())

  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenant.status === 'pending'

  // MFA
  let mfaText = 'MFA registration: Unavailable'
  let mfaValue = tenant.mfaCoverage
  let mfaStatus: 'good' | 'warning' | 'critical' | 'unavailable' = 'unavailable'

  if (tenant.mfaCoverage !== null && tenant.mfaCoverage !== undefined) {
    mfaValue = tenant.mfaCoverage
    mfaText = `MFA registration: ${mfaValue}% covered`
    if (mfaValue >= 85) mfaStatus = 'good'
    else if (mfaValue >= 50) mfaStatus = 'warning'
    else mfaStatus = 'critical'
  } else if (isPending) {
    mfaText = 'MFA registration: Awaiting sync'
  } else if (isDisconnected) {
    mfaText = 'MFA registration: Connection lost'
  }

  // Risky Identities
  let riskyText = 'Risk data unavailable'
  let riskyCount: number | null = tenant.riskyIdentityCount

  if (isDisconnected) {
    riskyText = 'Risk data unavailable'
  } else if (isPending) {
    riskyText = 'Awaiting synchronization'
  } else if (tenant.missingPermissions && tenant.missingPermissions.some(p => p.toLowerCase().includes('identityrisk') || p.toLowerCase().includes('audit'))) {
    riskyText = 'Permission required'
  } else if (tenant.riskyIdentityCount > 0) {
    riskyText = `${tenant.riskyIdentityCount} risky ${
      tenant.riskyIdentityCount === 1 ? 'identity' : 'identities'
    }`
  } else {
    riskyText = 'No risky identities detected'
  }

  return {
    mfaText,
    mfaValue,
    mfaStatus,
    riskyText,
    riskyCount,
  }
}

export function getTenantConnectionDataInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const missingPerms = tenant.missingPermissions || []

  let connectionText = 'Microsoft: Connected'
  let connectionState: 'connected' | 'disconnected' | 'pending' = 'connected'

  if (['error', 'revoked', 'disconnected'].includes(connectionStatus)) {
    connectionText = 'Microsoft: Disconnected'
    connectionState = 'disconnected'
  } else if (['pending-consent', 'pending'].includes(connectionStatus)) {
    connectionText = 'Microsoft: Pending Consent'
    connectionState = 'pending'
  }

  let dataText = 'Data: Current'
  let dataStatus: 'current' | 'partial' | 'stale' | 'failed' | 'awaiting_sync' = 'current'

  if (connectionState === 'disconnected') {
    dataText = 'Data: Failed'
    dataStatus = 'failed'
  } else if (connectionState === 'pending') {
    dataText = 'Data: Awaiting Sync'
    dataStatus = 'awaiting_sync'
  } else if (missingPerms.length > 0) {
    dataText = 'Data: Partial · Permission required'
    dataStatus = 'partial'
  } else if (!tenant.lastSync) {
    dataText = 'Data: Awaiting Sync'
    dataStatus = 'awaiting_sync'
  } else {
    const hoursOld =
      (Date.now() - new Date(tenant.lastSync).getTime()) / (1000 * 60 * 60)
    if (hoursOld > 24) {
      dataText = 'Data: Stale'
      dataStatus = 'stale'
    }
  }

  return {
    connectionText,
    connectionState,
    dataText,
    dataStatus,
  }
}

export function getTenantSyncTimeInfo(lastSync: string | null) {
  if (!lastSync) {
    return {
      display: 'Never synchronized',
      fullTimestamp: 'No successful synchronization recorded',
      isStale: true,
    }
  }

  try {
    const d = new Date(lastSync)
    const timeMs = d.getTime()
    if (isNaN(timeMs)) {
      return {
        display: lastSync,
        fullTimestamp: lastSync,
        isStale: false,
      }
    }

    const fullTimestamp = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(d)

    const diffMins = Math.max(0, Math.round((Date.now() - timeMs) / 60000))
    let display = '<1m ago'
    if (diffMins >= 1 && diffMins < 60) {
      display = `${diffMins}m ago`
    } else if (diffMins >= 60) {
      const hrs = Math.round(diffMins / 60)
      if (hrs < 24) {
        display = `${hrs}h ago`
      } else {
        const days = Math.round(hrs / 24)
        display = `${days}d ago`
      }
    }

    const isStale = diffMins > 24 * 60

    return {
      display,
      fullTimestamp,
      isStale,
    }
  } catch {
    return {
      display: lastSync,
      fullTimestamp: lastSync,
      isStale: false,
    }
  }
}

export function getTenantRecommendedAction(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const isDisconnected = ['error', 'revoked', 'disconnected'].includes(connectionStatus)
  const isPending = ['pending-consent', 'pending'].includes(connectionStatus)
  const missingPerms = tenant.missingPermissions || []

  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  if (isDisconnected) {
    return {
      label: 'Reconnect Microsoft 365',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}/settings`,
      description: 'Re-authenticate the Microsoft 365 connector to restore synchronization.',
    }
  }

  if (isPending) {
    return {
      label: 'Review permissions',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}/settings`,
      description: 'Grant administrator consent to finalize tenant setup.',
    }
  }

  if (tenant.riskyIdentityCount > 0) {
    return {
      label: 'Review risky users',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`,
      description: `${tenant.riskyIdentityCount} risky user account${tenant.riskyIdentityCount === 1 ? '' : 's'} detected in directory.`,
    }
  }

  if (attentionItems.length > 0) {
    return {
      label: 'Review threats',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`,
      description: `${attentionItems.length} active security threat${attentionItems.length === 1 ? '' : 's'} require remediation.`,
    }
  }

  if (tenant.secureScore !== null && tenant.secureScore !== undefined && tenant.secureScore < 70) {
    return {
      label: 'Improve Secure Score',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`,
      description: `Microsoft Secure Score is at ${tenant.secureScore}%, below 70% benchmark.`,
    }
  }

  if (missingPerms.length > 0 || (tenant.mfaCoverage !== null && tenant.mfaCoverage < 85)) {
    return {
      label: 'Review security posture',
      destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`,
      description: 'Address permission gaps or sub-baseline MFA registration coverage.',
    }
  }

  return {
    label: 'View tenant',
    destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`,
    description: 'Inspect tenant security posture and directory configurations.',
  }
}

export function getTenantSecureScoreInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  if (tenant.secureScore !== null && tenant.secureScore !== undefined) {
    const syncInfo = getTenantSyncTimeInfo(tenant.lastSync)
    return {
      score: tenant.secureScore,
      isAvailable: true,
      stateLabel: `${tenant.secureScore}%`,
      pointsText: 'Points breakdown not supplied',
      dateText: tenant.lastSync ? `Sync: ${syncInfo.display}` : 'Sync pending',
      statusType: 'available' as const,
    }
  }

  if (isDisconnected) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Disconnected',
      pointsText: 'Connection lost',
      dateText: '—',
      statusType: 'disconnected' as const,
    }
  }

  if (isPending) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Awaiting synchronization',
      pointsText: 'Initial sync pending',
      dateText: '—',
      statusType: 'awaiting_sync' as const,
    }
  }

  const missingPerms = tenant.missingPermissions || []
  if (missingPerms.some((p) => p.toLowerCase().includes('security') || p.toLowerCase().includes('score'))) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Permission required',
      pointsText: 'SecurityEvents.Read.All missing',
      dateText: '—',
      statusType: 'permission_required' as const,
    }
  }

  return {
    score: null,
    isAvailable: false,
    stateLabel: 'Not available',
    pointsText: 'License or API unavailable',
    dateText: '—',
    statusType: 'unavailable' as const,
  }
}

export function getTenantRiskyUsersInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  if (isDisconnected) {
    return {
      count: null,
      label: 'Disconnected',
      statusType: 'disconnected' as const,
      breakdownNote: 'Connection lost',
    }
  }

  if (isPending) {
    return {
      count: null,
      label: 'Awaiting synchronization',
      statusType: 'awaiting_sync' as const,
      breakdownNote: 'Sync pending',
    }
  }

  const missingPerms = tenant.missingPermissions || []
  if (missingPerms.some((p) => p.toLowerCase().includes('identityrisk') || p.toLowerCase().includes('audit'))) {
    return {
      count: null,
      label: 'Permission required',
      statusType: 'permission_required' as const,
      breakdownNote: 'Azure AD P2 required',
    }
  }

  const count = tenant.riskyIdentityCount ?? 0
  return {
    count,
    label: count === 0 ? '0 users at risk' : `${count} user${count === 1 ? '' : 's'} at risk`,
    statusType: 'available' as const,
    breakdownNote: count > 0 ? 'Level breakdown unavailable' : 'No risky users',
  }
}

export function getTenantThreatsInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  if (isDisconnected) {
    return {
      count: null,
      isConfirmedZero: false,
      label: 'Disconnected',
      statusType: 'disconnected' as const,
      resolvedCount: null,
    }
  }

  if (isPending) {
    return {
      count: null,
      isConfirmedZero: false,
      label: 'Awaiting synchronization',
      statusType: 'awaiting_sync' as const,
      resolvedCount: null,
    }
  }

  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const count = attentionItems.length
  return {
    count,
    isConfirmedZero: count === 0,
    label: count === 0 ? 'No active threats' : `${count} active threat${count === 1 ? '' : 's'}`,
    statusType: 'available' as const,
    resolvedCount: null,
  }
}

export function getPrimaryConcern(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()

  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)

  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  if (isDisconnected) {
    return {
      title: 'Connection Lost',
      detail: 'Microsoft 365 connector is disconnected. Re-authentication is required.',
      severity: 'critical' as const,
      icon: XCircle,
    }
  }

  if (isPending) {
    return {
      title: 'Pending Consent',
      detail: 'Tenant connector requires administrator consent to establish monitoring.',
      severity: 'warning' as const,
      icon: Clock,
    }
  }

  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const criticalItem = attentionItems.find((i) => i.severity === 'critical')
  if (criticalItem) {
    return {
      title: criticalItem.label,
      detail: criticalItem.why || 'Critical security finding requiring immediate remediation.',
      severity: 'critical' as const,
      icon: ShieldAlert,
    }
  }

  const missingPerms = tenant.missingPermissions || []
  if (missingPerms.length > 0) {
    return {
      title: 'Missing API Permissions',
      detail: `Missing permissions (${missingPerms.slice(0, 2).join(', ')}${missingPerms.length > 2 ? '...' : ''}) prevent full monitoring.`,
      severity: 'warning' as const,
      icon: AlertTriangle,
    }
  }

  if (
    tenant.mfaCoverage !== null &&
    tenant.mfaCoverage !== undefined &&
    tenant.mfaCoverage < 85
  ) {
    return {
      title: 'Low MFA Registration Coverage',
      detail: `Directory MFA registration coverage is at ${tenant.mfaCoverage}%, below 85% baseline. This does not establish MFA enforcement.`,
      severity: 'warning' as const,
      icon: AlertTriangle,
    }
  }

  const highItem = attentionItems.find((i) => i.severity === 'high')
  if (highItem) {
    return {
      title: highItem.label,
      detail: highItem.why || 'High severity alert flagged for review.',
      severity: 'warning' as const,
      icon: AlertTriangle,
    }
  }

  const syncTime = tenant.lastSync ? new Date(tenant.lastSync).getTime() : 0
  const isStale = !tenant.lastSync || Date.now() - syncTime > 24 * 60 * 60 * 1000
  if (isStale) {
    return {
      title: 'Stale Synchronization',
      detail: tenant.lastSync ? 'Last successful sync was over 24 hours ago.' : 'Tenant has not completed initial synchronization.',
      severity: 'warning' as const,
      icon: RefreshCw,
    }
  }

  const mediumItem = attentionItems[0]
  if (mediumItem) {
    return {
      title: mediumItem.label,
      detail: mediumItem.why || 'Active security issue recorded.',
      severity: 'info' as const,
      icon: Info,
    }
  }

  return {
    title: 'Posture Healthy',
    detail: 'All baseline security, MFA, and connection checks are passing.',
    severity: 'success' as const,
    icon: CheckCircle2,
  }
}
