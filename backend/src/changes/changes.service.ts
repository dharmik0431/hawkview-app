import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { redactSensitiveValues } from './change-evidence.service.js'
import {
  classifyEvidence,
  isPrimaryChange,
  legacyCategory,
  PRIMARY_CHANGE_CLASSIFICATIONS,
  type ChangeClassification,
} from './change-classification.js'

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
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
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
      .filter((log) => isPrimaryChange({ source: 'DIRECTORY_AUDIT', activity: log.activityDisplayName, category: log.category, operationType: log.operationType, targetResourceTypes: targetResourceTypes(log.targetResources) }))
      .map((log) => {
        const kind = legacyCategory(log.activityDisplayName, log.category); const details = targetDetails(log.targetResources)
        const classification = classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: log.activityDisplayName, category: log.category, operationType: log.operationType, targetResourceTypes: targetResourceTypes(log.targetResources) })
        return { id: `audit:${log.microsoftAuditId}`, eventType: 'change' as const, classification, ts: log.eventDateTime.toISOString(), tenantId: log.customerTenantId, tenantName: names.get(log.customerTenantId) ?? 'Microsoft tenant', provider: 'Microsoft' as const, category: kind.category, severity: kind.severity, title: log.activityDisplayName, summary: [log.operationType, log.result, log.resultReason].filter(Boolean).join(' · ') || 'Microsoft directory change', actor: actorFrom(log.initiatedBy), target: details.target, source: 'Entra' as const, before: details.before, after: details.after, correlationId: log.correlationId ?? undefined, recoveryGuidance: guidance(kind.category), evidence: { ...evidenceFrom(log), provenance: 'Microsoft Graph directoryAudit' } }
      })
    const normalized = evidenceEvents.map((event) => {
      const location = object(event.location)
      const before = object(event.beforeState)
      const after = object(event.afterState)
      const classification = classifyEvidence({ source: event.source, activity: event.operationName, category: event.category })
      return {
        id: `audit:${event.sourceEventId}`,
        eventType: 'change' as const,
        classification,
        ts: event.eventDateTime.toISOString(),
        tenantId: event.customerTenantId,
        tenantName: names.get(event.customerTenantId) ?? 'Microsoft tenant',
        provider: 'Microsoft' as const,
        category: event.category,
        severity: event.severity,
        title: event.operationName,
        summary: event.summary,
        actor: event.actorPrincipalName ?? event.actorDisplayName ?? undefined,
        target: event.targetDisplayName ?? undefined,
        source: 'Entra' as const,
        ip: event.ipAddress ?? undefined,
        location: {
          city: text(location.city),
          region: text(location.state) ?? text(location.region),
          country: text(location.countryOrRegion) ?? text(location.country),
        },
        before,
        after,
        correlationId: event.correlationId ?? undefined,
        recoveryGuidance: guidance(event.category),
        evidence: {
          normalized: true,
          changedFields: array(event.changedFields),
          workload: event.workload,
          result: event.result,
          provenance: event.source === 'DIRECTORY_AUDIT' ? 'Microsoft Graph directoryAudit' : event.source,
        },
      }
    }).filter((event) => PRIMARY_CHANGE_CLASSIFICATIONS.has(event.classification))
    // A projection is created during subsequent syncs. Keep previously
    // retained raw records visible and let the normalized record replace its
    // identical source event when both are present.
    const bySourceEvent = new Map<string, TimelineEvent>(
      changes.map((event): [string, TimelineEvent] => [event.id, event])
    )
    for (const event of normalized) bySourceEvent.set(event.id, event)
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

  async detail(identity: AuthenticatedIdentity, sourceId: string) {
    const separator = sourceId.indexOf(':')
    if (separator <= 0) throw new BadRequestException('Use a valid change event identifier.')
    if (sourceId.slice(0, separator) === 'signin') {
      throw new BadRequestException('Sign-ins are available only as correlated supporting evidence for a recorded change.')
    }
    const source = 'DIRECTORY_AUDIT'
    const sourceEventId = sourceId.slice(separator + 1)
    const organizationIds = await this.organizationIds(identity)
    const projectedEvent = await this.prisma.changeEvidenceEvent.findFirst({
      where: { source, sourceEventId, organizationId: { in: organizationIds } },
    })
    const fallbackAudit = projectedEvent ? null : await this.prisma.directoryAuditLog.findFirst({
      where: { microsoftAuditId: sourceEventId, organizationId: { in: organizationIds } },
    })
    if (!projectedEvent && !fallbackAudit) throw new BadRequestException('This investigation event is unavailable or outside retention.')

    const fallbackKind = fallbackAudit ? legacyCategory(fallbackAudit.activityDisplayName, fallbackAudit.category) : null
    const fallbackDetails = fallbackAudit ? targetDetails(fallbackAudit.targetResources) : null
    const classification = projectedEvent
      ? classifyEvidence({ source: projectedEvent.source, activity: projectedEvent.operationName, category: projectedEvent.category })
      : classifyEvidence({ source: 'DIRECTORY_AUDIT', activity: fallbackAudit!.activityDisplayName, category: fallbackAudit!.category, operationType: fallbackAudit!.operationType, targetResourceTypes: targetResourceTypes(fallbackAudit!.targetResources) })
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
      category: fallbackKind!.category,
      severity: fallbackKind!.severity,
      operationName: fallbackAudit!.activityDisplayName,
      summary: [fallbackAudit!.operationType, fallbackAudit!.result, fallbackAudit!.resultReason].filter(Boolean).join(' · ') || 'Microsoft directory change',
      actorPrincipalName: actorFrom(fallbackAudit!.initiatedBy) ?? null,
      actorDisplayName: null,
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
    return {
      event,
      classification,
      relatedEvents: related.filter((candidate) => candidate.id !== event.id && candidate.source !== 'SIGN_IN'),
      relatedSignIns,
    }
  }
}
