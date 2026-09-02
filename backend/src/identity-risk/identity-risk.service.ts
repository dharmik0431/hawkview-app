import { ForbiddenException, Injectable } from '@nestjs/common'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'

const MODE = () => process.env.HAWKVIEW_IDENTITY_RISK_MODE === 'shadow' ? 'SHADOW' : 'OFF'
const asArray = (value: unknown) => Array.isArray(value) ? value : []
const cap = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const titles: Record<string, string> = Object.freeze({ 'HV-ID-CHG-001': 'New identity received a privileged role', 'HV-ID-MBX-001': 'External mailbox forwarding requires investigation' })
const guidance: Record<string, readonly [string, string]> = Object.freeze({ 'HV-ID-CHG-001': ['REVIEW_ACCESS', 'Review the identity, role assignment, and related authorized change evidence.'], 'HV-ID-MBX-001': ['REVIEW_MAILBOX_RULE', 'Review the mailbox rule and confirm the destination is authorized.'] })

@Injectable()
export class IdentityRiskService {
  constructor(private readonly prisma: PrismaService) {}

  private async scope(identity: AuthenticatedIdentity, tenantId: string) {
    const user = await this.prisma.user.findUnique({ where: { authProviderUserId: identity.subject }, select: { memberships: { where: { status: 'ACTIVE' }, select: { organizationId: true } } } })
    const organizationIds = user?.memberships.map((membership) => membership.organizationId) ?? []
    const tenant = await this.prisma.customerTenant.findFirst({ where: { id: tenantId, organizationId: { in: organizationIds } }, select: { id: true, organizationId: true } })
    if (!tenant) throw new ForbiddenException('Tenant access denied')
    return tenant
  }

  async summary(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    if (MODE() === 'OFF') return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', mode: 'OFF', capability: 'UNAVAILABLE', status: 'UNAVAILABLE', sourceLabel: 'HawkView Identity Signals', observedAt: null, freshness: 'UNKNOWN', limitation: 'Identity signals are not enabled.', findings: 0 }
    const db = this.prisma as any
    const run = await db.identityRiskEvaluationRun?.findFirst?.({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, status: 'COMPLETED', expiresAt: { gt: new Date() } }, orderBy: { completedAt: 'desc' } })
    if (!run) return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', mode: 'SHADOW', capability: 'UNAVAILABLE', status: 'NOT_EVALUATED', sourceLabel: 'HawkView Identity Signals', observedAt: null, freshness: 'UNKNOWN', limitation: 'No completed shadow evaluation is available.', findings: 0 }
    const findings = await db.identityRiskFinding.count({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, state: 'OPEN', expiresAt: { gt: new Date() } } })
    return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', mode: 'SHADOW', capability: 'PARTIAL', status: 'AVAILABLE', sourceLabel: 'HawkView Identity Signals', observedAt: run.completedAt?.toISOString() ?? null, freshness: 'CURRENT', limitation: 'Shadow-mode investigation leads; not compromise verdicts.', aggregate: run.aggregate, findings }
  }

  async findings(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    if (MODE() === 'OFF') return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', mode: 'OFF', capability: 'UNAVAILABLE', status: 'UNAVAILABLE', sourceLabel: 'HawkView Identity Signals', observedAt: null, freshness: 'UNKNOWN', limitation: 'Identity signals are not enabled.', findings: [] }
    const db = this.prisma as any
    const rows = await db.identityRiskFinding.findMany({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, expiresAt: { gt: new Date() } }, orderBy: { observedAt: 'desc' }, take: 100 })
    return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', mode: 'SHADOW', capability: 'PARTIAL', status: 'AVAILABLE', sourceLabel: 'HawkView Identity Signals', observedAt: null, freshness: 'UNKNOWN', limitation: 'Shadow-mode investigation leads; not compromise verdicts.', findings: rows.map((row: any) => {
      const title = titles[row.ruleId] ?? 'Identity signal requires investigation'
      const guide = guidance[row.ruleId] ?? (['REVIEW_ACTIVITY', 'Review the bounded source evidence with an authorized administrator.'] as const)
      return { id: row.id, state: ['OPEN','UPDATED','RESOLVED','EXPIRED'].includes(row.state) ? row.state : 'OPEN', severity: ['LOW','MEDIUM','HIGH','CRITICAL'].includes(row.severity) ? row.severity : 'LOW', confidence: ['LOW','MEDIUM','HIGH'].includes(row.confidence) ? row.confidence : 'LOW', coverage: ['FULL','PARTIAL','UNAVAILABLE'].includes(row.coverage) ? row.coverage : 'UNAVAILABLE', title, affectedIdentity: { id: cap(row.subjectId, 128), label: 'Tenant identity', type: ['USER','MAILBOX','APPLICATION'].includes(row.subjectType) ? row.subjectType : 'UNKNOWN' }, investigationGuidanceCode: guide[0], investigationGuidance: guide[1], benignAlternativeCodes: [], sourceLabels: [], missingEvidenceLabels: [], observedAt: row.observedAt.toISOString(), ruleIds: [cap(row.ruleId, 150)] }
    }) }
  }

  async microsoftRiskyUsers(identity: AuthenticatedIdentity, tenantId: string) {
    const tenant = await this.scope(identity, tenantId)
    const snapshot = await this.prisma.tenantEntraSnapshot.findFirst({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: 'RISKY_USERS' }, select: { payload: true, observedAt: true } })
    if (!snapshot || !Array.isArray(snapshot.payload)) return { version: 1, channel: 'MICROSOFT_ENTRA_RISKY_USERS', capability: 'UNAVAILABLE', status: 'UNAVAILABLE', sourceLabel: 'Microsoft Entra Risky Users', observedAt: null, freshness: 'UNKNOWN', limitation: 'Current Microsoft Identity Protection evidence is unavailable.', users: [] }
    return { version: 1, channel: 'MICROSOFT_ENTRA_RISKY_USERS', capability: 'FULL', status: 'AVAILABLE', sourceLabel: 'Microsoft Entra Risky Users', observedAt: snapshot.observedAt.toISOString(), freshness: 'CURRENT', limitation: null, users: asArray(snapshot.payload).map((row: any) => ({ id: row.id, identityLabel: row.userPrincipalName, riskLevel: row.riskLevel, riskState: row.riskState, riskDetail: row.riskDetail, observedAt: row.riskLastUpdatedDateTime ?? snapshot.observedAt.toISOString() })) }
  }
}
