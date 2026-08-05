import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const parseValue = (value: unknown) => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function classify(activity: string, category?: string | null) {
  const value = `${activity} ${category ?? ''}`.toLowerCase()
  if (/authentication method|security info|mfa|strong authentication/.test(value)) return { category: 'MFA', severity: 'High' } as const
  if (/password/.test(value)) return { category: 'Passwords', severity: 'High' } as const
  if (/conditional access|named location/.test(value)) return { category: 'Conditional Access', severity: 'High' } as const
  if (/service principal|application|app registration|credential/.test(value)) return { category: 'Apps', severity: 'High' } as const
  if (/role|eligible assignment|member to role/.test(value)) return { category: 'Roles', severity: 'High' } as const
  if (/group/.test(value)) return { category: 'Groups', severity: 'Medium' } as const
  if (/device/.test(value)) return { category: 'Devices', severity: 'Medium' } as const
  if (/license/.test(value)) return { category: 'Licenses', severity: 'Medium' } as const
  return { category: 'Users', severity: 'Low' } as const
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

function targetDetails(value: unknown) {
  const targets = array(value).map(object); const first = targets[0] ?? {}
  const target = text(first.userPrincipalName) ?? text(first.displayName) ?? text(first.id)
  const before: JsonObject = {}; const after: JsonObject = {}
  for (const resource of targets) for (const item of array(resource.modifiedProperties).map(object)) {
    const name = text(item.displayName) ?? 'value'
    before[name] = parseValue(item.oldValue); after[name] = parseValue(item.newValue)
  }
  return { target, before, after }
}

@Injectable()
export class ChangesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async organizationIds(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: { disabledAt: true, memberships: { where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } }, select: { organizationId: true } } },
    })
    if (!user || user.disabledAt) throw new ForbiddenException('This HawkView account cannot investigate changes.')
    return user.memberships.map((membership) => membership.organizationId)
  }

  async list(identity: AuthenticatedIdentity, query: Record<string, unknown>) {
    const organizationIds = await this.organizationIds(identity); const now = new Date()
    const from = new Date(text(query.from) ?? now.getTime() - 86_400_000); const to = new Date(text(query.to) ?? now)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new BadRequestException('Enter a valid investigation time range.')
    if (to.getTime() - from.getTime() > 31 * 86_400_000) throw new BadRequestException('Investigations are limited to a 31-day window.')

    const allTenants = await this.prisma.customerTenant.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true, displayName: true, primaryDomain: true }, orderBy: { displayName: 'asc' } })
    const requestedTenantId = text(query.tenantId)
    const scopedTenants = requestedTenantId ? allTenants.filter((tenant) => tenant.id === requestedTenantId) : allTenants
    const tenantIds = scopedTenants.map((tenant) => tenant.id)
    const names = new Map(allTenants.map((tenant) => [tenant.id, tenant.displayName ?? tenant.primaryDomain ?? 'Microsoft tenant']))
    const where = { organizationId: { in: organizationIds }, customerTenantId: { in: tenantIds }, eventDateTime: { gte: from, lte: to } }
    const [auditLogs, signIns] = await Promise.all([
      this.prisma.directoryAuditLog.findMany({ where, orderBy: { eventDateTime: 'desc' }, take: 5000 }),
      this.prisma.signInLog.findMany({ where, orderBy: { eventDateTime: 'desc' }, take: 5000 }),
    ])

    const changes = auditLogs.map((log) => {
      const kind = classify(log.activityDisplayName, log.category); const details = targetDetails(log.targetResources)
      return { id: `audit:${log.id}`, eventType: 'change' as const, ts: log.eventDateTime.toISOString(), tenantId: log.customerTenantId, tenantName: names.get(log.customerTenantId) ?? 'Microsoft tenant', provider: 'Microsoft' as const, category: kind.category, severity: kind.severity, title: log.activityDisplayName, summary: [log.operationType, log.result, log.resultReason].filter(Boolean).join(' · ') || 'Microsoft directory change', actor: actorFrom(log.initiatedBy), target: details.target, source: 'Entra' as const, before: details.before, after: details.after, correlationId: log.correlationId ?? undefined, recoveryGuidance: guidance(kind.category) }
    })
    const signInEvents = signIns.map((log) => {
      const location = object(log.location); const device = object(log.deviceDetail)
      const failed = Boolean(log.statusErrorCode && log.statusErrorCode !== '0'); const risky = Boolean(log.riskLevel && !['none', 'hidden', 'unknown'].includes(log.riskLevel.toLowerCase()))
      return { id: `signin:${log.id}`, eventType: 'sign-in' as const, ts: log.eventDateTime.toISOString(), tenantId: log.customerTenantId, tenantName: names.get(log.customerTenantId) ?? 'Microsoft tenant', provider: 'Microsoft' as const, category: 'Sign-ins' as const, severity: risky ? 'High' as const : failed ? 'Medium' as const : 'Low' as const, title: failed ? 'Failed sign-in' : 'Successful sign-in', summary: [log.appDisplayName, log.failureReason, log.conditionalAccessStatus].filter(Boolean).join(' · ') || 'Microsoft sign-in activity', actor: log.userPrincipalName ?? log.userDisplayName ?? undefined, target: log.resourceDisplayName ?? log.appDisplayName ?? undefined, source: 'Entra' as const, ip: log.ipAddress ?? undefined, location: { city: text(location.city), region: text(location.state) ?? text(location.region), country: text(location.countryOrRegion) ?? text(location.country) }, client: { app: log.clientAppUsed ?? log.appDisplayName ?? undefined, device: text(device.displayName) ?? text(device.operatingSystem) }, before: {}, after: { result: failed ? 'Failed' : 'Success', riskLevel: log.riskLevel }, recoveryGuidance: risky || failed ? ['Confirm whether this sign-in was expected.', 'Revoke sessions and reset credentials if it was unauthorized.'] : [] }
    })
    const events = [...changes, ...signInEvents].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    return { changes: events, tenants: allTenants.map((tenant) => ({ id: tenant.id, name: names.get(tenant.id)! })), summary: { total: events.length, changes: changes.length, signIns: signInEvents.length, highRisk: events.filter((event) => event.severity === 'High').length, actors: new Set(events.map((event) => event.actor).filter(Boolean)).size }, range: { from: from.toISOString(), to: to.toISOString() } }
  }
}
