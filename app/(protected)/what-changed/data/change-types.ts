export type ChangeSeverity = 'High' | 'Medium' | 'Low'

export type ChangeCategory =
  | 'Roles'
  | 'MFA'
  | 'Conditional Access'
  | 'Apps'
  | 'Licenses'
  | 'Users'
  | 'Groups'
  | 'Devices'
  | 'Passwords'
  | 'Sign-ins'
  | 'Organization'
  | 'Domains'
  | 'Exchange'
  | 'SharePoint'
  | 'Unknown'

export type ChangeSource =
  | 'Entra'
  | 'Microsoft 365'
  | 'Exchange Online'
  | 'SharePoint and OneDrive'
  | 'Teams'
  | 'Unknown'

const PRODUCT_GUIDANCE_ENTRIES = Object.freeze({
  'organization.identity_changed': Object.freeze({
    label: 'Potential impact',
    category: 'identity',
    guidance: 'Tenant identity information changed. Confirm the change is expected because it can affect administrator recognition and tenant communications.',
  }),
  'domains.configuration_changed': Object.freeze({
    label: 'Potential impact',
    category: 'domain',
    guidance: 'Verified-domain routing or default-domain state changed. Review identity and email-routing implications; this does not prove an external DNS change.',
  }),
  'licenses.subscription_changed': Object.freeze({
    label: 'Potential impact',
    category: 'license',
    guidance: 'Subscription availability, purchased capacity, or service capability changed. Review service access and licensing allocation; this does not establish a billing event or a per-user or group assignment.',
  }),
} as const)

export type ProductImpactId = keyof typeof PRODUCT_GUIDANCE_ENTRIES
type ProductGuidance = Readonly<{
  label: 'Potential impact'
  category: 'identity' | 'domain' | 'license'
  guidance: string
}>
export type ProductGuidanceCategory = ProductGuidance['category']

/**
 * A null-prototype table prevents inherited Object members from ever being
 * treated as product guidance. The entries and table are frozen local
 * constants, not API data.
 */
export const PRODUCT_GUIDANCE: Readonly<Record<ProductImpactId, ProductGuidance>> = Object.freeze(
  Object.assign(Object.create(null), PRODUCT_GUIDANCE_ENTRIES),
)

function isProductImpactId(value: unknown): value is ProductImpactId {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    Object.prototype.hasOwnProperty.call(PRODUCT_GUIDANCE, value)
}

export function productGuidanceForImpactId(impactId: unknown): ProductGuidance | undefined {
  if (!isProductImpactId(impactId)) return undefined
  const guidance = PRODUCT_GUIDANCE[impactId]
  // Return a plain data object so callers never receive a table entry or an
  // inherited value that could be mutated or invoked.
  return {
    label: guidance.label,
    category: guidance.category,
    guidance: guidance.guidance,
  }
}

type SafeDisplayValue = string | string[]
type SafeStateValue = string | number | boolean | null | SafeStateValue[] | { [key: string]: SafeStateValue }
type SafeStateRecord = { [key: string]: SafeStateValue }

export type ChangeEvidence = {
  result?: string
  resultReason?: string
  operationType?: string
  loggedByService?: string
  normalized?: boolean
  changedFields?: string[]
  workload?: string
  source?: ChangeSource
  provenance?: string
  microsoftSource?: string
  actor?: { displayName?: string; principalName?: string; type?: string; objectId?: string; ipAddress?: string; automatedBy?: string }
  application?: { displayName?: string; appId?: string; objectId?: string; servicePrincipalId?: string; publisher?: string; appType?: string; signInAudience?: string; description?: string; homepage?: SafeDisplayValue }
  permissions?: { permissionName?: SafeDisplayValue; permissionType?: string; consentType?: string; scope?: SafeDisplayValue; resourceApi?: string; appRole?: string; assignedTo?: string; grantingAdmin?: string; consentStatus?: string }
  targets?: Array<{ displayName: string; targetType?: string; objectId?: string; upn?: string }>
  potentialImpact?: { kind: 'product_guidance'; impactId: ProductImpactId }
}

export function isAppRelatedEvent(e: ChangeEvent): boolean {
  if (e.eventType === 'sign-in' || e.category === 'Sign-ins') {
    return false
  }
  if (e.category === 'Apps') {
    return true
  }
  const text = `${e.title} ${e.summary} ${e.category} ${e.target ?? ''}`.toLowerCase()
  return /service\s*principal|application|app\s*registration|credential|client\s*secret|certificate|key\s*credential|oauth|permission\s*grant|consent|app\s*role|approle|enterprise\s*app/i.test(text)
}

export type ChangeEvent = {
  id: string
  ts: string // ISO string
  tenantId: string
  tenantName: string
  provider: 'Microsoft' | 'Google'
  category: ChangeCategory
  severity: ChangeSeverity
  title: string
  summary: string
  actor?: string
  target?: string
  source: ChangeSource
  eventType?: 'change' | 'sign-in'
  correlationId?: string
  recoveryGuidance?: string[]
  evidence?: ChangeEvidence

  ip?: string
  location?: { city?: string; region?: string; country?: string }
  client?: { app?: string; device?: string }

  // for a simple diff view
  before?: Record<string, any>
  after?: Record<string, any>
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as UnknownRecord : null
}

function boundedText(value: unknown, fallback = '', maxLength = 2_000) {
  if (typeof value !== 'string') return fallback
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength) || fallback
}

const CATEGORY_ALIASES: Record<string, ChangeCategory> = {
  roles: 'Roles',
  mfa: 'MFA',
  'conditional access': 'Conditional Access',
  apps: 'Apps',
  licenses: 'Licenses',
  users: 'Users',
  groups: 'Groups',
  devices: 'Devices',
  passwords: 'Passwords',
  'sign-ins': 'Sign-ins',
  organization: 'Organization',
  domains: 'Domains',
  exchange: 'Exchange',
  sharepoint: 'SharePoint',
  'sharepoint/onedrive': 'SharePoint',
}

const SOURCE_ALIASES: Record<string, ChangeSource> = {
  entra: 'Entra',
  'microsoft entra': 'Entra',
  'microsoft entra id': 'Entra',
  'azure ad': 'Entra',
  'azure active directory': 'Entra',
  azureactivedirectory: 'Entra',
  azuread: 'Entra',
  m365: 'Microsoft 365',
  'microsoft 365': 'Microsoft 365',
  'microsoft 365 organization': 'Microsoft 365',
  'microsoft 365 licensing': 'Microsoft 365',
  'microsoft 365 domains': 'Microsoft 365',
  'security compliance center': 'Microsoft 365',
  securitycompliancecenter: 'Microsoft 365',
  'security and compliance': 'Microsoft 365',
  'microsoft 365 security': 'Microsoft 365',
  'microsoft 365 compliance': 'Microsoft 365',
  exchange: 'Exchange Online',
  'exchange online': 'Exchange Online',
  'exchange online / purview': 'Exchange Online',
  sharepoint: 'SharePoint and OneDrive',
  'sharepoint online': 'SharePoint and OneDrive',
  'sharepoint and onedrive': 'SharePoint and OneDrive',
  'sharepoint / onedrive': 'SharePoint and OneDrive',
  onedrive: 'SharePoint and OneDrive',
  'sharepoint/onedrive': 'SharePoint and OneDrive',
  teams: 'Teams',
  'microsoft teams': 'Teams',
  microsoftteams: 'Teams',
  'teams and tenant-wide microsoft 365 settings': 'Teams',
  unknown: 'Unknown',
}

/** Every workload/source label emitted by the current backend catalogs and
 * Management Activity records. Add backend values here deliberately rather
 * than treating arbitrary server text as a UI source label. */
export const BACKEND_EMITTED_SOURCE_LABELS: Readonly<Record<string, ChangeSource>> = Object.freeze({
  Entra: 'Entra',
  'Microsoft Entra ID': 'Entra',
  'Azure Active Directory': 'Entra',
  AzureActiveDirectory: 'Entra',
  'Microsoft 365': 'Microsoft 365',
  'Microsoft 365 organization': 'Microsoft 365',
  'Microsoft 365 domains': 'Microsoft 365',
  'Microsoft 365 licensing': 'Microsoft 365',
  'Security Compliance Center': 'Microsoft 365',
  SecurityComplianceCenter: 'Microsoft 365',
  'Security and Compliance': 'Microsoft 365',
  'Microsoft 365 Security': 'Microsoft 365',
  'Microsoft 365 Compliance': 'Microsoft 365',
  Exchange: 'Exchange Online',
  'Exchange Online': 'Exchange Online',
  'Exchange Online / Purview': 'Exchange Online',
  SharePoint: 'SharePoint and OneDrive',
  'SharePoint Online': 'SharePoint and OneDrive',
  'SharePoint and OneDrive': 'SharePoint and OneDrive',
  'SharePoint / OneDrive': 'SharePoint and OneDrive',
  OneDrive: 'SharePoint and OneDrive',
  Teams: 'Teams',
  MicrosoftTeams: 'Teams',
  'Teams and tenant-wide Microsoft 365 settings': 'Teams',
})

export function normalizeChangeCategory(value: unknown): ChangeCategory {
  return CATEGORY_ALIASES[boundedText(value).toLowerCase()] ?? 'Unknown'
}

export function normalizeChangeSource(value: unknown): ChangeSource {
  return SOURCE_ALIASES[boundedText(value).toLowerCase()] ?? 'Unknown'
}

function displayValue(value: unknown, maxItems = 20): SafeDisplayValue | undefined {
  const scalar = boundedText(value, '', 500)
  if (scalar) return scalar
  if (!Array.isArray(value)) return undefined
  const values = value.map((item) => boundedText(item, '', 500)).filter(Boolean).slice(0, maxItems)
  return values.length ? values : undefined
}

function compact<T extends object>(value: T): T | undefined {
  return Object.keys(value).length ? value : undefined
}

function objectOfText(value: unknown, fields: readonly string[]): Record<string, string> | undefined {
  const input = record(value)
  if (!input) return undefined
  const normalized: Record<string, string> = {}
  for (const field of fields) {
    const text = boundedText(input[field], '', 500)
    if (text) normalized[field] = text
  }
  return compact(normalized)
}

function normalizeTargets(value: unknown): ChangeEvidence['targets'] | undefined {
  if (!Array.isArray(value)) return undefined
  const targets = value.slice(0, 100).flatMap((item) => {
    const target = objectOfText(item, ['displayName', 'targetType', 'objectId', 'upn'])
    if (!target?.displayName) return []
    return [{
      displayName: target.displayName,
      ...(target.targetType ? { targetType: target.targetType } : {}),
      ...(target.objectId ? { objectId: target.objectId } : {}),
      ...(target.upn ? { upn: target.upn } : {}),
    }]
  })
  return targets.length ? targets : undefined
}

function normalizeStateValue(value: unknown, depth = 0): SafeStateValue | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return boundedText(value, '', 2_000)
  if (depth >= 5) return undefined
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).flatMap((item) => {
      const normalized = normalizeStateValue(item, depth + 1)
      return normalized === undefined ? [] : [normalized]
    })
    return items
  }
  const input = record(value)
  if (!input) return undefined
  const output: SafeStateRecord = {}
  for (const [key, item] of Object.entries(input).slice(0, 100)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    const normalized = normalizeStateValue(item, depth + 1)
    if (normalized !== undefined) output[boundedText(key, '', 200)] = normalized
  }
  return Object.keys(output).length ? output : undefined
}

function normalizeState(value: unknown): SafeStateRecord | undefined {
  const normalized = normalizeStateValue(value)
  return normalized && !Array.isArray(normalized) && typeof normalized === 'object' ? normalized : undefined
}

function normalizePotentialImpact(value: unknown): ChangeEvidence['potentialImpact'] | undefined {
  const input = record(value)
  if (input?.kind !== 'product_guidance') return undefined
  if (!isProductImpactId(input.impactId)) return undefined
  return { kind: 'product_guidance', impactId: input.impactId }
}

export function normalizeEvidence(value: unknown): ChangeEvidence | undefined {
  const input = record(value)
  if (!input) return undefined
  const actor = objectOfText(input.actor, ['displayName', 'principalName', 'type', 'objectId', 'ipAddress', 'automatedBy'])
  const application = objectOfText(input.application, ['displayName', 'appId', 'objectId', 'servicePrincipalId', 'publisher', 'appType', 'signInAudience', 'description'])
  const applicationHomepage = displayValue(record(input.application)?.homepage)
  const permissions = objectOfText(input.permissions, ['permissionType', 'consentType', 'resourceApi', 'appRole', 'assignedTo', 'grantingAdmin', 'consentStatus'])
  const permissionName = displayValue(record(input.permissions)?.permissionName)
  const scope = displayValue(record(input.permissions)?.scope)
  const potentialImpact = normalizePotentialImpact(input.potentialImpact)
  const evidence: ChangeEvidence = {
    ...(input.normalized === true ? { normalized: true } : {}),
    ...(Array.isArray(input.changedFields) ? { changedFields: input.changedFields.map((field) => boundedText(field, '', 200)).filter(Boolean).slice(0, 100) } : {}),
    ...(boundedText(input.workload, '', 300) ? { workload: boundedText(input.workload, '', 300) } : {}),
    ...(boundedText(input.source, '', 300) ? { source: normalizeChangeSource(input.source) } : {}),
    ...(boundedText(input.provenance, '', 500) ? { provenance: boundedText(input.provenance, '', 500) } : {}),
    ...(boundedText(input.microsoftSource, '', 500) ? { microsoftSource: boundedText(input.microsoftSource, '', 500) } : {}),
    ...(boundedText(input.result, '', 300) ? { result: boundedText(input.result, '', 300) } : {}),
    ...(boundedText(input.resultReason, '', 1_000) ? { resultReason: boundedText(input.resultReason, '', 1_000) } : {}),
    ...(boundedText(input.operationType, '', 300) ? { operationType: boundedText(input.operationType, '', 300) } : {}),
    ...(boundedText(input.loggedByService, '', 300) ? { loggedByService: boundedText(input.loggedByService, '', 300) } : {}),
    ...(actor ? { actor } : {}),
    ...(application ? { application: { ...application, ...(applicationHomepage ? { homepage: applicationHomepage } : {}) } } : {}),
    ...(permissions ? { permissions: { ...permissions, ...(permissionName ? { permissionName } : {}), ...(scope ? { scope } : {}) } } : {}),
    ...(normalizeTargets(input.targets) ? { targets: normalizeTargets(input.targets) } : {}),
    ...(potentialImpact ? { potentialImpact } : {}),
  }
  return Object.keys(evidence).length ? evidence : undefined
}

/**
 * Treat the What Changed HTTP response as untrusted at the browser boundary.
 * Values that drive filters, icons, and source labels use closed mappings;
 * unfamiliar values remain visible only through a truthful Unknown fallback.
 */
export function normalizeChangeEvent(value: unknown): ChangeEvent | null {
  const input = record(value)
  if (!input) return null
  const id = boundedText(input.id, '', 300)
  const ts = boundedText(input.ts, '', 100)
  const tenantId = boundedText(input.tenantId, '', 300)
  if (!id || !ts || !tenantId) return null
  const severity = input.severity === 'High' || input.severity === 'Medium' || input.severity === 'Low'
    ? input.severity
    : 'Low'
  const provider = input.provider === 'Google' ? 'Google' : 'Microsoft'
  const before = normalizeState(input.before)
  const after = normalizeState(input.after)
  return {
    id,
    ts,
    tenantId,
    tenantName: boundedText(input.tenantName, tenantId, 300),
    provider,
    category: normalizeChangeCategory(input.category),
    severity,
    title: boundedText(input.title, 'Microsoft administrative change', 500),
    summary: boundedText(input.summary, 'No summary was provided by Microsoft.', 2_000),
    actor: boundedText(input.actor, '', 500) || undefined,
    target: boundedText(input.target, '', 500) || undefined,
    source: normalizeChangeSource(input.source),
    eventType: input.eventType === 'sign-in' ? 'sign-in' : 'change',
    correlationId: boundedText(input.correlationId, '', 500) || undefined,
    before,
    after,
    evidence: normalizeEvidence(input.evidence),
    recoveryGuidance: Array.isArray(input.recoveryGuidance)
      ? input.recoveryGuidance.map((step) => boundedText(step, '', 500)).filter(Boolean).slice(0, 20)
      : undefined,
    ip: boundedText(input.ip, '', 100) || undefined,
    location: compact({
      ...(boundedText(record(input.location)?.city, '', 200) ? { city: boundedText(record(input.location)?.city, '', 200) } : {}),
      ...(boundedText(record(input.location)?.region, '', 200) ? { region: boundedText(record(input.location)?.region, '', 200) } : {}),
      ...(boundedText(record(input.location)?.country, '', 200) ? { country: boundedText(record(input.location)?.country, '', 200) } : {}),
    }),
    client: compact({
      ...(boundedText(record(input.client)?.app, '', 300) ? { app: boundedText(record(input.client)?.app, '', 300) } : {}),
      ...(boundedText(record(input.client)?.device, '', 300) ? { device: boundedText(record(input.client)?.device, '', 300) } : {}),
    }),
  }
}

export function normalizeChangesResponse(value: unknown): {
  changes: ChangeEvent[]
  tenants: { id: string; name: string }[]
  summary?: { total: number; changes: number; signIns: number; highRisk: number; apps: number }
} {
  const input = record(value)
  const changes = Array.isArray(input?.changes)
    ? input.changes.map(normalizeChangeEvent).filter((event): event is ChangeEvent => event !== null)
    : []
  const tenants = Array.isArray(input?.tenants)
    ? input.tenants.map(record).flatMap((tenant) => {
      const id = boundedText(tenant?.id, '', 300)
      if (!id) return []
      return [{ id, name: boundedText(tenant?.name, id, 300) }]
    })
    : []
  const summaryRecord = record(input?.summary)
  const summary = summaryRecord && ['total', 'changes', 'signIns', 'highRisk', 'apps'].every((key) => typeof summaryRecord[key] === 'number')
    ? {
      total: summaryRecord.total as number,
      changes: summaryRecord.changes as number,
      signIns: summaryRecord.signIns as number,
      highRisk: summaryRecord.highRisk as number,
      apps: summaryRecord.apps as number,
    }
    : undefined
  return { changes, tenants, summary }
}
