import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { redactSensitiveValues } from './change-evidence.service.js'
import {
  classifyEvidence,
  PRIMARY_CHANGE_CLASSIFICATIONS,
  type ChangeClassification,
} from './change-classification.js'
import {
  managementActivityRoleFromEvidence,
} from './m365-activity-classification.js'
import { classifyEvidenceTrust, classifyLegacyDirectoryProjection } from './evidence-trust-catalog.js'
import { productGuidanceForSnapshot } from './microsoft-admin-change-catalog.js'

type JsonObject = Record<string, unknown>
type TimelineEvent = {
  id: string
  eventType: 'change'
  classification: ChangeClassification
  ts: string
  tenantId: string
  tenantName: string
  provider: 'Microsoft'
  category: string
  severity: string
  title: string
  summary: string
  actor?: string
  target?: string
  ip?: string
  [key: string]: unknown
}

type TimelineEvidenceIdentity = {
  customerTenantId: string
  source: string
  sourceEventId: string
}

function timelineEvidenceIdentity(event: TimelineEvent): TimelineEvidenceIdentity | null {
  if (event.id.startsWith('audit:')) {
    return {
      customerTenantId: event.tenantId,
      source: 'DIRECTORY_AUDIT',
      sourceEventId: event.id.slice('audit:'.length),
    }
  }
  if (!event.id.startsWith('evidence:')) return null
  const sourceAndId = event.id.slice('evidence:'.length)
  const separator = sourceAndId.indexOf(':')
  if (separator <= 0) return null
  return {
    customerTenantId: event.tenantId,
    source: sourceAndId.slice(0, separator),
    sourceEventId: sourceAndId.slice(separator + 1),
  }
}

function timelineEvidenceKey(identity: TimelineEvidenceIdentity) {
  return [identity.customerTenantId, identity.source, identity.sourceEventId].join('\u0000')
}
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined

type EvidenceSourcePresentation = {
  source: string
  provenance: string
  microsoftSource?: string
}

const SANITIZED_MICROSOFT_SOURCES: Record<string, string> = {
  'Microsoft Graph /users/{id}/mailFolders/inbox/messageRules': 'Microsoft Graph mailbox rules',
  'Microsoft Graph directoryAudit': 'Microsoft Graph directory audit',
  'Office 365 Management Activity API': 'Office 365 Management Activity API',
}

/**
 * Stored evidence is immutable source material. This maps only the API DTO to
 * a stable, friendly and non-sensitive display source for both list and detail
 * responses.
 */
function sourcePresentation(event: { source: string; workload?: string | null; raw?: unknown }): EvidenceSourcePresentation {
  if (event.source === 'DIRECTORY_AUDIT') {
    return { source: 'Entra', provenance: 'Microsoft Graph directoryAudit', microsoftSource: 'Microsoft Graph directory audit' }
  }
  if (event.source === 'M365_UNIFIED_AUDIT') {
    return { source: text(event.workload) ?? 'Microsoft 365', provenance: 'Microsoft 365 Unified Audit', microsoftSource: 'Office 365 Management Activity API' }
  }
  if (event.source === 'SNAPSHOT_DIFFERENCE') {
    const raw = object(event.raw)
    const microsoftSource = SANITIZED_MICROSOFT_SOURCES[text(raw.microsoftSource) ?? '']
    return {
      source: text(event.workload) ?? 'Microsoft 365',
      provenance: 'HawkView snapshot comparison',
      ...(microsoftSource ? { microsoftSource } : {}),
    }
  }
  return { source: text(event.workload) ?? 'Microsoft 365', provenance: 'Microsoft evidence' }
}

function potentialImpactFor(event: {
  source: string
  targetType?: string | null
  workload?: string | null
  category?: string | null
  operationName?: string | null
}) {
  return productGuidanceForSnapshot({
    source: event.source,
    resourceType: event.targetType,
    workload: event.workload,
    category: event.category,
    operationName: event.operationName,
  })
}
const parseValue = (value: unknown) => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function guidance(category: string): string[] {
  if (category === 'MFA') return ['Confirm the change with the user using a trusted channel.', 'Revoke sessions and remove unrecognized authentication methods.', 'Require MFA registration again from a known-good device.']
  if (category === 'Passwords') return ['Reset the password to a unique value and revoke sessions.', 'Review sign-ins immediately before and after this event.']
  if (category === 'Apps') return ['Disable the unrecognized application or service principal.', 'Remove unrecognized credentials and revoke consent.', 'Review related audit events before restoring access.']
  if (category === 'Roles') return ['Remove unapproved role assignments.', 'Review every privileged action by the actor in this incident window.']
  if (category === 'Conditional Access') return ['Compare the recorded before and after values.', 'Restore the approved policy after peer review.']
  return ['Validate the change with the resource owner.', 'Use the evidence to restore the last approved configuration.']
}

function reviewGuidance(): string[] {
  return [
    'Confirm the event with the listed actor or resource owner.',
    'Use the timestamp and correlation ID to review Microsoft audit records and nearby sign-ins.',
    'Microsoft did not provide enough state evidence for HawkView to recommend a configuration rollback.',
  ]
}

function hasMaterialState(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.some(hasMaterialState)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasMaterialState)
  return true
}

function eventGuidance(category: string, before: unknown, after: unknown) {
  const recovery = hasMaterialState(before) || hasMaterialState(after)
  return {
    guidanceKind: recovery ? 'recovery' as const : 'review' as const,
    recoveryGuidance: recovery ? guidance(category) : reviewGuidance(),
  }
}

function actorFrom(value: unknown) {
  const initiated = object(value); const user = object(initiated.user); const app = object(initiated.app)
  return text(user.userPrincipalName) ?? text(user.displayName) ?? text(app.displayName) ?? text(app.servicePrincipalName) ?? text(user.id) ?? text(app.servicePrincipalId)
}

const valueText = (value: unknown) => {
  const parsed = parseValue(value)
  if (Array.isArray(parsed)) return parsed.map((item) => text(item)).filter(Boolean).join(', ') || undefined
  if (parsed && typeof parsed === 'object') return JSON.stringify(parsed)
  return text(parsed)
}

function evidenceFrom(log: { initiatedBy: unknown; targetResources: unknown; additionalDetails: unknown; raw: unknown; result: string | null; resultReason: string | null; operationType: string | null }) {
  const initiated = object(log.initiatedBy); const user = object(initiated.user); const app = object(initiated.app)
  const raw = object(log.raw); const targets = array(log.targetResources).map(object)
  const additional = new Map(array(log.additionalDetails).map(object).map((item) => [text(item.key)?.toLowerCase(), parseValue(item.value)]))
  const properties = new Map<string, unknown>()
  for (const target of targets) for (const item of array(target.modifiedProperties).map(object)) {
    const name = text(item.displayName)?.toLowerCase()
    if (name) properties.set(name, parseValue(item.newValue) ?? parseValue(item.oldValue))
  }
  const pick = (...names: string[]) => {
    for (const name of names) {
      const key = name.toLowerCase(); const direct = raw[name] ?? raw[key] ?? additional.get(key) ?? properties.get(key)
      if (direct !== undefined && direct !== null && direct !== '') return direct
    }
    return undefined
  }
  const primary = targets[0] ?? {}; const principalName = text(user.userPrincipalName)
  const targetName = text(primary.displayName) ?? text(primary.userPrincipalName) ?? text(primary.id) ?? 'Target not provided by Microsoft'
  return {
    result: log.result ?? text(raw.result), resultReason: log.resultReason ?? text(raw.resultReason), operationType: log.operationType ?? text(raw.operationType), loggedByService: text(raw.loggedByService),
    actor: { displayName: text(user.displayName) ?? text(app.displayName) ?? text(app.servicePrincipalName), principalName, type: user.id ? 'User' : app.servicePrincipalId || app.appId ? 'Service Principal / App' : 'System', objectId: text(user.id) ?? text(app.servicePrincipalId), ipAddress: text(user.ipAddress), automatedBy: text(app.displayName) ?? text(app.servicePrincipalName) },
    application: { displayName: valueText(pick('displayName', 'appDisplayName', 'applicationDisplayName')) ?? targetName, appId: valueText(pick('appId', 'applicationId', 'clientId')), objectId: text(primary.id) ?? valueText(pick('objectId')), servicePrincipalId: valueText(pick('servicePrincipalId')), publisher: valueText(pick('publisher', 'publisherName', 'verifiedPublisher')), appType: valueText(pick('appType', 'applicationType', 'servicePrincipalType')), signInAudience: valueText(pick('signInAudience')), description: valueText(pick('description', 'notes')), homepage: pick('homepage', 'identifierUris') },
    permissions: { permissionName: pick('permissionName', 'permission', 'oauth2PermissionGrant'), permissionType: valueText(pick('permissionType', 'grantType')), consentType: valueText(pick('consentType')), scope: pick('scope', 'grantedScope'), resourceApi: valueText(pick('resourceApi', 'resourceDisplayName', 'resource')), appRole: valueText(pick('appRole', 'appRoleId')), assignedTo: valueText(pick('assignedTo', 'targetIdentity')) ?? text(primary.userPrincipalName), grantingAdmin: principalName, consentStatus: valueText(pick('consentStatus', 'status')) ?? log.result ?? undefined },
    targets: targets.map((target) => ({ displayName: text(target.displayName) ?? text(target.userPrincipalName) ?? text(target.id) ?? 'Unnamed Microsoft resource', targetType: text(target.type) ?? 'Microsoft resource', objectId: text(target.id), upn: text(target.userPrincipalName) })),
  }
}

function targetDetails(value: unknown) {
  const targets = array(value).map(object); const first = targets[0] ?? {}
  const target = text(first.userPrincipalName) ?? text(first.displayName) ?? text(first.id)
  const before: JsonObject = {}; const after: JsonObject = {}
  for (const resource of targets) for (const item of array(resource.modifiedProperties).map(object)) {
    const name = text(item.displayName) ?? 'value'
    before[name] = redactSensitiveValues(parseValue(item.oldValue), name)
    after[name] = redactSensitiveValues(parseValue(item.newValue), name)
  }
  return { target, before, after }
}

function correlationIdFromRaw(value: unknown) {
  const raw = object(value)
  return text(raw.correlationId) ?? text(raw.correlation_id)
}

function targetResourceTypes(value: unknown) {
  return array(value).map(object).map((target) => text(target.type)).filter((type): type is string => Boolean(type))
}

function normalizedEvidenceClassification(event: {
  source: string
  operationName: string
  category?: string | null
  workload?: string | null
  targetType?: string | null
  result?: string | null
  raw?: unknown
  actorPrincipalName?: string | null
  actorDisplayName?: string | null
  targetDisplayName?: string | null
  beforeState?: unknown
  afterState?: unknown
}): ChangeClassification {
  const raw = object(event.raw)
  const operationType = text(raw.operationType) ?? text(raw.OperationType)
  if (event.source === 'DIRECTORY_AUDIT' && !operationType && !event.targetType) {
    return classifyLegacyDirectoryProjection({
      source: event.source,
      operation: event.operationName,
      category: event.category,
      actor: event.actorPrincipalName ?? event.actorDisplayName,
      result: event.result ?? text(raw.ResultStatus) ?? text(raw.result),
      beforeState: event.beforeState,
      afterState: event.afterState,
    }).classification
  }
  return classifyEvidence({
    source: event.source,
    workload: event.workload,
    activity: event.operationName,
    category: event.category,
    operationType,
    targetResourceTypes: [event.targetType],
    actor: event.actorPrincipalName ?? event.actorDisplayName,
    target: event.targetDisplayName,
    result: event.result ?? text(raw.ResultStatus) ?? text(raw.result),
    beforeState: event.beforeState,
    afterState: event.afterState,
    raw: event.raw,
  })
}

function normalizedEvidenceTrust(event: Parameters<typeof normalizedEvidenceClassification>[0]) {
  const raw = object(event.raw)
  const operationType = text(raw.operationType) ?? text(raw.OperationType)
  const input = {
    source: event.source,
    workload: event.workload,
    operation: event.operationName,
    category: event.category,
    operationType,
    targetResourceTypes: [event.targetType],
    actor: event.actorPrincipalName ?? event.actorDisplayName,
    result: event.result ?? text(raw.ResultStatus) ?? text(raw.result),
    beforeState: event.beforeState,
    afterState: event.afterState,
  }
  return event.source === 'DIRECTORY_AUDIT' && !operationType && !event.targetType
    ? classifyLegacyDirectoryProjection(input)
    : classifyEvidenceTrust(input)
}

function normalizedEvidenceProjection(event: Parameters<typeof normalizedEvidenceClassification>[0]) {
  const trust = normalizedEvidenceTrust(event)
  return {
    classification: normalizedEvidenceClassification(event),
    category: trust.evidenceClass === 'PRIMARY_CHANGE' ? trust.category : 'Unknown',
    severity: trust.evidenceClass === 'PRIMARY_CHANGE' ? trust.severity : 'Low',
    presentation: sourcePresentation(event),
    trust,
  }
}

function directoryAuditProjection(log: {
  activityDisplayName: string
  category: string | null
  operationType: string | null
  result: string | null
  targetResources: unknown
  initiatedBy: unknown
}) {
  const details = targetDetails(log.targetResources)
  const resourceTypes = targetResourceTypes(log.targetResources)
  const classification = classifyEvidence({
    source: 'DIRECTORY_AUDIT',
    activity: log.activityDisplayName,
    category: log.category,
    operationType: log.operationType,
    targetResourceTypes: resourceTypes,
    actor: actorFrom(log.initiatedBy),
    result: log.result,
    target: details.target,
    beforeState: details.before,
    afterState: details.after,
  })
  const trust = classifyEvidenceTrust({
    source: 'DIRECTORY_AUDIT', operation: log.activityDisplayName, category: log.category,
    operationType: log.operationType, targetResourceTypes: resourceTypes, actor: actorFrom(log.initiatedBy),
    result: log.result,
    beforeState: details.before, afterState: details.after,
  })
  return { details, classification, trust }
}

function evidenceTargetKeys(event: {
  customerTenantId: string
  category: string
  targetId?: string | null
  targetDisplayName?: string | null
}) {
  const prefix = `${event.customerTenantId}\u0000${event.category.toLowerCase()}\u0000`
  const id = text(event.targetId)?.toLowerCase()
  const name = text(event.targetDisplayName)?.toLowerCase()
  return [id ? `${prefix}id:${id}` : null, name ? `${prefix}name:${name}` : null]
    .filter((value): value is string => Boolean(value))
}

function authoritativeEvidenceIndex(
  candidates: Array<{
    source: string
    customerTenantId: string
    eventDateTime: Date
    category: string
    targetId?: string | null
    targetDisplayName?: string | null
  }>,
) {
  const index = new Map<string, number[]>()
  for (const candidate of candidates) {
    if (candidate.source === 'SNAPSHOT_DIFFERENCE' || candidate.source === 'SIGN_IN') continue
    for (const key of evidenceTargetKeys(candidate)) {
      const timestamps = index.get(key) ?? []
      timestamps.push(candidate.eventDateTime.getTime())
      index.set(key, timestamps)
    }
  }
  return index
}

function isSupersededSnapshot(
  snapshot: {
    source: string
    customerTenantId: string
    eventDateTime: Date
    category: string
    targetId?: string | null
    targetDisplayName?: string | null
  },
  index: Map<string, number[]>,
) {
  if (snapshot.source !== 'SNAPSHOT_DIFFERENCE') return false
  const snapshotTime = snapshot.eventDateTime.getTime()
  return evidenceTargetKeys(snapshot).some((key) =>
    (index.get(key) ?? []).some((candidateTime) => Math.abs(candidateTime - snapshotTime) <= 45 * 60 * 1000)
  )
}

function investigationIdentityValues(...values: Array<unknown>) {
  return new Set(values.map((value) => text(value)?.toLowerCase()).filter((value): value is string => Boolean(value)))
}

@Injectable()
export class ChangesService {
  private readonly logger = new Logger(ChangesService.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async organizationIds(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: { disabledAt: true, memberships: { where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } }, select: { organizationId: true } } },
    })
    if (!user || user.disabledAt) throw new ForbiddenException('This HawkView account cannot investigate changes.')
    return user.memberships.map((membership) => membership.organizationId)
  }

  /** The six-month range is bounded, but records inside it are never silently capped. */
  private async loadAllPages<T extends { id: string }>(loadPage: (cursor?: string) => Promise<T[]>) {
    const records: T[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await loadPage(cursor)
      records.push(...page)
      if (page.length < 1000) return records
      const nextCursor = page.at(-1)?.id
      if (!nextCursor || nextCursor === cursor) throw new Error('Change investigation pagination could not advance safely.')
      cursor = nextCursor
    }
  }

  async list(identity: AuthenticatedIdentity, query: Record<string, unknown>) {
    const organizationIds = await this.organizationIds(identity); const now = new Date()
    const from = new Date(text(query.from) ?? now.getTime() - 86_400_000); const to = new Date(text(query.to) ?? now)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new BadRequestException('Enter a valid investigation time range.')
    if (to.getTime() - from.getTime() > 183 * 86_400_000) throw new BadRequestException('Investigations are limited to HawkView\'s six-month retention window.')

    const allTenants = await this.prisma.customerTenant.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true, displayName: true, primaryDomain: true }, orderBy: { displayName: 'asc' } })
    const requestedTenantId = text(query.tenantId)
    const scopedTenants = requestedTenantId ? allTenants.filter((tenant) => tenant.id === requestedTenantId) : allTenants
    const tenantIds = scopedTenants.map((tenant) => tenant.id)
    const names = new Map(allTenants.map((tenant) => [tenant.id, tenant.displayName ?? tenant.primaryDomain ?? 'Microsoft tenant']))
    const where = { organizationId: { in: organizationIds }, customerTenantId: { in: tenantIds }, eventDateTime: { gte: from, lte: to } }
    const [auditLogs, evidenceEvents] = await Promise.all([
      this.loadAllPages((cursor) => this.prisma.directoryAuditLog
        .findMany({ where, orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }], take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }))
        .catch((error) => {
          this.logger.warn(`Unable to load directory audit source records: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }),
      this.loadAllPages((cursor) => this.prisma.changeEvidenceEvent
        .findMany({ where, orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }], take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }))
        .catch((error) => {
          // The source logs remain the canonical fallback while a newly
          // deployed projection table is unavailable or being backfilled.
          this.logger.warn(`Unable to load normalized change evidence; falling back to source logs: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }),
    ])

    const changes = auditLogs
      .map((log) => ({ log, ...directoryAuditProjection(log) }))
      .filter(({ classification }) => PRIMARY_CHANGE_CLASSIFICATIONS.has(classification))
      .map(({ log, details, classification, trust }) => {
        const kind = { category: trust.category, severity: trust.severity }
        const presentation = sourcePresentation({ source: 'DIRECTORY_AUDIT' })
        return { id: `audit:${log.microsoftAuditId}`, eventType: 'change' as const, classification, ts: log.eventDateTime.toISOString(), tenantId: log.customerTenantId, tenantName: names.get(log.customerTenantId) ?? 'Microsoft tenant', provider: 'Microsoft' as const, category: kind.category, severity: kind.severity, title: log.activityDisplayName, summary: [log.operationType, log.result, log.resultReason].filter(Boolean).join(' · ') || 'Microsoft directory change', actor: actorFrom(log.initiatedBy), target: details.target, source: presentation.source, before: details.before, after: details.after, correlationId: log.correlationId ?? undefined, ...eventGuidance(kind.category, details.before, details.after), evidence: { ...evidenceFrom(log), ...presentation } }
      })
    const authoritativeCandidates = [
      ...evidenceEvents,
      ...auditLogs.map((log) => {
        const primaryTarget = object(array(log.targetResources)[0])
        return {
          source: 'DIRECTORY_AUDIT',
          customerTenantId: log.customerTenantId,
          eventDateTime: log.eventDateTime,
          category: directoryAuditProjection(log).trust.category,
          targetId: text(primaryTarget.id) ?? null,
          targetDisplayName: text(primaryTarget.userPrincipalName) ?? text(primaryTarget.displayName) ?? text(primaryTarget.id) ?? null,
        }
      }),
    ]
    const authoritativeIndex = authoritativeEvidenceIndex(authoritativeCandidates)
    const normalized = evidenceEvents
      .filter((event) => !isSupersededSnapshot(event, authoritativeIndex))
      .map((event) => {
      const location = object(event.location)
      const before = object(event.beforeState)
      const after = object(event.afterState)
      const { classification, category, severity, presentation } = normalizedEvidenceProjection(event)
      const potentialImpact = potentialImpactFor(event)
      return {
        id: event.source === 'DIRECTORY_AUDIT'
          ? `audit:${event.sourceEventId}`
          : `evidence:${event.source}:${event.sourceEventId}`,
        eventType: 'change' as const,
        classification,
        ts: event.eventDateTime.toISOString(),
        tenantId: event.customerTenantId,
        tenantName: names.get(event.customerTenantId) ?? 'Microsoft tenant',
        provider: 'Microsoft' as const,
        category,
        severity,
        title: event.operationName,
        summary: event.summary,
        actor: event.actorPrincipalName ?? event.actorDisplayName ?? undefined,
        target: event.targetDisplayName ?? undefined,
        source: presentation.source,
        ip: event.ipAddress ?? undefined,
        location: {
          city: text(location.city),
          region: text(location.state) ?? text(location.region),
          country: text(location.countryOrRegion) ?? text(location.country),
        },
        before,
        after,
        correlationId: event.correlationId ?? undefined,
        ...eventGuidance(category, before, after),
        evidence: {
          normalized: true,
          changedFields: array(event.changedFields),
          workload: event.workload,
          result: event.result,
          ...presentation,
          ...(potentialImpact ? { potentialImpact } : {}),
        },
      }
    }).filter((event) => PRIMARY_CHANGE_CLASSIFICATIONS.has(event.classification))
    // A projection is created during subsequent syncs. Keep previously
    // retained raw records visible and let the normalized record replace its
    // identical source event when both are present.
    const bySourceEvent = new Map<string, TimelineEvent>()
    for (const event of changes) {
      const identity = timelineEvidenceIdentity(event)
      if (identity) bySourceEvent.set(timelineEvidenceKey(identity), event)
    }
    for (const event of normalized) {
      // Microsoft can surface the same Entra record through Graph and the
      // Management Activity API. Exact source IDs are safe to collapse; if
      // Microsoft supplies only an uncertain similarity, retain both records.
      const identity = timelineEvidenceIdentity(event)
      if (!identity) continue
      if (
        identity.source === 'M365_UNIFIED_AUDIT' &&
        bySourceEvent.has(timelineEvidenceKey({ ...identity, source: 'DIRECTORY_AUDIT' }))
      ) continue
      bySourceEvent.set(timelineEvidenceKey(identity), event)
    }
    let events: TimelineEvent[] = [...bySourceEvent.values()]
    const requestedCategory = text(query.category)
    const requestedSeverity = text(query.severity)
    const search = text(query.search)?.toLowerCase()
    if (requestedCategory) events = events.filter((event) => event.category.toLowerCase() === requestedCategory.toLowerCase())
    if (requestedSeverity) events = events.filter((event) => event.severity.toLowerCase() === requestedSeverity.toLowerCase())
    if (search) events = events.filter((event) => [event.title, event.summary, event.actor, event.target, event.ip].filter(Boolean).join(' ').toLowerCase().includes(search))
    events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id))
    const requestedPage = Number(text(query.page) ?? '1')
    const requestedPageSize = Number(text(query.pageSize) ?? '0')
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
    const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize > 0 ? Math.min(requestedPageSize, 250) : 0
    const total = events.length
    const summary = {
      total,
      changes: total,
      // Retained sign-in telemetry is intentionally excluded from the
      // primary change timeline and only returned as labelled supporting
      // evidence on a correlated change detail response.
      signIns: 0,
      supportingSignIns: 0,
      highRisk: events.filter((event) => event.severity === 'High').length,
      actors: new Set(events.map((event) => event.actor).filter(Boolean)).size,
      apps: new Set(events.filter((event) => event.category === 'Apps').map((event) => event.target).filter(Boolean)).size,
    }
    if (pageSize) events = events.slice((page - 1) * pageSize, page * pageSize)
    return { changes: events, tenants: allTenants.map((tenant) => ({ id: tenant.id, name: names.get(tenant.id)! })), summary, range: { from: from.toISOString(), to: to.toISOString() }, ...(pageSize ? { pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } : {}) }
  }

  async detail(identity: AuthenticatedIdentity, sourceId: string, requestedTenantId: unknown) {
    const customerTenantId = text(requestedTenantId)
    if (!customerTenantId) throw new BadRequestException('Select a tenant for this investigation event.')
    const separator = sourceId.indexOf(':')
    if (separator <= 0) throw new BadRequestException('Use a valid change event identifier.')
    if (sourceId.slice(0, separator) === 'signin') {
      throw new BadRequestException('Sign-ins are available only as correlated supporting evidence for a recorded change.')
    }
    const prefix = sourceId.slice(0, separator)
    let source = 'DIRECTORY_AUDIT'
    let sourceEventId = sourceId.slice(separator + 1)
    if (prefix === 'evidence') {
      const sourceSeparator = sourceEventId.indexOf(':')
      if (sourceSeparator <= 0) throw new BadRequestException('Use a valid evidence event identifier.')
      source = sourceEventId.slice(0, sourceSeparator)
      sourceEventId = sourceEventId.slice(sourceSeparator + 1)
    } else if (prefix !== 'audit') {
      throw new BadRequestException('Use a valid change event identifier.')
    }
    const organizationIds = await this.organizationIds(identity)
    const scopedTenants = await this.prisma.customerTenant.findMany({
      where: { id: customerTenantId, organizationId: { in: organizationIds } },
      select: { id: true },
      take: 1,
    })
    if (!scopedTenants.some((tenant) => tenant.id === customerTenantId)) {
      throw new BadRequestException('This investigation event is unavailable or outside retention.')
    }
    const projectedEvent = await this.prisma.changeEvidenceEvent.findFirst({
      where: { source, sourceEventId, customerTenantId, organizationId: { in: organizationIds } },
    })
    const fallbackAudit = projectedEvent || source !== 'DIRECTORY_AUDIT'
      ? null
      : await this.prisma.directoryAuditLog.findFirst({
          where: { microsoftAuditId: sourceEventId, customerTenantId, organizationId: { in: organizationIds } },
        })
    if (!projectedEvent && !fallbackAudit) throw new BadRequestException('This investigation event is unavailable or outside retention.')

    const fallbackDetails = fallbackAudit ? targetDetails(fallbackAudit.targetResources) : null
    const projection = projectedEvent
      ? normalizedEvidenceProjection(projectedEvent)
      : (() => {
          const projected = directoryAuditProjection(fallbackAudit!)
          return {
            classification: projected.classification,
            category: projected.trust.category,
            severity: projected.trust.severity,
            presentation: sourcePresentation({ source: 'DIRECTORY_AUDIT' }),
          }
        })()
    const { classification } = projection
    if (!PRIMARY_CHANGE_CLASSIFICATIONS.has(classification)) {
      throw new BadRequestException('This record is telemetry rather than a tenant change investigation event.')
    }
    const event = projectedEvent ?? {
      id: fallbackAudit!.id,
      source: 'DIRECTORY_AUDIT',
      sourceEventId: fallbackAudit!.microsoftAuditId,
      eventDateTime: fallbackAudit!.eventDateTime,
      customerTenantId: fallbackAudit!.customerTenantId,
      organizationId: fallbackAudit!.organizationId,
      category: projection.category,
      severity: projection.severity,
      operationName: fallbackAudit!.activityDisplayName,
      summary: [fallbackAudit!.operationType, fallbackAudit!.result, fallbackAudit!.resultReason].filter(Boolean).join(' · ') || 'Microsoft directory change',
      actorId: null,
      actorPrincipalName: actorFrom(fallbackAudit!.initiatedBy) ?? null,
      actorDisplayName: null,
      targetId: null,
      targetDisplayName: fallbackDetails!.target ?? null,
      correlationId: fallbackAudit!.correlationId,
      changedFields: Object.keys({ ...fallbackDetails!.before, ...fallbackDetails!.after }),
      workload: evidenceFrom(fallbackAudit!).loggedByService ?? 'Microsoft Entra ID',
      result: fallbackAudit!.result,
      location: null,
      beforeState: fallbackDetails!.before,
      afterState: fallbackDetails!.after,
      raw: redactSensitiveValues(fallbackAudit!.raw),
    }
    const related = event.correlationId
      ? await this.prisma.changeEvidenceEvent.findMany({
          where: { organizationId: { in: organizationIds }, customerTenantId: event.customerTenantId, correlationId: event.correlationId },
          orderBy: [{ eventDateTime: 'asc' }, { id: 'asc' }],
          take: 100,
        })
      : []
    const correlatedSignIns = event.correlationId
      ? await this.prisma.signInLog.findMany({
          where: {
            organizationId: { in: organizationIds },
            customerTenantId: event.customerTenantId,
            OR: [
              { raw: { path: ['correlationId'], equals: event.correlationId } },
              { raw: { path: ['correlation_id'], equals: event.correlationId } },
            ],
          },
          orderBy: { eventDateTime: 'asc' },
        })
      : []
    const relatedSignIns = correlatedSignIns
      .filter((signIn) => correlationIdFromRaw(signIn.raw) === event.correlationId)
      .map((signIn) => {
        const failed = Boolean(signIn.statusErrorCode && signIn.statusErrorCode !== '0')
        return {
          id: signIn.microsoftSignInId,
          eventDateTime: signIn.eventDateTime,
          actor: signIn.userPrincipalName ?? signIn.userDisplayName ?? undefined,
          application: signIn.resourceDisplayName ?? signIn.appDisplayName ?? undefined,
          result: failed ? 'Failure' : 'Success',
          ipAddress: signIn.ipAddress ?? undefined,
          source: 'Microsoft Graph auditLogs/signIns',
          provenance: 'Microsoft Graph auditLogs/signIns',
          relationship: 'Shares Microsoft correlation ID; this is supporting evidence and does not establish causation.',
        }
      })
    const incidentStart = new Date(event.eventDateTime.getTime() - 60 * 60 * 1000)
    const incidentEnd = new Date(event.eventDateTime.getTime() + 60 * 60 * 1000)
    const actorIdentities = investigationIdentityValues(event.actorId, event.actorPrincipalName, event.actorDisplayName)
    const targetIdentities = investigationIdentityValues(event.targetId, event.targetDisplayName)
    const canAssociate = actorIdentities.size > 0 || targetIdentities.size > 0
    const originalActorIdentities = [event.actorId, event.actorPrincipalName, event.actorDisplayName].map(text).filter((value): value is string => Boolean(value))
    const originalTargetIdentities = [event.targetId, event.targetDisplayName].map(text).filter((value): value is string => Boolean(value))
    const auditAssociationPredicates = [
      ...originalActorIdentities.map((value) => ({ actorId: { equals: value, mode: 'insensitive' as const } })),
      ...originalTargetIdentities.map((value) => ({ objectId: { equals: value, mode: 'insensitive' as const } })),
      ...originalActorIdentities.flatMap((value) => [
        { raw: { path: ['UserId'], equals: value } },
        { raw: { path: ['UserKey'], equals: value } },
      ]),
      ...originalTargetIdentities.flatMap((value) => [
        { raw: { path: ['MailboxOwnerUPN'], equals: value } },
        { raw: { path: ['TargetUserOrGroupName'], equals: value } },
      ]),
    ]
    const changeAssociationPredicates = [
      ...originalActorIdentities.flatMap((value) => [
        { actorId: { equals: value, mode: 'insensitive' as const } },
        { actorPrincipalName: { equals: value, mode: 'insensitive' as const } },
        { actorDisplayName: { equals: value, mode: 'insensitive' as const } },
      ]),
      ...originalTargetIdentities.flatMap((value) => [
        { targetId: { equals: value, mode: 'insensitive' as const } },
        { targetDisplayName: { equals: value, mode: 'insensitive' as const } },
      ]),
    ]
    const [mailboxCandidates, nearbyChangeCandidates] = canAssociate
      ? await Promise.all([
          this.prisma.m365AuditRecord.findMany({
            where: {
              organizationId: { in: organizationIds },
              customerTenantId: event.customerTenantId,
              eventDateTime: { gte: incidentStart, lte: incidentEnd },
              OR: auditAssociationPredicates,
            },
            orderBy: [{ eventDateTime: 'asc' }, { id: 'asc' }],
            take: 2001,
          }),
          this.prisma.changeEvidenceEvent.findMany({
            where: {
              organizationId: { in: organizationIds },
              customerTenantId: event.customerTenantId,
              eventDateTime: { gte: incidentStart, lte: incidentEnd },
              OR: changeAssociationPredicates,
            },
            orderBy: [{ eventDateTime: 'asc' }, { id: 'asc' }],
            take: 201,
          }),
        ])
      : [[], []]
    const supportingRows = mailboxCandidates.slice(0, 2000).filter((candidate) => {
      if (managementActivityRoleFromEvidence({
        operationName: candidate.operation,
        workload: candidate.workload,
        raw: candidate.raw,
      }) !== 'security_supporting_activity') return false
      const raw = object(candidate.raw)
      const candidateActors = investigationIdentityValues(candidate.actorId, raw.UserId, raw.UserKey)
      const candidateTargets = investigationIdentityValues(
        candidate.objectId,
        raw.MailboxOwnerUPN,
        raw.TargetUserOrGroupName,
      )
      return [...candidateActors].some((value) => actorIdentities.has(value))
        || [...candidateTargets].some((value) => targetIdentities.has(value))
    })
    const groupedMailboxActivity = new Map<string, {
      operation: string
      workload: string
      actor?: string
      mailboxOrObject?: string
      count: number
      firstSeenAt: Date
      lastSeenAt: Date
      sampleMicrosoftRecordIds: string[]
      exactCorrelationMatch: boolean
    }>()
    for (const candidate of supportingRows) {
      const raw = object(candidate.raw)
      const actor = candidate.actorId ?? text(raw.UserId) ?? text(raw.UserKey)
      const mailboxOrObject = text(raw.MailboxOwnerUPN) ?? candidate.objectId ?? undefined
      const key = [candidate.workload ?? 'Exchange', candidate.operation, actor ?? '', mailboxOrObject ?? ''].join('\u0000').toLowerCase()
      const existingGroup = groupedMailboxActivity.get(key)
      const exactCorrelationMatch = Boolean(event.correlationId && candidate.correlationId === event.correlationId)
      const recordedCount = typeof raw.hawkviewSupportingActivityCount === 'number' && raw.hawkviewSupportingActivityCount > 0
        ? Math.floor(raw.hawkviewSupportingActivityCount)
        : 1
      const recordedFirstSeenAt = text(raw.hawkviewSupportingFirstSeenAt)
      const recordedLastSeenAt = text(raw.hawkviewSupportingLastSeenAt)
      const firstSeenAt = recordedFirstSeenAt && Number.isFinite(Date.parse(recordedFirstSeenAt))
        ? new Date(recordedFirstSeenAt)
        : candidate.eventDateTime
      const lastSeenAt = recordedLastSeenAt && Number.isFinite(Date.parse(recordedLastSeenAt))
        ? new Date(recordedLastSeenAt)
        : candidate.eventDateTime
      const recordedSamples = array(raw.hawkviewSupportingSampleRecordIds).map(text).filter((value): value is string => Boolean(value))
      const sampleRecordIds = recordedSamples.length ? recordedSamples : [candidate.microsoftRecordId]
      if (existingGroup) {
        existingGroup.count += recordedCount
        if (firstSeenAt < existingGroup.firstSeenAt) existingGroup.firstSeenAt = firstSeenAt
        if (lastSeenAt > existingGroup.lastSeenAt) existingGroup.lastSeenAt = lastSeenAt
        existingGroup.exactCorrelationMatch ||= exactCorrelationMatch
        for (const sampleId of sampleRecordIds) {
          if (existingGroup.sampleMicrosoftRecordIds.length >= 10) break
          if (!existingGroup.sampleMicrosoftRecordIds.includes(sampleId)) existingGroup.sampleMicrosoftRecordIds.push(sampleId)
        }
      } else {
        groupedMailboxActivity.set(key, {
          operation: candidate.operation,
          workload: candidate.workload ?? 'Exchange',
          actor: actor ?? undefined,
          mailboxOrObject,
          count: recordedCount,
          firstSeenAt,
          lastSeenAt,
          sampleMicrosoftRecordIds: sampleRecordIds.slice(0, 10),
          exactCorrelationMatch,
        })
      }
    }
    const relatedMailboxActivity = [...groupedMailboxActivity.values()].map(({ exactCorrelationMatch, ...group }) => ({
      ...group,
      source: 'Office 365 Management Activity API',
      provenance: 'Microsoft Purview unified audit supporting activity',
      relationship: exactCorrelationMatch
        ? 'Shares a Microsoft correlation ID; this is supporting evidence and does not establish causation.'
        : 'Shares an exact actor or target within the one-hour investigation window; this is supporting evidence and does not establish causation.',
    }))
    const associatedChanges = nearbyChangeCandidates
      .slice(0, 200)
      .filter((candidate) => candidate.id !== event.id && PRIMARY_CHANGE_CLASSIFICATIONS.has(normalizedEvidenceClassification(candidate)))
      .filter((candidate) => {
        const candidateActors = investigationIdentityValues(candidate.actorId, candidate.actorPrincipalName, candidate.actorDisplayName)
        const candidateTargets = investigationIdentityValues(candidate.targetId, candidate.targetDisplayName)
        return [...candidateActors].some((value) => actorIdentities.has(value))
          || [...candidateTargets].some((value) => targetIdentities.has(value))
      })
      .map((candidate) => ({
        id: candidate.source === 'DIRECTORY_AUDIT'
          ? `audit:${candidate.sourceEventId}`
          : `evidence:${candidate.source}:${candidate.sourceEventId}`,
        eventDateTime: candidate.eventDateTime,
        operationName: candidate.operationName,
        category: candidate.category,
        actor: candidate.actorPrincipalName ?? candidate.actorDisplayName ?? undefined,
        target: candidate.targetDisplayName ?? undefined,
        source: candidate.source,
        relationship: 'Shares an exact actor or target within the one-hour investigation window; this association does not establish causation.',
      }))
    const presentation = projection.presentation
    const potentialImpact = potentialImpactFor(event)
    return {
      event: {
        ...event,
        category: projection.category,
        severity: projection.severity,
        source: presentation.source,
        classification,
        evidence: {
          ...presentation,
          ...(potentialImpact ? { potentialImpact } : {}),
        },
      },
      classification,
      relatedEvents: related.filter((candidate) => candidate.id !== event.id && candidate.source !== 'SIGN_IN'),
      relatedSignIns,
      relatedMailboxActivity,
      relatedMailboxActivityTruncated: mailboxCandidates.length > 2000,
      associatedChanges,
      associatedChangesTruncated: nearbyChangeCandidates.length > 200,
    }
  }
}
