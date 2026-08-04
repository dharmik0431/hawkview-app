import type { AttentionItem } from '@/types/attention'

function isAdminRole(role: unknown) {
  if (typeof role !== 'string') return false
  const r = role.toLowerCase()
  return (
    r.includes('global administrator') ||
    r.includes('privileged role administrator') ||
    r.includes('security administrator') ||
    r.includes('exchange administrator') ||
    r.includes('sharepoint administrator') ||
    // keep generic checks last (broader match)
    r.includes('administrator') ||
    r.includes('admin')
  )
}

function isMfaGood(mfa: unknown): boolean {
  if (mfa === true) return true
  if (mfa === false) return false

  if (typeof mfa === 'string') {
    const v = mfa.toLowerCase()
    return (
      v === 'enabled' ||
      v === 'enforced' ||
      v === 'true' ||
      v === 'yes' ||
      v === 'on'
    )
  }

  if (typeof mfa === 'number') {
    // common: 1 = enabled, 0 = disabled
    return mfa === 1
  }

  if (typeof mfa === 'object' && mfa !== null) {
    // common shapes:
    // { enabled: true }
    // { state: 'enabled' }
    // { mfa: 'Enabled' }
    // { isEnabled: true }
    const anyMfa = mfa as any

    if (typeof anyMfa.enabled === 'boolean') return anyMfa.enabled
    if (typeof anyMfa.isEnabled === 'boolean') return anyMfa.isEnabled

    if (typeof anyMfa.state === 'string') {
      const s = anyMfa.state.toLowerCase()
      return ['enabled', 'enforced', 'true', 'yes', 'on'].includes(s)
    }

    if (typeof anyMfa.mfa === 'string') {
      const s = anyMfa.mfa.toLowerCase()
      return ['enabled', 'enforced', 'true', 'yes', 'on'].includes(s)
    }
  }

  return false
}

function normalizeArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value as any)
  return []
}

function getDetectedAt(bundle: any): string | undefined {
  // best effort across your mocks
  return (
    bundle?.tenant?.lastSync ??
    bundle?.lastSync ??
    bundle?.syncedAt ??
    bundle?.updatedAt ??
    undefined
  )
}

export function computeTenantAttention(bundle: any): AttentionItem[] {
  const items: AttentionItem[] = []
  if (!bundle) return items

  const connectionStatus = String(
    bundle?.connectionStatus ?? bundle?.tenant?.connectionStatus ?? ''
  ).toLowerCase()
  const tenantStatus = String(
    bundle?.status ?? bundle?.tenant?.status ?? ''
  ).toLowerCase()
  const missingPermissions = normalizeArray(
    bundle?.missingPermissions ?? bundle?.tenant?.missingPermissions
  )

  if (
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'
  ) {
    items.push({
      key: 'microsoft_authorization_required',
      label: 'Microsoft authorization required',
      severity: 'high',
      why: 'Open this tenant to review and approve the required Microsoft permissions.',
      detectedAt: getDetectedAt(bundle),
    })
  } else if (missingPermissions.length > 0) {
    items.push({
      key: 'microsoft_permissions_missing',
      label: `Microsoft permissions missing (${missingPermissions.length})`,
      severity: 'high',
      why: 'Open this tenant to review the missing Microsoft permissions.',
      detectedAt: getDetectedAt(bundle),
    })
  }

  if (
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  ) {
    items.push({
      key: 'microsoft_connection_lost',
      label: 'Microsoft connection lost',
      severity: 'critical',
      why: 'HawkView can no longer verify or synchronize this Microsoft tenant.',
      detectedAt: getDetectedAt(bundle),
    })
  }

  // ------------------------
  // Users (array or object map)
  // ------------------------
  const users = normalizeArray(bundle?.users)

  // ---------
  // CRITICAL: Admin without MFA
  // ---------
  const adminWithoutMfa = users.filter((u: any) => {
    // admin role could be in role, roles[], isAdmin, admin flag, etc.
    const roleStr = u?.role
    const rolesArr = normalizeArray(u?.roles)

    const isAdmin =
      u?.isAdmin === true ||
      u?.admin === true ||
      isAdminRole(roleStr) ||
      rolesArr.some((r) => isAdminRole(r))

    return isAdmin && !isMfaGood(u?.mfa ?? u?.mfaState ?? u?.auth?.mfa)
  })

  if (adminWithoutMfa.length > 0) {
    items.push({
      key: 'admin_without_mfa',
      label: `Admin without MFA (${adminWithoutMfa.length})`,
      severity: 'critical',
      why: 'Admins without MFA are the most common breach entry point.',
      detectedAt: getDetectedAt(bundle),
    })
  }

  // ---------
  // MEDIUM: MFA gap (users)
  // ---------
  if (users.length > 0) {
    const mfaGoodCount = users.filter((u: any) =>
      isMfaGood(u?.mfa ?? u?.mfaState ?? u?.auth?.mfa)
    ).length

    const pct = Math.round((mfaGoodCount / users.length) * 100)

    if (pct < 100) {
      items.push({
        key: 'user_mfa_gap',
        label: `MFA gap (users) (${pct}%)`,
        severity: 'medium',
        why: 'Users without MFA increase account takeover risk.',
        detectedAt: getDetectedAt(bundle),
      })
    }
  }

  // ---------
  // HIGH: External sharing enabled (SharePoint)
  // sites might be array OR object map OR missing
  // externalSharingSites might be number OR string
  // ---------
  const sp = bundle?.sharepoint ?? bundle?.oneDrive ?? bundle?.sharePoint
  const sites = normalizeArray(
    sp?.sites ?? sp?.siteCollection ?? sp?.siteCollections
  )

  const externalSitesCount =
    typeof sp?.externalSharingSites === 'number'
      ? sp.externalSharingSites
      : typeof sp?.externalSharingSites === 'string'
        ? Number(sp.externalSharingSites) || 0
        : sites.filter(
            (s: any) => s?.externalSharing === true || s?.sharing === 'external'
          ).length

  if (externalSitesCount > 0) {
    items.push({
      key: 'external_sharing_in_use',
      label: `External sharing enabled (${externalSitesCount})`,
      severity: 'high',
      why: 'External sharing increases risk of unintended data exposure.',
      detectedAt: getDetectedAt(bundle),
    })
  }

  return items
}
