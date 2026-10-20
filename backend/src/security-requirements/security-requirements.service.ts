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
    const results = (selected?.checkIds ?? []).map((id) => CHECK_IDS.has(id)
      ? evaluateCheck(id as CheckId, evidence, now, selected?.checkSettings as CheckSettings ?? {})
      : {
          id, title: 'Unsupported saved check', service: 'Unsupported', recommendation: 'OPTIONAL', choiceGroup: null, source: 'HawkView baseline library', expected: 'A supported check definition',
          guidance: 'Edit this baseline and choose a currently offered check.', resourceType: null,
          outcome: 'UNABLE_TO_ASSESS' as const, observed: 'Unavailable', observedAt: null,
          reason: 'This saved check is no longer available in the current catalog.',
        })
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
