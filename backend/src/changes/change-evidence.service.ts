import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const sensitiveKey = /(?:password|secret|token|authorization|credential|private.?key|client.?secret|assertion|certificate)/i

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

function classify(activity: string, category?: string | null) {
  const value = `${activity} ${category ?? ''}`.toLowerCase()
  if (/authentication method|security info|mfa|strong authentication/.test(value)) return { category: 'MFA', severity: 'High' }
  if (/password/.test(value)) return { category: 'Passwords', severity: 'High' }
  if (/conditional access|named location/.test(value)) return { category: 'Conditional Access', severity: 'High' }
  if (/service principal|application|app registration|credential|oauth/.test(value)) return { category: 'Apps', severity: 'High' }
  if (/role|eligible assignment|member to role/.test(value)) return { category: 'Roles', severity: 'High' }
  if (/group/.test(value)) return { category: 'Groups', severity: 'Medium' }
  if (/device/.test(value)) return { category: 'Devices', severity: 'Medium' }
  if (/license/.test(value)) return { category: 'Licenses', severity: 'Medium' }
  return { category: 'Users', severity: 'Low' }
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
      const kind = classify(record.activityDisplayName, record.category)
      const target = targetState(record.targetResources)
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
        raw: redactSensitiveValues(record.raw) as never,
        ingestedAt: record.ingestedAt,
        expiresAt: record.expiresAt,
      }
    })
    await this.prisma.changeEvidenceEvent.createMany({
      data: data as never,
      skipDuplicates: true,
    })
  }

  async projectSignIns(
    tenant: { id: string; organizationId: string },
    records: Array<Record<string, any>>
  ) {
    if (records.length === 0) return
    const data = records.map((record) => {
      const failed = Boolean(record.statusErrorCode && record.statusErrorCode !== '0')
      const risky = Boolean(
        record.riskLevel && !['none', 'hidden', 'unknown'].includes(String(record.riskLevel).toLowerCase())
      )
      return {
        organizationId: tenant.organizationId,
        customerTenantId: tenant.id,
        source: 'SIGN_IN',
        sourceEventId: record.microsoftSignInId,
        eventDateTime: record.eventDateTime,
        workload: 'Microsoft Entra ID',
        category: 'Sign-ins',
        severity: risky ? 'High' : failed ? 'Medium' : 'Low',
        operationName: failed ? 'Failed sign-in' : 'Successful sign-in',
        summary: [record.appDisplayName, record.failureReason, record.conditionalAccessStatus]
          .filter(Boolean)
          .join(' · ') || 'Microsoft sign-in activity',
        actorId: record.userId ?? null,
        actorDisplayName: record.userDisplayName ?? null,
        actorPrincipalName: record.userPrincipalName ?? null,
        targetId: record.appId ?? null,
        targetDisplayName: record.resourceDisplayName ?? record.appDisplayName ?? null,
        targetType: 'Application',
        correlationId: null,
        result: failed ? 'Failure' : 'Success',
        ipAddress: record.ipAddress ?? null,
        location: record.location ? redactSensitiveValues(record.location) as never : undefined,
        beforeState: undefined,
        afterState: { result: failed ? 'Failed' : 'Success', riskLevel: record.riskLevel ?? null } as never,
        changedFields: undefined,
        raw: redactSensitiveValues(record.raw) as never,
        ingestedAt: record.ingestedAt,
        expiresAt: record.expiresAt,
      }
    })
    await this.prisma.changeEvidenceEvent.createMany({
      data: data as never,
      skipDuplicates: true,
    })
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
