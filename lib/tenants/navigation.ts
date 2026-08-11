export type TenantRouteSection =
  | 'overview'
  | 'home'
  | 'entra'
  | 'exchange'
  | 'teams'
  | 'sharepoint'
  | 'settings'

export type TenantRouteEntraTab =
  | 'overview'
  | 'users'
  | 'groups'
  | 'app-registrations'
  | 'enterprise-apps'
  | 'security'
  | 'licenses'

export type TenantRouteSecurityView =
  | 'policies'
  | 'sign-ins'
  | 'auth'
  | 'locations'

export type TenantRouteState = {
  section: TenantRouteSection
  officeTab: 'licenses' | 'domain-protection'
  entraTab: TenantRouteEntraTab
  securityView: TenantRouteSecurityView
  canonicalPath: string
}

const tenantRoot = (tenantId: string) =>
  `/tenants/${encodeURIComponent(tenantId)}`

export const tenantOverviewPath = (tenantId: string) =>
  `${tenantRoot(tenantId)}/overview`

export function tenantSectionPath(
  tenantId: string,
  section: TenantRouteSection
) {
  const root = tenantRoot(tenantId)
  switch (section) {
    case 'home':
      return `${root}/office-365/licenses`
    case 'entra':
      return `${root}/entra/overview`
    case 'exchange':
      return `${root}/exchange`
    case 'sharepoint':
      return `${root}/sharepoint`
    case 'teams':
      return `${root}/teams`
    case 'settings':
      return `${root}/settings`
    default:
      return `${root}/overview`
  }
}

export function tenantOfficePath(
  tenantId: string,
  tab: 'licenses' | 'domain-protection'
) {
  return `${tenantRoot(tenantId)}/office-365/${tab}`
}

const entraSegment: Record<TenantRouteEntraTab, string> = {
  overview: 'overview',
  users: 'users',
  groups: 'groups',
  'app-registrations': 'app-registrations',
  'enterprise-apps': 'enterprise-applications',
  security: 'security',
  licenses: 'license-activity',
}

const securitySegment: Record<TenantRouteSecurityView, string> = {
  policies: 'policies',
  'sign-ins': 'sign-ins',
  auth: 'authentication',
  locations: 'named-locations',
}

export function tenantEntraPath(
  tenantId: string,
  tab: TenantRouteEntraTab,
  securityView: TenantRouteSecurityView = 'policies'
) {
  const root = `${tenantRoot(tenantId)}/entra`
  if (tab === 'security') {
    return `${root}/security/${securitySegment[securityView]}`
  }
  return `${root}/${entraSegment[tab]}`
}

export function parseTenantPath(
  pathname: string,
  tenantId: string
): TenantRouteState {
  const root = tenantRoot(tenantId)
  const relative = pathname.startsWith(root)
    ? pathname.slice(root.length).replace(/^\/+|\/+$/g, '')
    : ''
  const parts = relative ? relative.split('/') : []

  if (parts[0] === 'office-365') {
    const officeTab =
      parts[1] === 'domain-protection' ? 'domain-protection' : 'licenses'
    return {
      section: 'home',
      officeTab,
      entraTab: 'overview',
      securityView: 'policies',
      canonicalPath: tenantOfficePath(tenantId, officeTab),
    }
  }

  if (parts[0] === 'entra') {
    const tabBySegment: Record<string, TenantRouteEntraTab> = {
      overview: 'overview',
      users: 'users',
      groups: 'groups',
      'app-registrations': 'app-registrations',
      'enterprise-applications': 'enterprise-apps',
      security: 'security',
      'license-activity': 'licenses',
    }
    const securityBySegment: Record<string, TenantRouteSecurityView> = {
      policies: 'policies',
      'sign-ins': 'sign-ins',
      authentication: 'auth',
      'named-locations': 'locations',
    }
    const entraTab = tabBySegment[parts[1]] || 'overview'
    const securityView =
      entraTab === 'security'
        ? securityBySegment[parts[2]] || 'policies'
        : 'policies'
    return {
      section: 'entra',
      officeTab: 'licenses',
      entraTab,
      securityView,
      canonicalPath: tenantEntraPath(tenantId, entraTab, securityView),
    }
  }

  const simpleSections: Record<string, TenantRouteSection> = {
    overview: 'overview',
    exchange: 'exchange',
    sharepoint: 'sharepoint',
    teams: 'teams',
    settings: 'settings',
  }
  const section = simpleSections[parts[0]] || 'overview'
  return {
    section,
    officeTab: 'licenses',
    entraTab: 'overview',
    securityView: 'policies',
    canonicalPath: tenantSectionPath(tenantId, section),
  }
}
