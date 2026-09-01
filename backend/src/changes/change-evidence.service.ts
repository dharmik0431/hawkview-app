import { Inject, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { legacyCategory } from './change-classification.js'
import {
  SNAPSHOT_DIFFERENCE_SPECS,
  type EvidenceOrigin,
} from './microsoft-admin-change-catalog.js'

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const sensitiveKey = /(?:password|secret|token|authorization|credential|private.?key|client.?secret|assertion|certificate)/i

export type SnapshotDifferenceEvidence = {
  organizationId: string
  customerTenantId: string
  source: 'SNAPSHOT_DIFFERENCE'
  sourceEventId: string
  eventDateTime: Date
  workload: string
  category: string
  severity: 'Low' | 'Medium' | 'High'
  operationName: string
  summary: string
  actorId: null
  actorDisplayName: null
  actorPrincipalName: null
  targetId: string | null
  targetDisplayName: string | null
  targetType: string | null
  correlationId: null
  result: 'detected'
  ipAddress: null
  location: null
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  changedFields: string[]
  raw: Record<string, unknown>
  ingestedAt: Date
  expiresAt: Date
}

// Microsoft audit payloads can contain configuration values. Retain useful
// evidence while ensuring secrets never become searchable historical data.
export function redactSensitiveValues(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValues(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([childKey, childValue]) => [
        childKey,
        redactSensitiveValues(childValue, childKey),
      ])
    )
  }
  return value
}

function parseValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function targetState(targetResources: unknown) {
  const targets = array(targetResources).map(object)
  const primary = targets[0] ?? {}
  const before: JsonObject = {}
  const after: JsonObject = {}
  const fields: string[] = []
  for (const target of targets) {
    for (const property of array(target.modifiedProperties).map(object)) {
      const name = text(property.displayName) ?? 'value'
      fields.push(name)
      before[name] = redactSensitiveValues(parseValue(property.oldValue), name)
      after[name] = redactSensitiveValues(parseValue(property.newValue), name)
    }
  }
  return {
    targetId: text(primary.id),
    targetDisplayName:
      text(primary.userPrincipalName) ?? text(primary.displayName) ?? text(primary.id),
    targetType: text(primary.type),
    before: Object.keys(before).length > 0 ? before : null,
    after: Object.keys(after).length > 0 ? after : null,
    fields: fields.length > 0 ? [...new Set(fields)] : null,
  }
}

function actor(initiatedBy: unknown) {
  const initiated = object(initiatedBy)
  const user = object(initiated.user)
  const app = object(initiated.app)
  return {
    id: text(user.id) ?? text(app.servicePrincipalId) ?? text(app.appId),
    displayName:
      text(user.displayName) ?? text(app.displayName) ?? text(app.servicePrincipalName),
    principalName: text(user.userPrincipalName) ?? text(app.servicePrincipalName),
  }
}

function snapshotObjects(value: unknown): JsonObject[] {
  return array(value).map(object).filter((item) => Object.keys(item).length > 0)
}

function identifierFor(
  row: JsonObject,
  fields: readonly string[],
  compoundFields?: readonly string[]
) {
  if (compoundFields && compoundFields.length > 0) {
    const values = compoundFields.map((field) => {
      const value = row[field]
      return typeof value === 'string' && value.trim()
        ? value.trim()
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : null
    })
    return values.every((value): value is string => value !== null)
      ? values.join('::')
      : null
  }
  for (const field of fields) {
    const value = row[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return null
}

const UNORDERED_ARRAY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  GROUPS: new Set(['groupTypes']),
  CONDITIONAL_ACCESS: new Set([
    'includeUsers', 'excludeUsers', 'includeGroups', 'excludeGroups',
    'includeRoles', 'excludeRoles', 'includeApplications', 'excludeApplications',
    'includeLocations', 'excludeLocations', 'includePlatforms', 'excludePlatforms',
    'includeRiskLevels', 'excludeRiskLevels', 'includeClientAppTypes',
    'builtInControls', 'termsOfUse', 'authenticationStrength',
  ]),
  NAMED_LOCATIONS: new Set(['countriesAndRegions', 'ipRanges']),
  SERVICE_PRINCIPALS: new Set(['tags', 'appRoles']),
  APPLICATIONS: new Set(['appRoles', 'requiredResourceAccess', 'resourceAccess', 'passwordCredentials', 'keyCredentials']),
  SHAREPOINT_SETTINGS: new Set(['allowedDomainGuids', 'allowedDomainList', 'excludedFileExtensions']),
}

function canonicalize(value: unknown, resourceType: string, fieldName?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalize(entry, resourceType, fieldName))
    if (fieldName && UNORDERED_ARRAY_FIELDS[resourceType]?.has(fieldName)) {
      return entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }
    return entries
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child, resourceType, key)])
    )
  }
  return value
}

function selectedState(row: JsonObject, fields: readonly string[], resourceType: string) {
  const state: JsonObject = {}
  for (const field of fields) {
    if (row[field] !== undefined) {
      state[field] = canonicalize(row[field], resourceType, field)
    }
  }
  return state
}

function sameState(left: JsonObject, right: JsonObject) {
  return JSON.stringify(left) === JSON.stringify(right)
}

@Injectable()
export class ChangeEvidenceService {
  private readonly logger = new Logger(ChangeEvidenceService.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async projectDirectoryAudits(
    tenant: { id: string; organizationId: string },
    records: Array<Record<string, any>>
  ) {
    if (records.length === 0) return
    const data = records.map((record) => {
      const target = targetState(record.targetResources)
      const kind = legacyCategory(
        record.activityDisplayName,
        record.category,
        record.operationType,
        [target.targetType],
      )
      const initiatedBy = actor(record.initiatedBy)
      const initiated = object(record.initiatedBy)
      const initiatingUser = object(initiated.user)
      return {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        source: 'DIRECTORY_AUDIT',
        sourceEventId: record.microsoftAuditId,
        eventDateTime: record.eventDateTime,
        workload: record.loggedByService ?? 'Microsoft Entra ID',
        category: kind.category,
        severity: kind.severity,
        operationName: record.activityDisplayName,
        summary: [record.operationType, record.result, record.resultReason]
          .filter(Boolean)
          .join(' · ') || 'Microsoft directory change',
        actorId: initiatedBy.id,
        actorDisplayName: initiatedBy.displayName,
        actorPrincipalName: initiatedBy.principalName,
        targetId: target.targetId,
        targetDisplayName: target.targetDisplayName,
        targetType: target.targetType,
        correlationId: record.correlationId ?? null,
        result: record.result ?? null,
        ipAddress: text(initiatingUser.ipAddress),
        location: null,
        beforeState: target.before ?? undefined,
        afterState: target.after ?? undefined,
        changedFields: target.fields ?? undefined,
        raw: {
          ...object(redactSensitiveValues(record.raw)),
          evidenceOrigin: 'microsoft_audit_event',
          microsoftSource: 'Microsoft Graph /auditLogs/directoryAudits',
        } as never,
        ingestedAt: record.ingestedAt,
        expiresAt: record.expiresAt,
      }
    })
    await this.prisma.changeEvidenceEvent.createMany({
      data: data as never,
      skipDuplicates: true,
    })
  }

  /**
   * Builds evidence only for a successful comparison of two persisted admin
   * snapshots.  It does not write: the caller writes the evidence and the new
   * baseline in one transaction, which prevents retry duplicates and avoids a
   * "first collection" inventing changes.
   */
  buildSnapshotDifferenceEvidence(input: {
    tenant: { id: string; organizationId: string }
    resourceType: string
    previousPayload: unknown
    currentPayload: unknown
    observedAt: Date
    baselineObservedAt?: Date | null
    expiresAt: Date
  }): SnapshotDifferenceEvidence[] {
    const spec = SNAPSHOT_DIFFERENCE_SPECS[input.resourceType]
    if (!spec || input.previousPayload == null) return []

    const previous = snapshotObjects(input.previousPayload)
    const current = snapshotObjects(input.currentPayload)
    const previousById = new Map(
      previous
        .map((row) => [identifierFor(row, spec.identifierFields, spec.compoundIdentifierFields), row] as const)
        .filter((entry): entry is [string, JsonObject] => entry[0] !== null)
    )
    const currentById = new Map(
      current
        .map((row) => [identifierFor(row, spec.identifierFields, spec.compoundIdentifierFields), row] as const)
        .filter((entry): entry is [string, JsonObject] => entry[0] !== null)
    )
    const identifiers = new Set([...previousById.keys(), ...currentById.keys()])
    const origin: EvidenceOrigin = 'hawkview_snapshot_difference'
    const output: SnapshotDifferenceEvidence[] = []

    for (const identifier of identifiers) {
      const beforeRow = previousById.get(identifier) ?? null
      const afterRow = currentById.get(identifier) ?? null
      // Compare the selected state before redaction, otherwise two credential
      // rotations both become `[REDACTED]` and the real administrative change
      // disappears. Only redacted representations are ever persisted. The
      // deduplication ID below deliberately does not include those raw values.
      const beforeComparable = beforeRow ? selectedState(beforeRow, spec.trackedFields, input.resourceType) : null
      const afterComparable = afterRow ? selectedState(afterRow, spec.trackedFields, input.resourceType) : null
      if (beforeComparable && afterComparable && sameState(beforeComparable, afterComparable)) continue

      const changedFields = spec.trackedFields.filter((field) =>
        JSON.stringify(beforeComparable?.[field]) !== JSON.stringify(afterComparable?.[field])
      )
      // An unidentifiable record is not defensible evidence.  Do not infer a
      // target merely because a collection row moved position.
      if (changedFields.length === 0) continue
      const before = beforeComparable
        ? (redactSensitiveValues(beforeComparable) as JsonObject)
        : null
      const after = afterComparable
        ? (redactSensitiveValues(afterComparable) as JsonObject)
        : null
      // A retry of the same successful comparison must deduplicate, but this
      // fingerprint must not become a derived store of secret material.
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            resourceType: input.resourceType,
            identifier,
            changedFields,
            // A baseline version is stable across a retry, while a later
            // A→B transition after B→A gets a new baseline version.
            baselineObservedAt: input.baselineObservedAt?.toISOString() ?? null,
          })
        )
        .digest('hex')
        .slice(0, 24)
      const targetName =
        text(afterRow?.displayName) ?? text(afterRow?.name) ?? text(afterRow?.webUrl) ?? identifier
      output.push({
        organizationId: input.tenant.organizationId,
        customerTenantId: input.tenant.id,
        source: 'SNAPSHOT_DIFFERENCE',
        sourceEventId: `${input.resourceType}:${identifier}:${digest}`.slice(0, 200),
        eventDateTime: input.observedAt,
        workload: spec.workload,
        category: spec.category,
        severity: spec.severity,
        operationName: spec.operationName,
        summary: 'HawkView detected a difference between successful Microsoft collections. Microsoft did not provide a confirmed actor.',
        actorId: null,
        actorDisplayName: null,
        actorPrincipalName: null,
        targetId: identifier,
        targetDisplayName: targetName,
        targetType: input.resourceType,
        correlationId: null,
        result: 'detected',
        ipAddress: null,
        location: null,
        beforeState: before,
        afterState: after,
        changedFields,
        raw: {
          evidenceOrigin: origin,
          microsoftSource: spec.microsoftSource,
          resourceType: input.resourceType,
          actorAvailability: 'Microsoft did not provide a confirmed actor.',
          comparison: 'successful_snapshot_to_successful_snapshot',
        },
        ingestedAt: input.observedAt,
        expiresAt: input.expiresAt,
      })
    }
    return output
  }

  async pruneExpired(customerTenantId: string, expiresAt: Date) {
    try {
      await this.prisma.changeEvidenceEvent.deleteMany({
        where: { customerTenantId, expiresAt: { lte: expiresAt } },
      })
    } catch (error) {
      // Projection cleanup must not make a tenant's source-data sync fail.
      this.logger.warn(`Unable to prune expired change evidence: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
