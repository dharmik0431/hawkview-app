import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { BadGatewayException } from '@nestjs/common'
import { deriveCollectionReadiness } from './collection-readiness.js'
import {
  CollectionInitializingError,
  CollectionPartialError,
  MicrosoftGraphCollectionError,
  LIMITED_SIGN_IN_ENRICHMENT_LIMITS,
  TenantSyncService,
} from './tenant-sync.service.js'

const inferredLocation = { city: 'Synthetic', state: null, countryOrRegion: 'ZZ', geoCoordinates: { latitude: 1, longitude: 2 }, source: 'MAXMIND_GEOLITE2' }
const historyId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
function locationFixture(count = 6) {
  const history = Array.from({ length: count }, (_, index) => ({ id: historyId(index + 1), organizationId: 'org-1', customerTenantId: 'tenant-1', ipAddress: '192.0.2.1', location: null as any, expiresAt: new Date(Date.now() + 60000) }))
  const observations = { takes: [] as number[], cursors: [] as string[], timeouts: [] as number[], starts: [] as any[], creates: 0, updates: 0, active: 0, maximum: 0, lookups: 0, lookupActive: 0, maximumLookups: 0, states: [] as any[], resolved: 0, incidents: 0, logs: [] as string[], failStatement: false, stallStatement: false }
  const prisma: any = {
    syncState: { upsert: async (args: any) => { observations.starts.push(args); return { lastSuccessfulAt: new Date('2026-01-01') } }, update: async ({ data }: any) => { observations.states.push(data); return { consecutiveFailures: 1 } } },
    signInLog: { findFirst: async () => null, createMany: async ({ data }: any) => { observations.creates += data.length }, deleteMany: async () => undefined, findMany: async () => { throw new Error('Unbounded read forbidden') }, update: async () => { throw new Error('Unscoped update forbidden') } },
    $transaction: async (work: (transaction: any) => Promise<unknown>, options: any) => {
      assert.ok(options.maxWait > 0 && options.maxWait <= 1000); assert.ok(options.timeout > 0)
      const pending: Array<() => void> = []
      const result = await work({
        $queryRaw: async (query: any) => {
          const text = query.strings.join('?')
          if (text.includes('set_config')) {
            assert.match(text, /set_config\('statement_timeout', \?, true\)/)
            observations.timeouts.push(Number(query.values[0])); return []
          }
          assert.match(text, /organization_id = \?::uuid AND customer_tenant_id = \?::uuid/)
          assert.match(text, /expires_at > \?/); assert.match(text, /ORDER BY id ASC LIMIT \?/)
          assert.match(text, /octet_length/); assert.match(text, /NOT COALESCE\(location->>'source'/)
          if (observations.stallStatement) await new Promise((_, reject) => setTimeout(() => reject(new Error('canceling statement due to statement timeout')), 5))
          if (observations.failStatement) throw new Error('private database URL and token')
          const [byteLimit, , org, tenant, expiresAfter] = query.values
          const cursor = query.values.at(-2); const take = query.values.at(-1)
          observations.takes.push(take); observations.cursors.push(cursor)
          return history.filter(row => row.organizationId === org && row.customerTenantId === tenant && row.expiresAt > expiresAfter && row.id > cursor && row.location?.source !== 'MAXMIND_GEOLITE2').slice(0, take).map(row => {
            const locationOversized = row.location !== null && Buffer.byteLength(JSON.stringify(row.location)) > byteLimit
            return { id: row.id, ipAddress: row.ipAddress, location: locationOversized ? null : row.location, locationOversized }
          })
        },
        signInLog: { updateMany: async ({ where, data }: any) => {
          assert.equal(where.organizationId, 'org-1'); assert.equal(where.customerTenantId, 'tenant-1'); assert.ok(where.expiresAt.gt instanceof Date); assert.ok(where.location)
          observations.active++; observations.maximum = Math.max(observations.maximum, observations.active)
          await new Promise<void>(resolve => setImmediate(resolve)); observations.active--
          const row = history.find(row => row.id === where.id && row.organizationId === where.organizationId && row.customerTenantId === where.customerTenantId && row.expiresAt > where.expiresAt.gt)
          if (!row) return { count: 0 }
          pending.push(() => { row.location = data.location; observations.updates++ })
          return { count: 1 }
        } },
      })
      pending.forEach(commit => commit())
      return result
    },
  }
  const service = new TenantSyncService(prisma, {} as any, { lookup: async () => {
    observations.lookups++; observations.lookupActive++; observations.maximumLookups = Math.max(observations.maximumLookups, observations.lookupActive)
    await new Promise<void>(resolve => setImmediate(resolve)); observations.lookupActive--; return inferredLocation
  } } as any, { resolveIncident: async () => { observations.resolved++ }, publishIncident: async () => { observations.incidents++ } } as any, { pruneExpired: async () => undefined } as any, {} as any)
  ;(service as any).logger = { log: (line: string) => observations.logs.push(line), warn: (line: string) => observations.logs.push(line) }
  ;(service as any).signInEntitlement = async () => 'NON_PREMIUM'
  ;(service as any).fetchGraphCollection = async () => { throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant') }
  ;(service as any).fetchLimitedLoginActivity = async () => [{ id: 'new', createdDateTime: new Date().toISOString(), ipAddress: '192.0.2.1', status: { errorCode: 0 } }]
  return { service, history, observations }
}

test('real nonpremium sync pages scoped history, resumes committed work and reports optional incompleteness honestly', async () => {
  const { service, history, observations } = locationFixture(6)
  history.push({ ...history[0]!, id: historyId(20), organizationId: 'foreign-org' }, { ...history[0]!, id: historyId(21), customerTenantId: 'foreign-tenant' }, { ...history[0]!, id: historyId(22), expiresAt: new Date(0) })
  const limits = { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, historyPageRows: 2, historyRows: 3 }
  await (service as any).syncSignInLogs(signInTenant, 'token', limits)
  assert.equal(observations.creates, 1); assert.equal(observations.updates, 3); assert.equal(observations.maximum, 1)
  assert.deepEqual(observations.takes, [3, 2]); assert.deepEqual(observations.cursors, [historyId(0).replace('4000-8000', '0000-0000'), historyId(2)])
  const partial = observations.states.at(-1)
  assert.deepEqual(Object.keys(partial).sort(), ['consecutiveFailures', 'lastErrorCode', 'lastErrorMessage', 'lastSuccessfulAt', 'status'])
  assert.deepEqual(observations.starts[0].update, { status: 'RUNNING', lastAttemptAt: observations.starts[0].update.lastAttemptAt, lastErrorCode: null, lastErrorMessage: null })
  assert.ok(observations.starts[0].update.lastAttemptAt instanceof Date)
  assert.equal(partial.status, 'RUNNING'); assert.equal(partial.lastErrorCode, 'sign-ins-non-premium-fallback-active-geolocation-partial')
  assert.ok(partial.lastSuccessfulAt instanceof Date); assert.equal(Object.hasOwn(partial, 'deltaLink'), false)
  assert.equal(observations.incidents, 0); assert.deepEqual(observations.logs, [])
  await (service as any).syncSignInLogs(signInTenant, 'token', limits)
  assert.equal(observations.updates, 6)
  assert.equal(observations.states.at(-1).lastErrorCode, 'sign-ins-non-premium-fallback-active')
  assert.ok(observations.states.at(-1).lastSuccessfulAt instanceof Date)
  assert.ok(history.slice(6).every(row => row.location === null))
  assert.ok(observations.timeouts.every(value => value > 0 && value <= limits.statementTimeoutMs))
})

test('first nonpremium ingestion stays usable CURRENT_LIMITED when optional enrichment is incomplete', async () => {
  const { service, observations } = locationFixture(3)
  ;(service as any).prisma.syncState.upsert = async (args: any) => { observations.starts.push(args); return { lastSuccessfulAt: null } }
  await (service as any).syncSignInLogs(signInTenant, 'token', { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, deadlineMs: 0 })
  const state = observations.states.at(-1)
  assert.equal(observations.creates, 1); assert.equal(observations.updates, 0)
  assert.equal(state.status, 'RUNNING'); assert.ok(state.lastSuccessfulAt instanceof Date)
  assert.equal(state.lastErrorCode, 'sign-ins-non-premium-fallback-active-geolocation-partial')
  assert.equal(Object.hasOwn(state, 'deltaLink'), false)
  const now = new Date()
  const readiness = deriveCollectionReadiness({
    connectionStatus: 'CONNECTED', connectionVerifiedAt: now, consentedPermissions: ['ActivityFeed.Read'],
    licenseServicePlans: [{ servicePlanName: 'EXCHANGE_S_STANDARD', provisioningStatus: 'Success' }],
    syncStates: [
      { resourceType: 'LICENSES', status: 'SUCCEEDED', lastAttemptAt: now, lastSuccessfulAt: now, lastErrorCode: null, lastErrorMessage: null },
      { resourceType: 'SIGN_INS', lastAttemptAt: observations.starts[0].update.lastAttemptAt, ...state },
    ], now,
  })
  assert.equal(readiness.evidence.signIns.availability, 'CURRENT_LIMITED')
  assert.equal(readiness.evidence.signIns.coverage, 'LIMITED')
  assert.equal(readiness.evidence.signIns.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(readiness.evidence.signIns.reasonCode, state.lastErrorCode)
  assert.equal(readiness.workloads.find(row => row.key === 'sign_ins')?.state, 'PARTIAL')
  assert.equal(readiness.evidence.riskyIdentities.count, null)
  assert.equal(readiness.evidence.conditionalAccess.count, null)
})

test('historical location bytes accept exact boundary and roll back plus-one without losing primary evidence', async () => {
  const recordBytes = Buffer.byteLength(JSON.stringify({ id: historyId(1), ipAddress: '192.0.2.1', location: null, locationOversized: false }))
  for (const delta of [0, -1]) {
    const { service, observations } = locationFixture(1)
    await (service as any).syncSignInLogs(signInTenant, 'token', { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, historyBytes: recordBytes + delta })
    assert.equal(observations.creates, 1); assert.equal(observations.updates, delta === 0 ? 1 : 0)
    assert.ok(observations.states.at(-1).lastSuccessfulAt instanceof Date)
    assert.equal(observations.states.at(-1).status, 'RUNNING')
  }
})

test('historical statement failure, database cancellation, oversized legacy location and expired deadline remain partial', async () => {
  for (const scenario of ['failure', 'cancellation', 'oversized', 'deadline']) {
    const { service, observations, history } = locationFixture(1)
    observations.failStatement = scenario === 'failure'; observations.stallStatement = scenario === 'cancellation'
    if (scenario === 'oversized') history[0]!.location = { private: 'x'.repeat(1025) }
    await (service as any).syncSignInLogs(signInTenant, 'token', { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, deadlineMs: scenario === 'deadline' ? 0 : 1000 })
    assert.equal(observations.creates, 1); assert.equal(observations.updates, 0)
    assert.equal(observations.states.at(-1).lastErrorCode, 'sign-ins-non-premium-fallback-active-geolocation-partial')
    assert.ok(observations.states.at(-1).lastSuccessfulAt instanceof Date)
    assert.equal(observations.states.at(-1).status, 'RUNNING')
    assert.equal(observations.incidents, 0); assert.deepEqual(observations.logs, [])
  }
})

test('current-IP enrichment bounds workers, unique IPs, retained locations and per-row expansion', async () => {
  const { service, observations } = locationFixture(0)
  const rows = () => Array.from({ length: 10 }, (_, index) => ({ ipAddress: `192.0.2.${index + 1}` }))
  const exact = await (service as any).enrichLimitedSignInLocations(rows(), { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, uniqueIps: 10, lookupWorkers: 2 })
  assert.equal(exact.partial, false); assert.equal(exact.locations.size, 10); assert.equal(observations.maximumLookups, 2)
  const overflow = await (service as any).enrichLimitedSignInLocations(rows(), { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, uniqueIps: 9 })
  assert.equal(overflow.partial, true); assert.equal(overflow.locations.size, 9)
  const bytes = Buffer.byteLength(JSON.stringify(['192.0.2.1', inferredLocation]))
  const locationBytes = Buffer.byteLength(JSON.stringify(inferredLocation))
  for (const delta of [0, -1]) {
    const one = [{ ipAddress: '192.0.2.1' }]
    const result = await (service as any).enrichLimitedSignInLocations(one, { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, locationBytes: bytes + delta })
    assert.equal(result.partial, delta < 0); assert.equal(result.locations.size, delta < 0 ? 0 : 1)
    const expansion = await (service as any).enrichLimitedSignInLocations([{ ipAddress: '192.0.2.1' }], { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, addedRowBytes: locationBytes + delta })
    assert.equal(expansion.partial, delta < 0)
  }
})

test('stalled local lookup cannot accumulate workers across repeated runs and late results do not mutate rows', async () => {
  const { service } = locationFixture(0)
  const releases: Array<(value: any) => void> = []
  ;(service as any).ipGeolocation = { lookup: () => new Promise(resolve => releases.push(resolve)) }
  const rows = Array.from({ length: 20 }, (_, index) => ({ ipAddress: `192.0.2.${index + 1}` }))
  const limits = { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, deadlineMs: 10 }
  assert.equal((await (service as any).enrichLimitedSignInLocations(rows, limits)).partial, true)
  assert.equal((await (service as any).enrichLimitedSignInLocations(rows, limits)).partial, true)
  assert.equal(releases.length, 8)
  releases.forEach(resolve => resolve(inferredLocation))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(rows.every(row => !Object.hasOwn(row, 'location')))
})

test('actual sign-in collection rejects malformed continuation before any persistence or successful baseline', async () => {
  for (const nextLink of [false, 0, {}, [], '', ' ']) {
    const { service, observations } = locationFixture(0)
    delete (service as any).fetchGraphCollection
    ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({ value: [{ id: 'event', createdDateTime: new Date().toISOString() }], '@odata.nextLink': nextLink }))
    await assert.rejects(() => (service as any).syncSignInLogs(signInTenant, 'token'), BadGatewayException)
    assert.equal(observations.creates, 0); assert.equal(observations.updates, 0)
    assert.equal(observations.states.at(-1).status, 'FAILED')
    assert.equal(Object.hasOwn(observations.states.at(-1), 'lastSuccessfulAt'), false)
    assert.equal(Object.hasOwn(observations.states.at(-1), 'deltaLink'), false)
    assert.equal(observations.resolved, 0)
  }
  for (const nextLink of [undefined, null, 'https://graph.microsoft.com/v1.0/auditLogs/signIns?next=2']) {
    const { service, observations } = locationFixture(0)
    delete (service as any).fetchGraphCollection
    let calls = 0
    ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({ value: [{ id: `event-${calls}`, createdDateTime: new Date().toISOString() }], '@odata.nextLink': calls++ === 0 ? nextLink : undefined }))
    await (service as any).syncSignInLogs(signInTenant, 'token')
    assert.equal(observations.creates, typeof nextLink === 'string' ? 2 : 1)
    assert.equal(observations.states.at(-1).status, 'SUCCEEDED')
  }
})

test('failed primary sign-in persistence cannot become optional success or launch historical enrichment', async () => {
  const { service, observations } = locationFixture(3)
  ;(service as any).prisma.signInLog.createMany = async () => { throw new Error('private@example.invalid database password secret') }
  await assert.rejects(() => (service as any).syncSignInLogs(signInTenant, 'token'), BadGatewayException)
  assert.equal(observations.states.at(-1).status, 'FAILED')
  assert.equal(Object.hasOwn(observations.states.at(-1), 'lastSuccessfulAt'), false)
  assert.equal(Object.hasOwn(observations.states.at(-1), 'deltaLink'), false)
  assert.deepEqual(observations.takes, []); assert.equal(observations.updates, 0); assert.equal(observations.resolved, 0)
  assert.equal(JSON.stringify(observations.logs).includes('private@'), false)
  assert.equal(JSON.stringify(observations.states).includes('secret'), false)
})

test('actual limited-login projection retains only safe diagnostic codes from all supported fields', async () => {
  for (const field of ['top', 'LoginError', 'LogonError', 'loginerror']) {
    for (const diagnostic of ['AccountLocked', 'private@example.invalid secret-token https://private.invalid']) {
      const service = new TenantSyncService({} as any, { getTenantManagementActivityContext: async () => ({ accessToken: 'synthetic', publisherIdentifier: signInTenant.microsoftTenantId }) } as any, {} as any, {} as any, {} as any, {} as any)
      const record = { RecordType: 15, Id: 'synthetic-event', CreationTime: new Date().toISOString(), Operation: 'UserLoginFailed', ResultStatus: 'Failed',
        ...(field === 'top' ? { LogonError: diagnostic } : { ExtendedProperties: [{ Name: field, Value: diagnostic }, { Name: 'Private', Value: 'NEVER_RETAIN' }] }) }
      const payloads = [[{ contentType: 'Audit.AzureActiveDirectory', status: 'enabled' }], [{ contentUri: `https://manage.office.com/api/v1.0/${signInTenant.microsoftTenantId}/activity/feed/audit/content` }], [record]]
      let calls = 0
      ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify(payloads[calls++]))
      const rows = await (service as any).fetchLimitedLoginActivity(signInTenant, new Date(Date.now() - 60000), new Date())
      assert.equal(rows[0].status.errorCode, '1')
      assert.equal(rows[0].status.failureReason, diagnostic === 'AccountLocked' ? diagnostic : 'UserLoginFailed')
      assert.equal(JSON.stringify(rows).includes('private@'), false); assert.equal(JSON.stringify(rows).includes('NEVER_RETAIN'), false)
    }
  }
})

test('PostgreSQL enrichment pages are isolated, resumable and cancelled by transaction-local statement timeout',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async (context) => {
    const { PrismaService } = await import('../prisma/prisma.service.js')
    const { Prisma } = await import('../generated/prisma/client.js')
    const prisma = new PrismaService()
    const blocker = new PrismaService()
    await prisma.$connect(); await blocker.$connect()
    const organizations: string[] = []
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
      await blocker.$disconnect(); await prisma.$disconnect()
    })
    const createTenant = async () => {
      const id = randomUUID()
      const organization = await prisma.organization.create({ data: { name: 'Synthetic enrichment integration', slug: `enrichment-${id}` } })
      organizations.push(organization.id)
      return prisma.customerTenant.create({ data: { organizationId: organization.id, microsoftTenantId: randomUUID(), displayName: 'Synthetic integration', primaryDomain: `${id}.invalid` } })
    }
    const own = await createTenant(); const foreign = await createTenant()
    const createLog = (tenant: typeof own, expired = false) => prisma.signInLog.create({ data: {
      organizationId: tenant.organizationId, customerTenantId: tenant.id, microsoftSignInId: `management:${randomUUID()}`,
      eventDateTime: new Date(), ipAddress: '192.0.2.1', raw: {}, expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)),
    } })
    const ownRows = await Promise.all(Array.from({ length: 3 }, () => createLog(own)))
    const foreignRow = await createLog(foreign); const expiredRow = await createLog(own, true)
    const service = new TenantSyncService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any)
    const locations = new Map([['192.0.2.1', inferredLocation]])
    const limits = { ...LIMITED_SIGN_IN_ENRICHMENT_LIMITS, historyPageRows: 1, historyRows: 2 }
    assert.deepEqual(await (service as any).backfillLimitedSignInLocations(own, locations, limits), { partial: true, updatedRows: 2 })
    assert.deepEqual(await (service as any).backfillLimitedSignInLocations(own, locations, limits), { partial: false, updatedRows: 1 })
    const preserved = await prisma.signInLog.findMany({ where: { id: { in: [foreignRow.id, expiredRow.id] } } })
    assert.ok(preserved.every(row => row.location === null))
    const completed = await prisma.signInLog.findMany({ where: { id: { in: ownRows.map(row => row.id) } } })
    assert.ok(completed.every(row => (row.location as any)?.source === 'MAXMIND_GEOLITE2'))
    const blocked = await createLog(own)
    let unlock!: () => void; let lockReady!: () => void; let lockFailed!: (error: unknown) => void
    const held = new Promise<void>(resolve => { unlock = resolve })
    const ready = new Promise<void>((resolve, reject) => { lockReady = resolve; lockFailed = reject })
    const holder = blocker.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT id FROM sign_in_logs WHERE id = ${blocked.id}::uuid FOR UPDATE`)
      lockReady(); await held
    }, { timeout: 5000 })
    void holder.catch(lockFailed)
    try {
      await ready
      const result = await (service as any).backfillLimitedSignInLocations(own, locations, { ...limits, statementTimeoutMs: 25, deadlineMs: 1000 })
      assert.deepEqual(result, { partial: true, updatedRows: 0 })
    } finally { unlock(); await holder }
    assert.equal((await prisma.signInLog.findUnique({ where: { id: blocked.id } }))?.location, null)
    assert.deepEqual(await (service as any).backfillLimitedSignInLocations(own, locations, limits), { partial: false, updatedRows: 1 })
  })

function serviceWithState(updates: Array<Record<string, unknown>>, resolved: string[]) {
  const prisma: any = {
    syncState: {
      upsert: async () => undefined,
      update: async ({ data }: any) => {
        updates.push(data)
        return {
          ...data,
          consecutiveFailures:
            typeof data.consecutiveFailures === 'object' ? 1 : data.consecutiveFailures,
        }
      },
    },
  }
  const notifications: any = {
    resolveIncident: async (_organizationId: string, dedupeKey: string) => {
      resolved.push(dedupeKey)
    },
    publishIncident: async () => undefined,
  }
  return new TenantSyncService(
    prisma,
    {} as never,
    {} as never,
    notifications,
    {} as never,
    {} as never,
  )
}

test('records expected sign-in dependency provisioning as initializing without a failed incident', async () => {
  const updates: Array<Record<string, unknown>> = []
  const resolved: string[] = []
  const service = serviceWithState(updates, resolved)

  await (service as any).runSnapshotSync(
    { id: 'tenant-1', organizationId: 'org-1' },
    'SIGN_INS',
    async () => {
      throw new CollectionInitializingError(
        'sign-ins-audit-subscription-initializing',
        'Microsoft is activating the audit subscription used for limited-license sign-in collection.',
      )
    },
  )

  assert.deepEqual(updates.at(-1), {
    status: 'RUNNING',
    lastErrorCode: 'sign-ins-audit-subscription-initializing',
    lastErrorMessage:
      'Microsoft is activating the audit subscription used for limited-license sign-in collection.',
    consecutiveFailures: 0,
  })
  assert.deepEqual(resolved, ['tenant:tenant-1:sync:SIGN_INS'])
})

test('does not hide a genuine sign-in collector failure as provisioning', async () => {
  const updates: Array<Record<string, unknown>> = []
  const service = serviceWithState(updates, [])

  await assert.rejects(
    (service as any).runSnapshotSync(
      { id: 'tenant-1', organizationId: 'org-1' },
      'SIGN_INS',
      async () => {
        throw new Error('Microsoft sign-in collection returned 500.')
      },
    ),
    BadGatewayException,
  )

  assert.equal(updates.at(-1)?.status, 'FAILED')
  assert.equal(updates.at(-1)?.lastErrorCode, 'MICROSOFT_TRANSIENT')
  assert.match(String(updates.at(-1)?.lastErrorMessage), /retry automatically/i)
})

test('records successful bounded fallback evidence as partial without publishing a failure', async () => {
  const updates: Array<Record<string, unknown>> = []
  const resolved: string[] = []
  const service = serviceWithState(updates, resolved)

  await (service as any).runSnapshotSync(
    { id: 'tenant-1', organizationId: 'org-1' },
    'SIGN_INS',
    async () => {
      throw new CollectionPartialError(
        'sign-ins-premium-graph-fallback-active',
        'HawkView collected limited evidence and will retry the full Microsoft Graph source.',
      )
    },
  )

  assert.equal(updates.at(-1)?.status, 'RUNNING')
  assert.ok(updates.at(-1)?.lastSuccessfulAt instanceof Date)
  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-premium-graph-fallback-active',
  )
  assert.equal(updates.at(-1)?.consecutiveFailures, 0)
  assert.deepEqual(resolved, ['tenant:tenant-1:sync:SIGN_INS'])
})

function signInCollectorFixture(servicePlans: unknown) {
  const updates: Array<Record<string, unknown>> = []
  const scopes: Array<Record<string, unknown>> = []
  const prisma: any = {
    syncState: {
      upsert: async () => undefined,
      update: async ({ data }: any) => {
        updates.push(data)
        return { ...data, consecutiveFailures: 0 }
      },
      findFirst: async ({ where }: any) => {
        scopes.push(where)
        return { status: 'SUCCEEDED', lastSuccessfulAt: new Date() }
      },
    },
    tenantLicense: {
      findMany: async ({ where }: any) => {
        scopes.push(where)
        return [{ servicePlans }]
      },
    },
    signInLog: {
      findFirst: async () => null,
      createMany: async () => undefined,
      deleteMany: async () => undefined,
    },
  }
  const service = new TenantSyncService(
    prisma,
    {} as never,
    { lookup: async () => null } as never,
    {
      resolveIncident: async () => undefined,
      publishIncident: async () => undefined,
    } as never,
    {
      pruneExpired: async () => undefined,
    } as never,
    {} as never,
  )
  return { service, scopes, updates }
}

const signInTenant = {
  id: 'tenant-1',
  organizationId: 'org-1',
  microsoftTenantId: '11111111-1111-4111-8111-111111111111',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: null,
    credentialReference: null,
  },
}

test('Business Premium evidence makes a Microsoft non-premium response a consent-shaped partial fallback', async () => {
  const { service, scopes, updates } = signInCollectorFixture([
    {
      servicePlanName: 'AAD_PREMIUM',
      servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d',
      provisioningStatus: 'Success',
    },
  ])
  let fallbackCalls = 0
  ;(service as any).fetchGraphCollection = async () => {
    throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant')
  }
  ;(service as any).fetchLimitedLoginActivity = async () => {
    fallbackCalls += 1
    return []
  }

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(fallbackCalls, 1)
  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-premium-graph-fallback-active',
  )
  assert.match(String(updates.at(-1)?.lastErrorMessage), /Directory\.Read\.All/)
  assert.ok(
    scopes.every(
      (where) =>
        where.organizationId === 'org-1' &&
        where.customerTenantId === 'tenant-1',
    ),
  )
})

test('a current complete inventory without P1 or P2 uses an honestly limited fallback', async () => {
  const { service, updates } = signInCollectorFixture([
    {
      servicePlanName: 'EXCHANGE_S_STANDARD',
      servicePlanId: 'plan-1',
      provisioningStatus: 'Success',
    },
  ])
  ;(service as any).fetchGraphCollection = async () => {
    throw new Error("Tenant doesn't have premium license")
  }
  ;(service as any).fetchLimitedLoginActivity = async () => []

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-non-premium-fallback-active',
  )
  assert.match(String(updates.at(-1)?.lastErrorMessage), /limited/i)
})

test('a successful Graph sign-in collection remains authoritative and does not invoke fallback', async () => {
  const { service, updates } = signInCollectorFixture([
    {
      servicePlanName: 'AAD_PREMIUM',
      servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d',
      provisioningStatus: 'Success',
    },
  ])
  let fallbackCalls = 0
  ;(service as any).fetchGraphCollection = async () => []
  ;(service as any).fetchLimitedLoginActivity = async () => {
    fallbackCalls += 1
    return []
  }

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(fallbackCalls, 0)
  assert.equal(updates.at(-1)?.status, 'SUCCEEDED')
  assert.equal(updates.at(-1)?.lastErrorCode, null)
})

test('the limited-license fallback reports a disabled audit subscription as initializing', async () => {
  const requested: string[] = []
  const service = new TenantSyncService(
    {} as never,
    {
      getTenantManagementActivityContext: async () => ({
        accessToken: 'management-token',
        publisherIdentifier: 'publisher-id',
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    requested.push(String(input))
    return new Response('[]', { status: 200 })
  }
  try {
    await assert.rejects(
      (service as any).fetchLimitedLoginActivity(
        {
          id: 'tenant-1',
          organizationId: 'org-1',
          microsoftTenantId: '11111111-1111-4111-8111-111111111111',
          connection: {
            connectionMode: 'HAWKVIEW_MANAGED',
            clientId: null,
            credentialReference: null,
          },
        },
        new Date('2026-08-21T12:00:00.000Z'),
        new Date('2026-08-21T12:05:00.000Z'),
      ),
      (error: unknown) =>
        error instanceof CollectionInitializingError &&
        error.code === 'sign-ins-audit-subscription-initializing',
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requested.length, 1)
  assert.match(requested[0] ?? '', /subscriptions\/list/)
})

test('the limited-license fallback retries a transient content failure and never saves a silent gap', async () => {
  const requested: string[] = []
  const service = new TenantSyncService(
    {} as never,
    {
      getTenantManagementActivityContext: async () => ({
        accessToken: 'management-token',
        publisherIdentifier: 'publisher-id',
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const contentUri = `https://manage.office.com/api/v1.0/${tenantId}/activity/feed/audit/content-1`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/subscriptions/list')) {
      return new Response(JSON.stringify([{
        contentType: 'Audit.AzureActiveDirectory',
        status: 'enabled',
      }]), { status: 200 })
    }
    if (url.includes('/subscriptions/content')) {
      return new Response(JSON.stringify([{ contentUri }]), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'ServiceUnavailable' } }), {
      status: 503,
      headers: { 'Retry-After': '0' },
    })
  }
  try {
    const end = new Date()
    const start = new Date(end.getTime() - 5 * 60 * 1000)
    await assert.rejects(
      (service as any).fetchLimitedLoginActivity(
        {
          id: 'tenant-1',
          organizationId: 'org-1',
          microsoftTenantId: tenantId,
          connection: {
            connectionMode: 'HAWKVIEW_MANAGED',
            clientId: null,
            credentialReference: null,
          },
        },
        start,
        end,
      ),
      (error: unknown) =>
        error instanceof MicrosoftGraphCollectionError &&
        error.status === 503 &&
        error.graphErrorCode === 'ServiceUnavailable',
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requested.filter((url) => url.includes('content-1')).length, 3)
})
