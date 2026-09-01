import type { AttentionItem } from '@/types/attention'

const ATTENTION_SEVERITIES = new Set(['critical', 'high', 'medium'])
const TENANT_HEALTH_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

function own(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function safeAttentionText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    return null
  }
  return text
}

/**
 * Tenant-list responses already contain the backend-owned health findings.
 * Their presence (including an empty array) is authoritative: recomputing
 * health from connection state alone is what previously let the directory say
 * Healthy while the tenant workspace showed failed collectors.
 */
export type TenantActionableHealthProjection = {
  status: 'VERIFIED' | 'UNAVAILABLE'
  items: AttentionItem[]
}

function authoritativeAttention(value: unknown): AttentionItem[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const nestedHealth = own(record, 'tenantHealth') && record.tenantHealth &&
    typeof record.tenantHealth === 'object' && !Array.isArray(record.tenantHealth)
      ? record.tenantHealth as Record<string, unknown>
      : null
  const nestedTenant = own(record, 'tenant') && record.tenant &&
    typeof record.tenant === 'object' && !Array.isArray(record.tenant)
      ? record.tenant as Record<string, unknown>
      : null
  const source = own(record, 'attention')
    ? record.attention
    : nestedHealth && own(nestedHealth, 'attention')
      ? nestedHealth.attention
      : nestedTenant && own(nestedTenant, 'attention')
        ? nestedTenant.attention
        : undefined

  if (!Array.isArray(source)) return null
  if (source.length > 100) return null

  const items: AttentionItem[] = []
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const key = safeAttentionText(row.key, 160)
    const label = safeAttentionText(row.label, 240)
    const why = safeAttentionText(row.why, 1000)
    const severity = row.severity
    if (!key || !label || !why || typeof severity !== 'string' || !TENANT_HEALTH_SEVERITIES.has(severity)) {
      return null
    }
    // Low severity findings are verified informational coverage, not tenant
    // actions. Accept the row without inflating actionable counts.
    if (!ATTENTION_SEVERITIES.has(severity)) continue
    const detectedAt = safeAttentionText(row.detectedAt, 80) ?? undefined
    items.push({
      key,
      label,
      why,
      severity: severity as AttentionItem['severity'],
      ...(detectedAt ? { detectedAt } : {}),
    })
  }
  return items
}

/**
 * The tenant-list health response is the authority for tenant-wide actionable
 * health. Keep an authoritative empty result distinct from a missing contract
 * so detail surfaces cannot turn an unavailable result into Healthy / 0.
 */
export function tenantActionableHealthProjection(
  value: unknown,
): TenantActionableHealthProjection {
  const items = authoritativeAttention(value)
  return items === null
    ? { status: 'UNAVAILABLE', items: [] }
    : { status: 'VERIFIED', items }
}

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

function mfaRegistrationFact(user: any): boolean | null {
  const explicit = user?.mfaRegistration
  if (explicit === 'Registered') return true
  if (explicit === 'Not registered') return false
  if (explicit === 'Unknown') return null

  const mfa = user?.mfa ?? user?.mfaState ?? user?.auth?.mfa
  if (mfa === true) return true
  if (mfa === false) return false

  if (typeof mfa === 'string') {
    const v = mfa.toLowerCase()
    if (
      v === 'enabled' ||
      v === 'enforced' ||
      v === 'true' ||
      v === 'yes' ||
      v === 'on'
    ) return true
    if (v === 'disabled' || v === 'false' || v === 'no' || v === 'off') {
      return false
    }
    return null
  }

  if (typeof mfa === 'number') {
    // common: 1 = enabled, 0 = disabled
    return mfa === 1 ? true : mfa === 0 ? false : null
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
      if (['enabled', 'enforced', 'true', 'yes', 'on'].includes(s)) return true
      if (['disabled', 'false', 'no', 'off'].includes(s)) return false
    }

    if (typeof anyMfa.mfa === 'string') {
      const s = anyMfa.mfa.toLowerCase()
      if (['enabled', 'enforced', 'true', 'yes', 'on'].includes(s)) return true
      if (['disabled', 'false', 'no', 'off'].includes(s)) return false
    }
  }

  return null
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

  const backendFindings = tenantActionableHealthProjection(bundle)
  if (backendFindings.status === 'VERIFIED') return backendFindings.items

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
  // CRITICAL: Admin without a registered MFA method. This is registration
  // evidence only; it does not claim whether MFA is required by policy.
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

    return isAdmin && mfaRegistrationFact(u) === false
  })

  if (adminWithoutMfa.length > 0) {
    items.push({
      key: 'admin_without_mfa',
      label: `Admin without a registered MFA method (${adminWithoutMfa.length})`,
      severity: 'critical',
      why: 'Microsoft reports no registered MFA method for these administrators. This does not establish whether a policy requires MFA.',
      detectedAt: getDetectedAt(bundle),
    })
  }

  // ---------
  // MEDIUM: MFA registration gap (users)
  // ---------
  if (users.length > 0) {
    const knownRegistrations = users
      .map((user: any) => mfaRegistrationFact(user))
      .filter((value): value is boolean => value !== null)
    const mfaGoodCount = knownRegistrations.filter(Boolean).length
    const pct = knownRegistrations.length > 0
      ? Math.round((mfaGoodCount / knownRegistrations.length) * 100)
      : null

    if (pct !== null && pct < 100) {
      items.push({
        key: 'user_mfa_gap',
        label: `MFA registration gap (users) (${pct}%)`,
        severity: 'medium',
        why: 'Microsoft reports that some synchronized users do not have an MFA method registered. Registration does not prove MFA enforcement.',
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
