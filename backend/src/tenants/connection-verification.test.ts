import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { BadGatewayException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { TenantsService } from './tenants.service.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { captureConnectionVerification, publishCapturedConnectionRefresh } from './connection-verification-store.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { MicrosoftRequestError } from '../microsoft/microsoft-request.js'

const identity = { subject: 'fixture-subject' } as any
const freshResult = () => ({ displayName: 'Verified tenant', primaryDomain: 'fixture.invalid',
  grantedPermissions: ['Organization.Read.All'], missingRequiredPermissions: [] as string[] })
const copy = <T>(value: T): T => structuredClone(value)

function writerFixture(provider?: (db: Database) => Promise<any>) {
  const db = new Database()
  const verify = async () => {
    assert.equal(db.active,false); db.providerCalls++
    return provider ? provider(db) : freshResult()
  }
  const consent = { verifyCapturedConnectedTenant: verify, getCapturedManagedAccessToken: verify }
  const service: any = new TenantsService(db as any, consent as any, new Proxy({}, { get: () => () => { throw Error('unfenced notification') } }) as any)
  service.buildFrontendConsentRedirect = (...args: unknown[]) => args
  service.markInitialSyncDue = () => { throw Error('unfenced initial sync') }
  return { db, service, consent,
    discovery: () => service.completeDiscoveredMicrosoftConsent({ tenant: db.tenant.microsoftTenantId, admin_consent: 'True' }, { organizationId: db.organizationId, nonce: 'fixture' }, randomUUID()),
    exchange: () => service.completeExchangeReadOnlyConsent({ tenant: db.tenant.microsoftTenantId, admin_consent: 'True' },
      { ...db.tenant, connection: { connectionMode: db.connection.mode, consentedPermissions: [...db.connection.permissions] } }),
  }
}

test('real sync caller captures before token work and fences the resulting authentication failure', async () => {
  for (const stale of [false,true]) {
    const db = new Database(), service: any = Object.create(TenantSyncService.prototype)
    service.prisma = db
    service.microsoftConsent = {
      getTenantAccessToken: () => { throw Error('unexpected mutable token call') },
      getCapturedManagedAccessToken: async (authority: unknown) => {
        assert.equal(db.active,false); assert.deepEqual(authority,db.authority)
        assert.deepEqual(db.trace.slice(0,5),['G-lock','G-row','T','C','S'])
        db.providerCalls++
        if(stale) db.connection.incarnation=randomUUID()
        throw new MicrosoftRequestError('token authentication failed',401,'invalid_client',null)
      },
    }
    service.notifications = new Proxy({}, { get: () => () => { throw Error('unfenced effect') } })
    const tenant={...db.tenant,connection:{connectionMode:'HAWKVIEW_MANAGED',status:'CONNECTED'}}
    await assert.rejects(service.syncConnectedTenantWithinMemoryLane(tenant,true,{includeBundle:false}),BadGatewayException)
    assert.equal(db.providerCalls,1); assert.equal(db.connectionWrites,stale?0:1)
    assert.equal(db.connection.status,stale?'CONNECTED':'ERROR')
  }
})

test('stale sync timestamp stops before compensation or the second token request', async () => {
  const db=new Database(),service:any=Object.create(TenantSyncService.prototype)
  service.prisma=db;let tokens=0
  service.microsoftConsent={ getCapturedManagedAccessToken:async()=>{tokens++;return 'token'} }
  service.synchronizeUsers=async()=>{db.roles.role_scope_incarnation=randomUUID();return {deltaLink:null}}
  service.m365ManagementActivity={syncTenant:()=>{throw Error('unexpected secondary provider work')}}
  const tenant={...db.tenant,connection:{connectionMode:'HAWKVIEW_MANAGED',status:'CONNECTED'}}
  await assert.rejects(service.syncConnectedTenantWithinMemoryLane(tenant,true,{includeBundle:false}),ConflictException)
  assert.equal(tokens,1);assert.equal(db.connectionWrites,0)
})

test('discovery success and genuine provider failure reuse captured publication without unfenced effects', async () => {
  for (const failed of [false,true]) {
    const f = writerFixture(async () => { if (failed) throw Error('provider failed'); return freshResult() })
    const old = f.db.snapshot(), response = await f.discovery()
    assert.equal(response[0],failed ? 'error' : 'success')
    assert.equal(f.db.connectionWrites,1); assert.equal(f.db.providerCalls,1)
    assert.notEqual(f.db.connection.incarnation,old.connection.incarnation)
    assert.deepEqual(f.db.observations,old.observations)
    assert.equal(f.db.roles.role_scope_incarnation,old.roles.role_scope_incarnation)
  }
})
for (const changed of ['G','C','S','deleted'] as const) for (const failed of [false,true]) {
  test(`discovery late ${failed ? 'failure' : 'success'} after ${changed} has no authority/effect writes`, async () => {
    let newer: any
    const f = writerFixture(async db => {
      if (changed === 'G') db.authority.configurationRevision = randomUUID()
      if (changed === 'C') db.connection.incarnation = randomUUID()
      if (changed === 'S') { db.roles.role_scope_incarnation = randomUUID(); db.roles.role_scope_version = 'directory-role-assignments/revoked-v1' }
      if (changed === 'deleted') db.tenant.id = randomUUID()
      newer = db.snapshot(); if (failed) throw Error('old provider error'); return freshResult()
    })
    const result = await f.discovery()
    assert.equal(result[1],'consent-superseded'); assert.equal(f.db.connectionWrites,0); assert.equal(f.db.tenantWrites,0)
    assert.deepEqual(f.db.snapshot(),newer)
  })
}
test('discovery commit failure is never compensated by recordConnectionError', async () => {
  const f = writerFixture(); f.db.failAt = 'after-commit'
  await assert.rejects(f.discovery(),/injected-commit/)
  assert.equal(f.db.connectionWrites,1); assert.equal(f.db.connection.status,'CONNECTED')
})
test('managed Exchange consent merges the current grant and rotates C only when it changes', async () => {
  const f = writerFixture(); f.db.connection.permissions = ['Directory.Read.All']
  const before = f.db.snapshot()
  assert.equal((await f.exchange())[0],'exchange-readonly-consented')
  assert.deepEqual(f.db.connection.permissions,['Directory.Read.All','Exchange.ManageAsAppV2'])
  assert.notEqual(f.db.connection.incarnation,before.connection.incarnation)
  assert.equal(f.db.roles.role_attempt_id,null); assert.equal(f.db.roles.role_scope_incarnation,before.roles.role_scope_incarnation)
  const current = f.db.connection.incarnation
  assert.equal((await f.exchange())[0],'exchange-readonly-consented')
  assert.equal(f.db.connection.incarnation,current)
})
for (const changed of ['C','S','grants'] as const) test(`Exchange callback after changed ${changed} cannot overwrite it`, async () => {
  let newer: any
  const f = writerFixture(async db => {
    if (changed === 'C') db.connection.incarnation = randomUUID()
    if (changed === 'S') db.roles.role_scope_incarnation = randomUUID()
    if (changed === 'grants') db.connection.permissions = ['New.Permission']
    newer = db.snapshot(); return freshResult()
  })
  assert.equal((await f.exchange())[1],'connection-superseded')
  assert.deepEqual(f.db.snapshot(),newer); assert.equal(f.db.connectionWrites,0)
})
test('sync timestamp returns its own updated context without rotating C/S', async () => {
  const db = new Database(), old = db.snapshot()
  const captured = await captureConnectionVerification(db as any,{ customerTenantId: db.tenant.id, organizationId: db.organizationId, microsoftTenantId: db.tenant.microsoftTenantId },true)
  assert.equal(captured.status,'captured'); if (captured.status !== 'captured') return
  const result = await publishCapturedConnectionRefresh(db as any,captured.context,'sync-timestamp')
  assert.equal(result.status,'applied'); if (result.status !== 'applied') return
  assert.equal(result.context.connection.revision,db.connection.revision)
  assert.equal(db.connection.incarnation,old.connection.incarnation); assert.deepEqual(db.roles,old.roles)
  assert.equal((await publishCapturedConnectionRefresh(db as any,captured.context,'sync-timestamp')).status,'superseded')
})
test('actual sync failure writer ignores stale C/G/S and preserves current authentication-failure policy', async () => {
  for (const changed of ['none','G','C','S'] as const) {
    const db = new Database()
    const captured = await captureConnectionVerification(db as any,{ customerTenantId: db.tenant.id, organizationId: db.organizationId, microsoftTenantId: db.tenant.microsoftTenantId },true)
    assert.equal(captured.status,'captured'); if (captured.status !== 'captured') continue
    if (changed === 'G') db.authority.configurationRevision = randomUUID()
    if (changed === 'C') db.connection.incarnation = randomUUID()
    if (changed === 'S') db.roles.role_scope_incarnation = randomUUID()
    const newer = db.snapshot()
    const service: any = Object.create(TenantSyncService.prototype)
    service.prisma = db; service.notifications = new Proxy({}, { get: () => () => { throw Error('unfenced notification') } })
    await service.markConnectionUnavailable({ ...db.tenant, connection: { connectionMode: 'HAWKVIEW_MANAGED' } },new Error('authentication failed'),captured.context)
    if (changed === 'none') {
      assert.equal(db.tenant.status,'SUSPENDED'); assert.equal(db.connection.status,'ERROR')
      assert.deepEqual(db.connection.permissions,newer.connection.permissions)
      assert.equal(db.connectionWrites,1); assert.equal(db.roles.role_attempt_id,null)
    } else { assert.equal(db.connectionWrites,0); assert.deepEqual(db.snapshot(),newer) }
  }
})

/** Runs the real service/capture/publication code. SQL is simulated, not executed;
 * predicate/binding and lock assertions supplement state-transition witnesses. */
class Database {
  organizationId = randomUUID()
  tenant = { id: randomUUID(), organizationId: this.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE', revision: 'tenant-v1', displayName: 'Before', primaryDomain: null as string | null }
  connection = { id: randomUUID(), incarnation: randomUUID() as string | null, mode: 'HAWKVIEW_MANAGED', clientId: randomUUID() as string | null,
    credentialReference: 'connection-reference' as string | null, permissions: ['Old.Read', 'Exchange.ManageAsAppV2'], status: 'CONNECTED', revision: 'connection-v1' }
  authority: any = { configurationRevision: randomUUID(), clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: '' }
  roles: any = { id: randomUUID(), role_scope_incarnation: randomUUID(), role_scope_version: 'scope-v1', role_attempt_id: randomUUID(),
    role_attempt_outcome: 'RUNNING', role_complete_id: randomUUID(), role_complete_digest: 'historical', role_complete_count: 5 }
  observations = [{ id: 'stored-before-verification', payload: ['historical'] }]
  trace: string[] = []
  statements: string[] = []
  active = false
  providerCalls = 0
  connectionWrites = 0
  tenantWrites = 0
  failAt: 'write' | 'before-commit' | 'after-commit' | 'read' | null = null
  disabled = false
  memberships = [this.organizationId]
  constructor() { this.authority.credentialReference = `encrypted-secret:${this.authority.configurationRevision}` }
  snapshot() { return copy({ tenant: this.tenant, connection: this.connection, roles: this.roles, observations: this.observations, authority: this.authority }) }
  user = { findUnique: async (args: any) => {
    assert.equal(args.where.authProviderUserId, identity.subject)
    assert.deepEqual(args.select.memberships.where, { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
    return { disabledAt: this.disabled ? new Date() : null, memberships: this.memberships.map(organizationId => ({ organizationId })) }
  } }
  customerTenant = {
    findUnique: async (_args: any) => copy({ ...this.tenant, connection: { ...this.connection, connectionMode: this.connection.mode, consentedPermissions: this.connection.permissions } }),
    findFirst: async (args: any) => args.where.id === this.tenant.id && args.where.organizationId.in.includes(this.tenant.organizationId)
      ? copy({ ...this.tenant, connection: { ...this.connection, connectionMode: this.connection.mode, consentedPermissions: this.connection.permissions } }) : null,
    findUniqueOrThrow: async (_args: any) => { if (this.failAt === 'read') throw new Error('injected-response-read'); return copy(this.tenant) },
    // Deferred old-path operations support the regression run against released source.
    update: (args: any) => ({ legacy: () => { this.tenantWrites++; Object.assign(this.tenant, args.data) } }),
  }
  tenantConnection = { update: (args: any) => ({ legacy: () => {
    this.connectionWrites++; Object.assign(this.connection, args.data)
    if (args.data.consentedPermissions) this.connection.permissions = [...args.data.consentedPermissions]
  } }) }
  microsoftConsentAttempt = { update: async (_args: any) => ({}) }
  syncState = {
    findUnique: async (_args: any) => ({ id: 'users-lease', status: 'IDLE', deltaLink: null }),
    updateMany: async (_args: any) => ({ count: 1 }),
    update: async (_args: any) => ({ consecutiveFailures: 1 }),
  }
  async $transaction(work: any) {
    assert.equal(this.active, false, 'provider/caller must not nest transactions')
    const before = this.snapshot(), writes = this.connectionWrites
    this.active = true
    try {
      const value = Array.isArray(work) ? work.map(w => w.legacy()) : await work(this)
      if (this.connectionWrites > writes && (this.failAt === 'before-commit' || this.failAt === 'after-commit')) throw Error('injected-commit')
      return value
    } catch (error) {
      if (this.failAt !== 'after-commit') Object.assign(this, before)
      throw error
    } finally { this.active = false }
  }
  async $queryRawUnsafe(query: string, ...v: any[]) {
    this.statements.push(query)
    if (query === "SELECT current_setting('TimeZone') AS timezone") return [{ timezone: 'UTC' }]
    if (query.includes('pg_advisory_xact_lock_shared')) { this.trace.push('G-lock'); return [{ locked: 1 }] }
    if (query.includes('FROM platform_microsoft_connectors')) { this.trace.push('G-row'); return this.authority ? [copy(this.authority)] : [] }
    if (query.includes('verification:tenant')) {
      this.trace.push('T'); assert.match(query, /organization_id=\$2::uuid AND microsoft_tenant_id=\$3::uuid FOR NO KEY UPDATE/)
      const { id, organizationId, microsoftTenantId, status, revision } = this.tenant
      return v[0] === this.tenant.id && v[1] === this.tenant.organizationId && v[2] === this.tenant.microsoftTenantId
        ? [{ id, organizationId, microsoftTenantId, status, revision }] : []
    }
    if (query.includes('verification:connection')) {
      this.trace.push('C'); assert.match(query, /customer_tenant_id=\$1::uuid AND organization_id=\$2::uuid FOR NO KEY UPDATE/)
      return v[0] === this.tenant.id && v[1] === this.tenant.organizationId ? [copy(this.connection)] : []
    }
    if (query.includes('verification:roles')) { this.trace.push('R'); assert.match(query, /resource_type='DIRECTORY_ROLES' FOR UPDATE/); return this.roles ? [{ id: this.roles.id }] : [] }
    if (query.includes('verification:scope')) {
      this.trace.push('S'); assert.deepEqual(v, [this.tenant.id, this.tenant.organizationId])
      return this.roles ? [{ incarnation: this.roles.role_scope_incarnation, version: this.roles.role_scope_version }] : []
    }
    if (query.includes('verification:refresh')) {
      assert.deepEqual(v.slice(0,4),[this.connection.id,this.tenant.id,this.tenant.organizationId,this.connection.incarnation])
      this.connectionWrites++
      Object.assign(this.connection,{ permissions: [...v[5]], incarnation: v[6], revision: 'refreshed' })
      return [{ revision: this.connection.revision }]
    }
    throw Error('Unexpected query: ' + query)
  }
  async $executeRawUnsafe(query: string, ...v: any[]) {
    this.statements.push(query)
    if (query.startsWith('SET LOCAL')) return 0
    if (query.includes('verification:publish-tenant')) {
      this.tenantWrites++; assert.deepEqual(v.slice(0, 3), [this.tenant.id, this.tenant.organizationId, this.tenant.microsoftTenantId])
      this.tenant.status = v[3]; if (v[4]) { this.tenant.displayName = v[5]; this.tenant.primaryDomain = v[6] }; this.tenant.revision = 'published'
      return 1
    }
    if (query.includes('verification:publish-connection')) {
      this.connectionWrites++; assert.match(query, /collection_incarnation IS NOT DISTINCT FROM \$4::uuid/)
      assert.deepEqual(v.slice(0, 4), [this.connection.id, this.tenant.id, this.tenant.organizationId, this.connection.incarnation])
      if (this.failAt === 'write') throw Error('injected-write')
      Object.assign(this.connection, { incarnation: v[4], status: v[5], permissions: v[6], lastErrorCode: v[7], lastErrorMessage: v[8], revision: 'published' })
      return 1
    }
    if (query.includes('verification:invalidate-roles')) {
      assert.deepEqual(v, [this.tenant.id, this.tenant.organizationId])
      assert.match(query, /resource_type='DIRECTORY_ROLES'/)
      assert.doesNotMatch(query, /role_scope_|role_complete_|snapshots|pim_/)
      if (this.roles) for (const field of query.matchAll(/(role_attempt_\w+)=NULL/g)) this.roles[field[1]] = null
      return this.roles ? 1 : 0
    }
    throw Error('Unexpected write: ' + query)
  }
}

function fixture(provider?: (db: Database, input: any) => Promise<any>) {
  const db = new Database()
  const dispatch: string[] = []
  const verify = async (input: any) => {
    assert.equal(db.active, false, 'provider must be outside every DB lock')
    db.providerCalls++
    return provider ? provider(db, input) : freshResult()
  }
  const service = new TenantsService(db as any, {
    verifyCapturedConnectedTenant: (input: any) => { dispatch.push('captured'); return verify(input) },
    verifyConnectedTenant: (input: any) => { dispatch.push('legacy'); return verify(input) },
  } as any, {} as any)
  // Preserve the response name contract; the real response-read still runs.
  ;(service as any).mapTenant = (tenant: { displayName: string }) => ({ name: tenant.displayName })
  return { db, service, dispatch, run: (id = db.tenant.id) => service.verifyConnectionForIdentity(identity, id) }
}

test('current success rotates C, invalidates only the attempt and retains scope/history', async () => {
  const f = fixture(); const before = f.db.snapshot()
  const value = await f.run()
  assert.equal(value.connected, true); assert.equal(value.tenant.name, 'Verified tenant')
  assert.equal(f.db.tenant.displayName, 'Verified tenant')
  assert.notEqual(f.db.connection.incarnation, before.connection.incarnation)
  assert.deepEqual(f.db.connection.permissions, ['Organization.Read.All', 'Exchange.ManageAsAppV2'])
  assert.equal(f.db.roles.role_attempt_id, null)
  for (const key of ['role_scope_incarnation', 'role_scope_version', 'role_complete_id', 'role_complete_digest', 'role_complete_count']) assert.equal(f.db.roles[key], before.roles[key])
  assert.deepEqual(f.db.observations, before.observations)
  assert.deepEqual(f.db.trace, ['G-lock', 'G-row', 'T', 'C', 'G-lock', 'G-row', 'T', 'C', 'R'])
  assert.equal(f.db.providerCalls, 1)
})
test('current provider failure rotates C, clears grants and preserves completed observations', async () => {
  const f = fixture(async () => { throw Error('synthetic provider failure') }); const before = f.db.snapshot()
  await assert.rejects(f.run(), BadGatewayException)
  assert.equal(f.db.tenant.status, 'SUSPENDED'); assert.equal(f.db.connection.status, 'ERROR'); assert.deepEqual(f.db.connection.permissions, [])
  assert.notEqual(f.db.connection.incarnation, before.connection.incarnation); assert.equal(f.db.roles.role_attempt_id, null)
  assert.equal(f.db.roles.role_complete_id, before.roles.role_complete_id); assert.deepEqual(f.db.observations, before.observations)
  assert.equal(f.db.connectionWrites, 1)
})
test('current missing-permission result preserves existing policy and rotates C', async () => {
  const f = fixture(async () => ({ ...freshResult(), missingRequiredPermissions: ['Directory.Read.All'] })); const before = f.db.connection.incarnation
  assert.equal((await f.run()).connected, false); assert.equal(f.db.tenant.status, 'SUSPENDED'); assert.equal(f.db.connection.status, 'ERROR')
  assert.notEqual(f.db.connection.incarnation, before)
})
test('a genuine initial null C is compared as null and rotated only at publication', async () => {
  const f = fixture(); f.db.connection.incarnation = null; f.db.roles = null
  assert.equal((await f.run()).connected, true); assert.match(f.db.connection.incarnation!, /^[a-f0-9-]{36}$/); assert.equal(f.db.roles, null)
})
const changes: [string, (db: Database) => void][] = [
  ['C', db => { db.connection.incarnation = randomUUID() }],
  ['G', db => { db.authority.configurationRevision = randomUUID(); db.authority.credentialReference = `encrypted-secret:${db.authority.configurationRevision}` }],
  ['managed client', db => { db.authority.clientId = randomUUID() }],
  ['managed credential', db => { db.authority.credentialReference = 'replaced' }],
  ['connection credential', db => { db.connection.credentialReference = 'replaced' }],
  ['connection client', db => { db.connection.clientId = randomUUID() }],
  ['grants', db => { db.connection.permissions = ['New.Read'] }],
  ['mode', db => { db.connection.mode = 'CUSTOMER_MANAGED' }],
  ['disconnect', db => { db.tenant.status = 'DISCONNECTED'; db.connection.status = 'REVOKED' }],
  ['Microsoft tenant', db => { db.tenant.microsoftTenantId = randomUUID() }],
  ['organization', db => { db.tenant.organizationId = randomUUID() }],
  ['legacy writer revision', db => { db.connection.revision = 'changed-without-C-rotation' }],
]
for (const [name, change] of changes) for (const failed of [false, true]) {
  test(`late ${failed ? 'error' : 'success'} after changed ${name} cannot overwrite newer authority`, async () => {
    let changed: any
    const f = fixture(async db => { change(db); changed = db.snapshot(); if (failed) throw Error('old provider error'); return freshResult() })
    await assert.rejects(f.run(), ConflictException)
    assert.deepEqual(f.db.snapshot(), changed); assert.equal(f.db.connectionWrites, 0); assert.equal(f.db.tenantWrites, 0); assert.equal(f.db.providerCalls, 1)
  })
}
test('null C replaced during provider work cannot be adopted as bootstrap', async () => {
  const f = fixture(async db => { db.connection.incarnation = randomUUID(); return freshResult() }); f.db.connection.incarnation = null
  await assert.rejects(f.run(), ConflictException); assert.equal(f.db.connectionWrites, 0)
})
for (const failure of ['write', 'before-commit', 'after-commit', 'read'] as const) {
  test(`${failure} error never triggers compensating publication`, async () => {
    const f = fixture(); f.db.failAt = failure
    await assert.rejects(f.run(), /injected-/)
    assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 1); assert.equal(f.db.providerCalls, 1)
    if (failure === 'after-commit' || failure === 'read') assert.equal(f.db.connection.status, 'CONNECTED')
  })
}
test('wrong organization, tenant, and disabled identity stop before provider/capture', async () => {
  const f = fixture(); f.db.memberships = [randomUUID()]
  await assert.rejects(f.run(), NotFoundException)
  f.db.memberships = [f.db.organizationId]; await assert.rejects(f.run(randomUUID()), NotFoundException)
  f.db.disabled = true; await assert.rejects(f.run(), ForbiddenException)
  assert.equal(f.db.providerCalls, 0); assert.deepEqual(f.db.trace, [])
})
test('disconnected/revoked and mutable or absent managed authority refuse before provider', async () => {
  for (const mutate of [(db: Database) => { db.tenant.status = 'DISCONNECTED' }, (db: Database) => { db.connection.status = 'REVOKED' },
    (db: Database) => { db.authority = null }, (db: Database) => { db.authority.credentialReference = 'legacy-mutable' }]) {
    const f = fixture(); mutate(f.db); const before = f.db.snapshot()
    await assert.rejects(f.run(), ServiceUnavailableException); assert.equal(f.db.providerCalls, 0); assert.equal(f.db.connectionWrites, 0); assert.deepEqual(f.db.snapshot(), before)
  }
})


// These witnesses join the real tenant service to the real captured-verifier
// seam. Only secret access, the final provider method and SQL are doubled.
function capturedSeamFixture(access: () => Promise<string>, providerFails = false) {
  const db = new Database()
  let credentialReads = 0
  const consent = new MicrosoftConsentService({} as any, { access: async (reference: string) => {
    assert.equal(db.active, false, 'credentials must be resolved outside locks')
    assert.equal(reference, db.authority.credentialReference)
    credentialReads++
    return access()
  } } as any)
  ;(consent as any).getManagedConnector = () => { throw Error('unexpected authority recapture') }
  consent.verifyTenantWithCredentials = async (tenant, credentials) => {
    assert.equal(db.active, false, 'provider must run outside locks')
    assert.equal(tenant, db.tenant.microsoftTenantId)
    assert.deepEqual(credentials, { clientId: db.authority.clientId, clientSecret: 'injected-secret' })
    db.providerCalls++
    // The same HTTP exception type as secret failures must still publish here.
    if (providerFails) throw new ServiceUnavailableException('injected-provider-unavailable')
    return { ...freshResult(), missingPermissions: [], missingNonConnectionPermissions: [] }
  }
  const service = new TenantsService(db as any, consent, {} as any)
  ;(service as any).mapTenant = (tenant: { displayName: string }) => ({ name: tenant.displayName })
  return { db, credentialReads: () => credentialReads, run: () => service.verifyConnectionForIdentity(identity, db.tenant.id) }
}

for (const [name, access] of [
  ['missing', async () => { throw new ServiceUnavailableException('injected-private-missing-secret') }],
  ['unreadable', async () => { throw new ServiceUnavailableException('injected-private-decryption-error') }],
  ['read-error', async () => { throw Error('injected-private-database-error') }],
  ['empty', async () => ''],
] as const) {
  test(`credential ${name} through real service and seam makes no provider calls or authority writes`, async () => {
    const f = capturedSeamFixture(access), before = f.db.snapshot()
    let failure: unknown
    try { await f.run() } catch (error) { failure = error }
    // Assert writes/state before the response so the v1 red control demonstrates
    // actual authority mutation, not merely a changed exception label.
    assert.equal(f.db.providerCalls, 0)
    assert.equal(f.credentialReads(), 1)
    assert.equal(f.db.tenantWrites, 0)
    assert.equal(f.db.connectionWrites, 0)
    assert.deepEqual(f.db.snapshot(), before)
    assert.deepEqual(f.db.trace, ['G-lock', 'G-row', 'T', 'C'])
    assert.ok(failure instanceof ServiceUnavailableException)
    assert.equal(failure.getStatus(), 503)
    assert.deepEqual(failure.getResponse(), { code: 'MANAGED_CREDENTIAL_CAPTURE_UNAVAILABLE', message: 'Connection verification credentials are temporarily unavailable.' })
    assert.doesNotMatch(JSON.stringify(failure.getResponse()), /injected-private/)
  })
}

test('real service and seam still publish genuine provider ServiceUnavailableException', async () => {
  const f = capturedSeamFixture(async () => 'injected-secret', true), before = f.db.snapshot()
  await assert.rejects(f.run(), BadGatewayException)
  assert.equal(f.credentialReads(), 1); assert.equal(f.db.providerCalls, 1)
  assert.equal(f.db.tenantWrites, 1); assert.equal(f.db.connectionWrites, 1)
  assert.equal(f.db.tenant.status, 'SUSPENDED'); assert.equal(f.db.connection.status, 'ERROR')
  assert.deepEqual(f.db.connection.permissions, []); assert.notEqual(f.db.connection.incarnation, before.connection.incarnation)
  assert.equal(f.db.roles.role_attempt_id, null)
  for (const key of ['role_scope_incarnation', 'role_scope_version', 'role_complete_id', 'role_complete_digest', 'role_complete_count']) assert.equal(f.db.roles[key], before.roles[key])
  assert.deepEqual(f.db.observations, before.observations)
})
