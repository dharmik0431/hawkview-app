import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { CHECKS, HAWKVIEW_STARTER, evaluateCheck, type CheckId, type EvidenceInput, type ResourceType } from './security-requirements-evaluator.js'
import { parseCheckSettings, type CheckSettings } from './security-requirements-settings.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHECK_IDS = new Set<string>(CHECKS.map((check) => check.id))
const RESOURCES: ResourceType[] = ['SHAREPOINT_SETTINGS', 'SECURITY_DEFAULTS', 'AUTH_METHOD_POLICIES', 'DOMAINS']

function validUuid(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid identifier.')
  return value
}

function pageInput(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) return 1
  return parsed
}

function searchInput(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 100)
}

function coverageStatusInput(value: unknown): 'ALL' | 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS' {
  if (value === undefined || value === 'ALL') return 'ALL'
  if (value === 'MET' || value === 'NEEDS_ACTION' || value === 'UNABLE_TO_ASSESS') return value
  throw new BadRequestException('Invalid baseline result filter.')
}

function parseBaseline(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Enter a baseline name and checks.')
  const input = body as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 2 || name.length > 100) throw new BadRequestException('Baseline name must be 2–100 characters.')
  if (!Array.isArray(input.checkIds) || input.checkIds.length < 1 || input.checkIds.length > CHECKS.length ||
      !input.checkIds.every((id) => typeof id === 'string' && CHECK_IDS.has(id)) ||
      new Set(input.checkIds).size !== input.checkIds.length) {
    throw new BadRequestException('Select one or more distinct offered checks.')
  }
  const selectedGroups = new Set<string>()
  for (const id of input.checkIds as CheckId[]) {
    const group = CHECKS.find((check) => check.id === id)?.choiceGroup
    if (!group) continue
    if (selectedGroups.has(group)) throw new BadRequestException('Choose only one requirement for each alternative setting.')
    selectedGroups.add(group)
  }
  let checkSettings: CheckSettings
  try { checkSettings = parseCheckSettings(input.checkSettings, input.checkIds as CheckId[]) }
  catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid check settings.') }
  return { name, checkIds: input.checkIds as CheckId[], checkSettings }
}

function expectedRevision(body: unknown): number {
  const revision = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).expectedRevision : undefined
  if (!Number.isInteger(revision) || (revision as number) < 1) {
    throw new BadRequestException('Reload the baseline before saving a new revision.')
  }
  return revision as number
}

@Injectable()
export class SecurityRequirementsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private evaluateSelected(checkIds: string[], checkSettings: unknown, evidence: Partial<Record<ResourceType, EvidenceInput>>, now: Date) {
    return checkIds.map((id) => CHECK_IDS.has(id)
      ? evaluateCheck(id as CheckId, evidence, now, checkSettings as CheckSettings ?? {})
      : {
          id, title: 'Unsupported saved check', service: 'Unsupported', recommendation: 'OPTIONAL', choiceGroup: null, source: 'HawkView baseline library', expected: 'A supported check definition',
          guidance: 'Edit this baseline and choose a currently offered check.', resourceType: null,
          outcome: 'UNABLE_TO_ASSESS' as const, observed: 'Unavailable', observedAt: null,
          reason: 'This saved check is no longer available in the current catalog.',
        })
  }

  private async workspace(identity: AuthenticatedIdentity, organizationId: string) {
    validUuid(organizationId)
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: { id: true, disabledAt: true, memberships: {
        where: { organizationId, status: 'ACTIVE', organization: { status: 'ACTIVE' }, role: { in: ['MSP_OWNER', 'MSP_ADMIN'] } },
        select: { organizationId: true },
      } },
    })
    if (!user || user.disabledAt || !user.memberships.length) throw new ForbiddenException('This account cannot manage policies in this workspace.')
    return user.id
  }

  async listLibrary(identity: AuthenticatedIdentity, organizationId: string, pageValue: unknown, searchValue: unknown) {
    await this.workspace(identity, organizationId)
    const page = pageInput(pageValue)
    const search = searchInput(searchValue)
    const where: Prisma.SecurityBaselineWhereInput = { organizationId, ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}) }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.securityBaseline.count({ where }),
      this.prisma.securityBaseline.findMany({
        where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 25, take: 25,
        select: { id: true, name: true, checkIds: true, revision: true, updatedAt: true, _count: { select: { assignments: true } } },
      }),
    ])
    return { items: items.map(({ _count, ...baseline }) => ({ ...baseline, assignedTenantCount: _count.assignments })), total, page, pageSize: 25, catalog: CHECKS, starter: HAWKVIEW_STARTER }
  }

  async getLibraryDetail(identity: AuthenticatedIdentity, organizationId: string, baselineId: string, pageValue: unknown, searchValue: unknown) {
    await this.workspace(identity, organizationId)
    validUuid(baselineId)
    const baseline = await this.prisma.securityBaseline.findFirst({
      where: { id: baselineId, organizationId },
      select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, createdAt: true, updatedAt: true, _count: { select: { assignments: true } } },
    })
    if (!baseline) throw new ForbiddenException('Baseline is not in this MSP workspace.')
    const page = pageInput(pageValue)
    const search = searchInput(searchValue)
    const where: Prisma.TenantSecurityBaselineAssignmentWhereInput = {
      baselineId, organizationId,
      ...(search ? { customerTenant: { OR: [
        { displayName: { contains: search, mode: 'insensitive' } },
        { primaryDomain: { contains: search, mode: 'insensitive' } },
      ] } } : {}),
    }
    const [matchingTenants, assignments, revisions] = await this.prisma.$transaction([
      this.prisma.tenantSecurityBaselineAssignment.count({ where }),
      this.prisma.tenantSecurityBaselineAssignment.findMany({
        where, orderBy: [{ assignedAt: 'desc' }, { customerTenantId: 'asc' }], skip: (page - 1) * 25, take: 25,
        select: { customerTenantId: true, assignedAt: true, customerTenant: { select: { displayName: true, primaryDomain: true, microsoftTenantId: true } } },
      }),
      this.prisma.securityBaselineRevision.findMany({ where: { organizationId, baselineId }, orderBy: { revision: 'desc' }, take: 10,
        select: { revision: true, createdAt: true, changedByUserId: true, name: true, checkIds: true, checkSettings: true } }),
    ])
    return {
      baseline: { id: baseline.id, name: baseline.name, checkIds: baseline.checkIds, checkSettings: baseline.checkSettings, revision: baseline.revision, createdAt: baseline.createdAt, updatedAt: baseline.updatedAt, assignedTenantCount: baseline._count.assignments },
      catalog: CHECKS,
      starter: HAWKVIEW_STARTER,
      checks: baseline.checkIds.map((id) => CHECKS.find((check) => check.id === id) ?? { id, title: 'Unsupported saved check', service: 'Unsupported', recommendation: 'OPTIONAL', choiceGroup: null, source: 'HawkView baseline library', expected: 'A supported check definition', guidance: 'Edit this baseline to choose a current check.', resourceType: null }),
      assignments: assignments.map((row) => ({ tenantId: row.customerTenantId, assignedAt: row.assignedAt, name: row.customerTenant.displayName || row.customerTenant.primaryDomain || 'Unnamed tenant', domain: row.customerTenant.primaryDomain, microsoftTenantId: row.customerTenant.microsoftTenantId })),
      matchingTenants, page, pageSize: 25, revisions,
    }
  }

  // A baseline is evaluated only when its overview is opened. Read the assigned
  // tenant set and its stored evidence in bounded batches, rather than issuing
  // one assessment request per tenant or evaluating every baseline on the list.
  async baselineCoverage(identity: AuthenticatedIdentity, organizationId: string, baselineId: string, pageValue: unknown, searchValue: unknown, statusValue: unknown) {
    await this.workspace(identity, organizationId)
    validUuid(baselineId)
    const page = pageInput(pageValue)
    const search = searchInput(searchValue).toLowerCase()
    const status = coverageStatusInput(statusValue)
    return this.prisma.$transaction(async (transaction) => {
      const baseline = await transaction.securityBaseline.findFirst({
        where: { id: baselineId, organizationId },
        select: { id: true, revision: true, checkIds: true, checkSettings: true },
      })
      if (!baseline) throw new ForbiddenException('Baseline is not in this MSP workspace.')
      const [assignments, workspaceTenantCount] = await Promise.all([
        transaction.tenantSecurityBaselineAssignment.findMany({
          where: { organizationId, baselineId },
          orderBy: { customerTenantId: 'asc' },
          select: { customerTenantId: true, assignedAt: true, customerTenant: { select: { displayName: true, primaryDomain: true } } },
        }),
        transaction.customerTenant.count({ where: { organizationId } }),
      ])
      const resources = Array.from(new Set(baseline.checkIds
        .map((id) => CHECKS.find((check) => check.id === id)?.resourceType)
        .filter((resource): resource is ResourceType => Boolean(resource))))
      const assessedAt = new Date()
      const checkImpact = new Map(baseline.checkIds.map((id) => [id, {
        id, title: CHECKS.find((check) => check.id === id)?.title ?? 'Unsupported saved check',
        met: 0, needsAction: 0, unableToAssess: 0,
      }]))
      const items: Array<{
        tenantId: string; name: string; domain: string | null; assignedAt: Date;
        outcome: 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS';
        met: number; needsAction: number; unableToAssess: number;
        attention: Array<{ id: string; title: string; outcome: 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS' }>
      }> = []
      for (let offset = 0; offset < assignments.length; offset += 100) {
        const batch = assignments.slice(offset, offset + 100)
        const tenantIds = batch.map((assignment) => assignment.customerTenantId)
        const [states, snapshots] = resources.length ? await Promise.all([
          transaction.syncState.findMany({
            where: { organizationId, customerTenantId: { in: tenantIds }, resourceType: { in: resources } },
            select: { customerTenantId: true, resourceType: true, status: true, lastErrorCode: true, lastAttemptAt: true, lastSuccessfulAt: true },
          }),
          transaction.tenantEntraSnapshot.findMany({
            where: { organizationId, customerTenantId: { in: tenantIds }, resourceType: { in: resources } },
            select: { customerTenantId: true, resourceType: true, observedAt: true, payload: true },
          }),
        ]) : [[], []]
        const evidenceByTenant = new Map<string, Partial<Record<ResourceType, EvidenceInput>>>()
        const snapshotByKey = new Map(snapshots.map((row) => [`${row.customerTenantId}:${row.resourceType}`, row]))
        for (const state of states) {
          const tenantEvidence = evidenceByTenant.get(state.customerTenantId) ?? {}
          const stored = snapshotByKey.get(`${state.customerTenantId}:${state.resourceType}`)
          tenantEvidence[state.resourceType as ResourceType] = {
            status: state.status, lastErrorCode: state.lastErrorCode,
            lastAttemptAt: state.lastAttemptAt, lastSuccessfulAt: state.lastSuccessfulAt,
            observedAt: stored?.observedAt, payload: stored?.payload,
          }
          evidenceByTenant.set(state.customerTenantId, tenantEvidence)
        }
        for (const assignment of batch) {
          const results = this.evaluateSelected(baseline.checkIds, baseline.checkSettings,
            evidenceByTenant.get(assignment.customerTenantId) ?? {}, assessedAt)
          const needsAction = results.filter((result) => result.outcome === 'NEEDS_ACTION')
          const unable = results.filter((result) => result.outcome === 'UNABLE_TO_ASSESS')
          for (const result of results) {
            const impact = checkImpact.get(result.id)
            if (!impact) continue
            if (result.outcome === 'MET') impact.met += 1
            else if (result.outcome === 'NEEDS_ACTION') impact.needsAction += 1
            else impact.unableToAssess += 1
          }
          items.push({
            tenantId: assignment.customerTenantId,
            name: assignment.customerTenant.displayName || assignment.customerTenant.primaryDomain || 'Unnamed tenant',
            domain: assignment.customerTenant.primaryDomain,
            assignedAt: assignment.assignedAt,
            outcome: needsAction.length ? 'NEEDS_ACTION' : unable.length ? 'UNABLE_TO_ASSESS' : 'MET',
            met: results.length - needsAction.length - unable.length,
            needsAction: needsAction.length,
            unableToAssess: unable.length,
            attention: [...needsAction, ...unable].map((result) => ({ id: result.id, title: result.title, outcome: result.outcome as 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS' })),
          })
        }
      }
      const counts = {
        assigned: assignments.length,
        met: items.filter((item) => item.outcome === 'MET').length,
        needsAction: items.filter((item) => item.outcome === 'NEEDS_ACTION').length,
        unableToAssess: items.filter((item) => item.outcome === 'UNABLE_TO_ASSESS').length,
        notApplied: Math.max(0, workspaceTenantCount - assignments.length),
      }
      const matching = items.filter((item) =>
        (status === 'ALL' || item.outcome === status) &&
        (!search || `${item.name} ${item.domain ?? ''}`.toLowerCase().includes(search)))
      const priority = { NEEDS_ACTION: 0, UNABLE_TO_ASSESS: 1, MET: 2 }
      matching.sort((a, b) => priority[a.outcome] - priority[b.outcome] ||
        a.name.localeCompare(b.name) || a.tenantId.localeCompare(b.tenantId))
      return {
        baselineId: baseline.id, revision: baseline.revision, counts,
        checkImpact: Array.from(checkImpact.values()).sort((a, b) =>
          b.needsAction - a.needsAction || b.unableToAssess - a.unableToAssess || a.title.localeCompare(b.title)),
        items: matching.slice((page - 1) * 25, page * 25), matchingTenants: matching.length,
        page, pageSize: 25, search, statusFilter: status, assessedAt: assessedAt.toISOString(),
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 })
  }

  async tenantChoices(identity: AuthenticatedIdentity, organizationId: string, pageValue: unknown, searchValue: unknown) {
    await this.workspace(identity, organizationId)
    const page = pageInput(pageValue)
    const search = searchInput(searchValue)
    const where: Prisma.CustomerTenantWhereInput = {
      organizationId,
      ...(search ? { OR: [
        { displayName: { contains: search, mode: 'insensitive' } },
        { primaryDomain: { contains: search, mode: 'insensitive' } },
      ] } : {}),
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.customerTenant.count({ where }),
      this.prisma.customerTenant.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: (page - 1) * 25, take: 25,
        select: { id: true, displayName: true, primaryDomain: true, securityBaselineAssignment: { select: { baselineId: true } } } }),
    ])
    return { items: items.map(({ securityBaselineAssignment, ...tenant }) => ({ ...tenant, baselineId: securityBaselineAssignment?.baselineId ?? null })), total, page, pageSize: 25 }
  }

  async createInWorkspace(identity: AuthenticatedIdentity, organizationId: string, body: unknown) {
    const userId = await this.workspace(identity, organizationId)
    const input = parseBaseline(body)
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const baseline = await transaction.securityBaseline.create({ data: { organizationId, createdByUserId: userId, ...input },
          select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, updatedAt: true } })
        await transaction.securityBaselineRevision.create({ data: { organizationId, baselineId: baseline.id, revision: 1,
          name: input.name, checkIds: input.checkIds, checkSettings: input.checkSettings, changedByUserId: userId } })
        return baseline
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A baseline with this name already exists in this MSP workspace.')
      throw error
    }
  }

  async updateInWorkspace(identity: AuthenticatedIdentity, organizationId: string, baselineId: string, body: unknown) {
    const userId = await this.workspace(identity, organizationId)
    validUuid(baselineId)
    const input = parseBaseline(body)
    const revision = expectedRevision(body)
    const existing = await this.prisma.securityBaseline.findFirst({ where: { id: baselineId, organizationId }, select: { id: true } })
    if (!existing) throw new ForbiddenException('Baseline is not in this MSP workspace.')
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.securityBaseline.updateMany({ where: { id: baselineId, organizationId, revision },
          data: { ...input, revision: { increment: 1 } } })
        if (changed.count !== 1) throw new ConflictException('This baseline changed. Reload it before saving.')
        await transaction.securityBaselineRevision.create({ data: { organizationId, baselineId, revision: revision + 1,
          name: input.name, checkIds: input.checkIds, checkSettings: input.checkSettings, changedByUserId: userId } })
        return transaction.securityBaseline.findUniqueOrThrow({ where: { id_organizationId: { id: baselineId, organizationId } },
          select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, updatedAt: true } })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A baseline with this name already exists in this MSP workspace.')
      throw error
    }
  }

  async assignFromLibrary(identity: AuthenticatedIdentity, organizationId: string, baselineId: string, tenantId: string) {
    await this.workspace(identity, organizationId)
    validUuid(baselineId)
    validUuid(tenantId)
    const [baseline, tenant] = await Promise.all([
      this.prisma.securityBaseline.findFirst({ where: { id: baselineId, organizationId }, select: { id: true } }),
      this.prisma.customerTenant.findFirst({ where: { id: tenantId, organizationId }, select: { id: true } }),
    ])
    if (!baseline || !tenant) throw new ForbiddenException('Baseline and tenant must belong to this MSP workspace.')
    return this.assign(identity, tenantId, { baselineId })
  }

  private async scope(identity: AuthenticatedIdentity, tenantId: string, manage: boolean) {
    validUuid(tenantId)
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        id: true, disabledAt: true,
        memberships: {
          where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } },
          select: { organizationId: true, role: true },
        },
      },
    })
    if (!user || user.disabledAt) throw new ForbiddenException('This account cannot access tenants.')
    const allowed = user.memberships.filter((membership) => !manage ||
      membership.role === 'MSP_OWNER' || membership.role === 'MSP_ADMIN')
    const tenant = await this.prisma.customerTenant.findFirst({
      where: { id: tenantId, organizationId: { in: allowed.map((membership) => membership.organizationId) } },
      select: { id: true, organizationId: true, displayName: true, primaryDomain: true },
    })
    if (!tenant) throw new ForbiddenException('This account cannot access this tenant or action.')
    return { userId: user.id, tenant, canManage: user.memberships.some((membership) => membership.organizationId === tenant.organizationId && (membership.role === 'MSP_OWNER' || membership.role === 'MSP_ADMIN')) }
  }

  async get(identity: AuthenticatedIdentity, tenantId: string) {
    const { tenant, canManage } = await this.scope(identity, tenantId, true)
    const snapshot = await this.prisma.$transaction(async (transaction) => {
      const [baselines, assignment, states, snapshots] = await Promise.all([
        transaction.securityBaseline.findMany({ where: { organizationId: tenant.organizationId }, orderBy: { name: 'asc' }, select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, updatedAt: true } }),
        transaction.tenantSecurityBaselineAssignment.findUnique({ where: { customerTenantId: tenant.id }, select: { baselineId: true, assignedAt: true } }),
        transaction.syncState.findMany({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: { in: RESOURCES } }, select: { resourceType: true, status: true, lastErrorCode: true, lastAttemptAt: true, lastSuccessfulAt: true } }),
        transaction.tenantEntraSnapshot.findMany({ where: { organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: { in: RESOURCES } }, select: { resourceType: true, observedAt: true, payload: true } }),
      ])
      return { baselines, assignment, states, snapshots }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    const selected = snapshot.baselines.find((baseline) => baseline.id === snapshot.assignment?.baselineId) ?? null
    const evidence: Partial<Record<ResourceType, EvidenceInput>> = {}
    for (const resourceType of RESOURCES) {
      const state = snapshot.states.find((row) => row.resourceType === resourceType)
      const stored = snapshot.snapshots.find((row) => row.resourceType === resourceType)
      if (state) evidence[resourceType] = {
        status: state.status,
        lastErrorCode: state.lastErrorCode,
        lastAttemptAt: state.lastAttemptAt,
        lastSuccessfulAt: state.lastSuccessfulAt,
        observedAt: stored?.observedAt,
        payload: stored?.payload,
      }
    }
    const now = new Date()
    const results = this.evaluateSelected(selected?.checkIds ?? [], selected?.checkSettings, evidence, now)
    const summary = {
      selected: results.length,
      met: results.filter((result) => result.outcome === 'MET').length,
      needsAction: results.filter((result) => result.outcome === 'NEEDS_ACTION').length,
      unableToAssess: results.filter((result) => result.outcome === 'UNABLE_TO_ASSESS').length,
    }
    return {
      tenantId: tenant.id,
      tenantName: tenant.displayName || tenant.primaryDomain || 'Unnamed tenant',
      tenantDomain: tenant.primaryDomain,
      catalog: CHECKS,
      starter: HAWKVIEW_STARTER,
      baselines: snapshot.baselines,
      assignment: selected ? { baselineId: selected.id, assignedAt: snapshot.assignment!.assignedAt } : null,
      results,
      summary,
      assessedAt: now.toISOString(),
      canManage,
      evidenceNote: 'Stored Microsoft configuration only. A result does not change the tenant, prove a complete sync, or verify settings outside the selected checks.',
    }
  }

  async create(identity: AuthenticatedIdentity, tenantId: string, body: unknown) {
    const { userId, tenant } = await this.scope(identity, tenantId, true)
    const input = parseBaseline(body)
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const baseline = await transaction.securityBaseline.create({ data: { organizationId: tenant.organizationId, createdByUserId: userId, ...input },
          select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, updatedAt: true } })
        await transaction.securityBaselineRevision.create({ data: { organizationId: tenant.organizationId, baselineId: baseline.id,
          revision: 1, name: input.name, checkIds: input.checkIds, checkSettings: input.checkSettings, changedByUserId: userId } })
        return baseline
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A baseline with this name already exists in this MSP workspace.')
      throw error
    }
  }

  async update(identity: AuthenticatedIdentity, tenantId: string, baselineId: string, body: unknown) {
    const { userId, tenant } = await this.scope(identity, tenantId, true)
    validUuid(baselineId)
    const input = parseBaseline(body)
    const revision = expectedRevision(body)
    const existing = await this.prisma.securityBaseline.findFirst({ where: { id: baselineId, organizationId: tenant.organizationId }, select: { id: true } })
    if (!existing) throw new ForbiddenException('Baseline is not in this MSP workspace.')
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.securityBaseline.updateMany({ where: { id: baselineId, organizationId: tenant.organizationId, revision },
          data: { ...input, revision: { increment: 1 } } })
        if (changed.count !== 1) throw new ConflictException('This baseline changed. Reload it before saving.')
        await transaction.securityBaselineRevision.create({ data: { organizationId: tenant.organizationId, baselineId,
          revision: revision + 1, name: input.name, checkIds: input.checkIds, checkSettings: input.checkSettings, changedByUserId: userId } })
        return transaction.securityBaseline.findUniqueOrThrow({ where: { id_organizationId: { id: baselineId, organizationId: tenant.organizationId } },
          select: { id: true, name: true, checkIds: true, checkSettings: true, revision: true, updatedAt: true } })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A baseline with this name already exists in this MSP workspace.')
      throw error
    }
  }

  async assign(identity: AuthenticatedIdentity, tenantId: string, body: unknown) {
    const { userId, tenant } = await this.scope(identity, tenantId, true)
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    if (!input || !(input.baselineId === null || typeof input.baselineId === 'string')) throw new BadRequestException('Select a baseline or clear the assignment.')
    if (input.baselineId === null) {
      await this.prisma.tenantSecurityBaselineAssignment.deleteMany({ where: { customerTenantId: tenant.id, organizationId: tenant.organizationId } })
      return { baselineId: null }
    }
    const baselineId = validUuid(input.baselineId)
    const baseline = await this.prisma.securityBaseline.findFirst({ where: { id: baselineId, organizationId: tenant.organizationId }, select: { id: true } })
    if (!baseline) throw new ForbiddenException('Baseline is not in this MSP workspace.')
    await this.prisma.tenantSecurityBaselineAssignment.upsert({
      where: { customerTenantId: tenant.id },
      create: { customerTenantId: tenant.id, organizationId: tenant.organizationId, baselineId, assignedByUserId: userId },
      update: { baselineId, assignedByUserId: userId, assignedAt: new Date() },
    })
    return { baselineId }
  }
}
