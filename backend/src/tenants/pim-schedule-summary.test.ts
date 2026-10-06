import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { TenantsService } from './tenants.service.js'
import { TenantsController } from './tenants.controller.js'
import { IdentityAuthGuard } from '../auth/identity-auth.guard.js'
import { PUBLIC_ROUTE_KEY } from '../auth/public.decorator.js'
import { PimDatabaseDouble, testTenant, alternateId } from './pim-schedule-test-double.js'
import { collectAndReadPimSchedule, type PimCollectionRequest } from './pim-schedule-orchestration.js'
import type { PimLimits, PimPlane } from './pim-schedule-contract.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'

const SUBJECT = 'injected-auth-subject'
const identity = { subject: SUBJECT, email: 'injected@example.test' } as AuthenticatedIdentity
const limits: PimLimits = { pages: 5, rows: 20, pageBytes: 5000, materializedBytes: 50000,
  requestTimeoutMs: 1000, collectorDeadlineMs: 4000, wireBytes: 20000, requests: 8,
  retryAttempts: 1, retryDelayMs: 1, maxConflictVersions: 4, maxConflictEvidenceBytes: 5000 }

type Membership = { organizationId: string; status: string; organizationStatus: string }
const activeMembership = (organizationId: string): Membership =>
  ({ organizationId, status: 'ACTIVE', organizationStatus: 'ACTIVE' })

/** Minimal Prisma surface the service uses. The membership select HONOURS the real query filters —
 * it applies args.select.memberships.where rather than returning a prefiltered list — so an inactive
 * membership or inactive organization is excluded by the same predicate production relies on. */
function prismaFor(db: PimDatabaseDouble, options: {
  user?: { disabledAt: Date | null; memberships: Membership[] } | null
  tenantOrganizationId?: string
} = {}) {
  const user = options.user === undefined
    ? { disabledAt: null, memberships: [activeMembership(testTenant.organizationId)] }
    : options.user
  const tenantOrg = options.tenantOrganizationId ?? testTenant.organizationId
  const calls: string[] = []
  const filters: unknown[] = []
  return {
    calls,
    filters,
    user: {
      findUnique: async (args: any) => {
        calls.push('user.findUnique')
        assert.equal(args.where.authProviderUserId, SUBJECT, 'must look the user up by the VERIFIED subject')
        if (user === null) return null
        const where = args.select.memberships.where
        filters.push(where)
        const memberships = user.memberships.filter(m =>
          m.status === where.status && m.organizationStatus === where.organization.status)
        return { disabledAt: user.disabledAt, memberships: memberships.map(m => ({ organizationId: m.organizationId })) }
      },
    },
    customerTenant: {
      findFirst: async (args: any) => {
        calls.push('customerTenant.findFirst')
        const wanted: string[] | undefined = args.where.organizationId?.in
        if (args.where.id !== testTenant.customerTenantId) return null
        if (wanted !== undefined && !wanted.includes(tenantOrg)) return null
        return { id: testTenant.customerTenantId, organizationId: tenantOrg }
      },
    },
    $transaction: (work: any) => { calls.push('$transaction'); return db.$transaction(work) },
  } as any
}

const serviceFor = (prisma: any) => new TenantsService(prisma, {} as any, {} as any)
const summary = (db: PimDatabaseDouble, prisma = prismaFor(db), plane: PimPlane = 'ACTIVE', tenantId = testTenant.customerTenantId) =>
  serviceFor(prisma).getPimScheduleSummaryForIdentity(identity, tenantId, plane)

async function seeded(db: PimDatabaseDouble, value: unknown[] = [{ id: 'prior' }], plane: PimPlane = 'ACTIVE') {
  const request: PimCollectionRequest = { ...testTenant, plane, scopeVersion: 'injected-pim-v1',
    attemptLifetimeMs: 10000, limits: { ...limits } }
  const r = await collectAndReadPimSchedule(request, {
    db,
    authorization: { subjectId: SUBJECT, organizationId: testTenant.organizationId,
      tenantMemberships: new Set([testTenant.customerTenantId]) },
    transport: {
      token: async () => 'injected-token',
      fetchPage: async () => new Response(JSON.stringify({ value }),
        { status: 200, headers: { 'content-type': 'application/json' } }),
    },
  })
  assert.equal(r.collection.status, 'committed')
  return r
}

test('observed ACTIVE summary exposes only the bounded contract fields', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const result: any = await summary(db)
  assert.equal(result.responseVersion, 'pim-schedule-summary/v1')
  assert.equal(result.plane, 'ACTIVE')
  assert.equal(result.status, 'observed')
  assert.deepEqual(Object.keys(result).sort(), ['lastCommitted', 'plane', 'responseVersion', 'status'])
  assert.equal('failureKind' in result, false)
  assert.deepEqual(Object.keys(result.lastCommitted).sort(), ['ageMs', 'assurance', 'attemptId',
    'committedAt', 'contentChangedAt', 'contentDigest', 'coverage', 'observedRecordCount',
    'scopeVersion', 'traversalOutcome'].sort())
  assert.equal(result.lastCommitted.observedRecordCount, 1)
  assert.equal(result.lastCommitted.assurance, 'UNKNOWN')
  assert.equal(result.lastCommitted.coverage, 'NOT_ESTABLISHED')
  const wire = JSON.stringify(result)
  for (const forbidden of ['microsoftTenantId', 'configurationRevision', 'connectionIncarnation',
    'scopeId', 'scopeIncarnation', 'endpointDescriptor', 'projectionIdentity', 'rows', 'envelope',
    'requestedToken', 'credentialReference', 'clientId']) {
    assert.equal(wire.includes(forbidden), false, 'must not leak ' + forbidden)
  }
  assert.equal(wire.includes(testTenant.microsoftTenantId), false)
})

test('never-collected stays distinct from an observed attempt that saw zero records', async () => {
  const never: any = await summary(new PimDatabaseDouble())
  assert.equal(never.status, 'never-collected')
  assert.equal(never.lastCommitted, null)
  const zero = new PimDatabaseDouble()
  await seeded(zero, [])
  const observedEmpty: any = await summary(zero)
  assert.equal(observedEmpty.status, 'observed')
  assert.equal(observedEmpty.lastCommitted.observedRecordCount, 0)
})

test('a committed ELIGIBLE observation is summarised on its own plane', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db, [{ id: 'eligible-holder' }], 'ELIGIBLE')
  const eligible: any = await summary(db, prismaFor(db), 'ELIGIBLE')
  assert.equal(eligible.plane, 'ELIGIBLE')
  assert.equal(eligible.status, 'observed')
  assert.equal(eligible.lastCommitted.observedRecordCount, 1)
  // ACTIVE was never collected in this database, so the planes do not borrow each other's data.
  const active: any = await summary(db, prismaFor(db), 'ACTIVE')
  assert.equal(active.status, 'never-collected')
  assert.equal(active.lastCommitted, null)
})

test('a later failure keeps the earlier committed clocks and never claims fresh success', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const before: any = await summary(db)
  const failing = db.attempts[0]
  db.attempts.push({ ...failing, id: 'injected-later-attempt', is_current: false, outcome: 'FAILED',
    failure_kind: 'PROVIDER_FAILED', traversal_outcome: 'ERRORED', started_at: new Date(db.now + 1000) } as any)
  const after: any = await summary(db)
  assert.equal(after.status, 'last-attempt-failed')
  assert.equal(after.failureKind, 'PROVIDER_FAILED')
  assert.equal(after.lastCommitted.attemptId, before.lastCommitted.attemptId)
  assert.equal(after.lastCommitted.committedAt, before.lastCommitted.committedAt)
  assert.equal(after.lastCommitted.contentChangedAt, before.lastCommitted.contentChangedAt)
})

test('the tenant identifier contract matches pimUuid, including versions 6 to 8', async () => {
  const db = new PimDatabaseDouble()
  // A base distinct from testTenant's own ids, so a version collision cannot mask the check.
  // Versions 1-8 are all accepted by the canonical contract; v7 is the case the previous
  // HTTP-boundary regex wrongly rejected before any authorized lookup.
  for (const version of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    const id = `aaaaaaaa-bbbb-${version}ccc-8ddd-eeeeeeeeeeee`
    const prisma = prismaFor(db)
    // Accepted by validation: it reaches the database rather than being refused as malformed.
    await assert.rejects(serviceFor(prisma).getPimScheduleSummaryForIdentity(identity, id, 'ACTIVE'),
      NotFoundException, `version ${version} must pass validation and be refused only by authorization`)
    assert.ok(prisma.calls.includes('user.findUnique'), `version ${version} must reach the database`)
  }
  // Uppercase is normalised rather than rejected.
  const upper = prismaFor(db)
  await assert.rejects(serviceFor(upper).getPimScheduleSummaryForIdentity(
    identity, 'AAAAAAAA-BBBB-7CCC-8DDD-EEEEEEEEEEEE', 'ACTIVE'), NotFoundException)

  for (const invalid of ['not-a-uuid', '', 'aaaaaaaa-bbbb-0ccc-8ddd-eeeeeeeeeeee',
    'aaaaaaaa-bbbb-9ccc-8ddd-eeeeeeeeeeee', 'aaaaaaaa-bbbb-7ccc-cddd-eeeeeeeeeeee',
    'aaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee']) {
    const prisma = prismaFor(db)
    await assert.rejects(serviceFor(prisma).getPimScheduleSummaryForIdentity(identity, invalid, 'ACTIVE'),
      BadRequestException, `${JSON.stringify(invalid)} must be refused as malformed`)
    assert.deepEqual(prisma.calls, [], 'a malformed identifier must not reach the database')
  }
})

test('invalid plane is refused before any database call', async () => {
  const db = new PimDatabaseDouble()
  const prisma = prismaFor(db)
  await assert.rejects(summary(db, prisma, 'DIRECTORY_ROLES' as PimPlane), BadRequestException)
  assert.deepEqual(prisma.calls, [])
  assert.deepEqual(db.operations, [])
})

test('unknown, disabled, inactive-membership and inactive-organization accounts are all refused before the PIM read', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  db.operations.length = 0

  const unknown = prismaFor(db, { user: null })
  await assert.rejects(summary(db, unknown), ForbiddenException)
  assert.deepEqual(unknown.calls, ['user.findUnique'])

  const disabled = prismaFor(db, { user: { disabledAt: new Date(), memberships: [activeMembership(testTenant.organizationId)] } })
  await assert.rejects(summary(db, disabled), ForbiddenException)
  assert.deepEqual(disabled.calls, ['user.findUnique'])

  // The membership exists but is not ACTIVE: the production filter must exclude it.
  const inactiveMembership = prismaFor(db, { user: { disabledAt: null,
    memberships: [{ organizationId: testTenant.organizationId, status: 'SUSPENDED', organizationStatus: 'ACTIVE' }] } })
  await assert.rejects(summary(db, inactiveMembership), NotFoundException)
  assert.deepEqual(inactiveMembership.calls, ['user.findUnique'], 'no tenant lookup without an active membership')

  // The membership is ACTIVE but its organization is not.
  const inactiveOrganization = prismaFor(db, { user: { disabledAt: null,
    memberships: [{ organizationId: testTenant.organizationId, status: 'ACTIVE', organizationStatus: 'SUSPENDED' }] } })
  await assert.rejects(summary(db, inactiveOrganization), NotFoundException)
  assert.deepEqual(inactiveOrganization.calls, ['user.findUnique'])

  // The fixture genuinely applied the production predicates rather than pre-filtering.
  assert.deepEqual(inactiveOrganization.filters[0], { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
  assert.equal(db.operations.includes('read'), false, 'no PIM read for any refused account')
})

test('a tenant outside the caller organizations is a nondisclosing 404 and never reaches the reader', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  db.operations.length = 0
  const crossOrg = prismaFor(db, { user: { disabledAt: null, memberships: [activeMembership(alternateId)] } })
  await assert.rejects(summary(db, crossOrg), NotFoundException)
  assert.deepEqual(crossOrg.calls, ['user.findUnique', 'customerTenant.findFirst'])
  assert.equal(db.operations.includes('read'), false)
})

test('the organization bound into the reader statement is the database row, not a caller value', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const bound: unknown[][] = []
  db.hook = (operation, values) => { if (operation === 'read') bound.push(values as unknown[]) }
  // DISCRIMINATING FIXTURE: the caller holds two memberships and the tenant's organization is the
  // SECOND. Binding organizationIds[0] - or any caller-derived value - sends the wrong organization.
  const prisma = prismaFor(db, {
    user: { disabledAt: null, memberships: [activeMembership(alternateId), activeMembership(testTenant.organizationId)] },
    tenantOrganizationId: testTenant.organizationId,
  })
  const result: any = await summary(db, prisma)
  assert.notEqual(testTenant.organizationId, alternateId, 'the fixture must actually separate the two')
  assert.equal(result.status, 'observed')
  assert.equal(bound.length, 1)
  assert.equal(bound[0][0], testTenant.customerTenantId)
  assert.equal(bound[0][1], testTenant.organizationId)
  assert.equal(bound[0][2], 'ACTIVE')
  db.hook = null
})

test('the real controller forwards the trusted identity through the real service into the reader', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const bound: unknown[][] = []
  db.hook = (operation, values) => { if (operation === 'read') bound.push(values as unknown[]) }

  const prisma = prismaFor(db)
  const controller = new TenantsController(serviceFor(prisma), {} as any)
  const headers: Record<string, string> = {}
  const response = { setHeader: (k: string, v: string) => { headers[k] = v } }

  const result: any = await controller.getPimScheduleSummary(
    { auth: identity } as any, testTenant.customerTenantId, 'ELIGIBLE', response as any)

  // Real controller -> real TenantsService -> real readPimSchedulePlane, no stubbed service.
  assert.deepEqual(prisma.calls, ['user.findUnique', 'customerTenant.findFirst', '$transaction'])
  assert.equal(headers['Cache-Control'], 'no-store')
  // The plane the caller asked for was forwarded, not defaulted.
  assert.equal(result.plane, 'ELIGIBLE')
  assert.equal(result.status, 'never-collected')
  assert.equal(bound.length, 1, 'the PIM statement ran exactly once')
  assert.equal(bound[0][0], testTenant.customerTenantId)
  assert.equal(bound[0][1], testTenant.organizationId)
  assert.equal(bound[0][2], 'ELIGIBLE')
  db.hook = null
})

test('the real guard refuses a request carrying no bearer identity', async () => {
  const verifier = { verify: async () => { throw new Error('verifier must not run without a bearer token') } }
  const guard = new IdentityAuthGuard(new Reflector(), verifier as any)
  const request: any = { headers: {} }
  const context: any = {
    getHandler: () => TenantsController.prototype.getPimScheduleSummary,
    getClass: () => TenantsController,
    switchToHttp: () => ({ getRequest: () => request }),
  }
  await assert.rejects(guard.canActivate(context), UnauthorizedException)
  assert.equal('auth' in request, false, 'no identity may be attached to an unauthenticated request')
})

test('route metadata is authenticated, correctly pathed and no-store', () => {
  const handler = TenantsController.prototype.getPimScheduleSummary
  assert.equal(Reflect.getMetadata('path', handler), ':id/pim/schedules/:plane/summary')
  assert.equal(Reflect.getMetadata('method', handler), 0, 'RequestMethod.GET')
  assert.equal(Reflect.getMetadata(PUBLIC_ROUTE_KEY, handler), undefined)
  assert.equal(Reflect.getMetadata(PUBLIC_ROUTE_KEY, TenantsController), undefined)
})
