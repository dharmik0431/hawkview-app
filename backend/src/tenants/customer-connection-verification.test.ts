import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { BadGatewayException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { TenantsService } from './tenants.service.js'
import { MicrosoftConsentService, CustomerVerificationCredentialsUnavailable } from '../microsoft/microsoft-consent.service.js'
import { captureCustomerConnectionVerification } from './customer-connection-verification-store.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const MSFT = '33333333-3333-4333-8333-333333333333'
const CONN = '44444444-4444-4444-8444-444444444444'
const CLIENT_OLD = '55555555-5555-4555-8555-555555555555'
const REF_OLD = 'encrypted-secret:66666666-6666-4666-8666-666666666666'
const INCARN = '77777777-7777-4777-8777-777777777777'
const CLIENT_NEW = '88888888-8888-4888-8888-888888888888'
const REF_NEW = 'encrypted-secret:99999999-9999-4999-8999-999999999999'
const C_REV = '2026-10-07 02:00:00+00', T_REV = '2026-10-07 01:59:00+00'
const PERMS_OLD = ['Old.Read', 'Exchange.ManageAsAppV2']
const GRANTED = ['Organization.Read.All'], PERMS_NEW = [...GRANTED, 'Exchange.ManageAsAppV2']
const identity = { subject: 'customer-fixture-subject' } as any
const who = { customerTenantId: TEN, organizationId: ORG, microsoftTenantId: MSFT }
const copy = <T>(value: T): T => structuredClone(value)
const freshResult = () => ({ displayName: 'Verified tenant', primaryDomain: 'contoso.example',
  grantedPermissions: [...GRANTED], missingPermissions: [], missingRequiredPermissions: [] as string[], missingNonConnectionPermissions: [] })
const realFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw Error('Real network forbidden in customer verification tests') } })
after(() => { globalThis.fetch = realFetch })

/** Executes the real service and helper. SQL predicates are simulated from the supplied text,
 * including the deliberately removable revision guard; only A11 asserts its literal presence.
 * Counters retain matched attempts across rollback. Snapshots establish committed state. */
class CustomerDatabase {
  tenant = { id: TEN, organizationId: ORG, microsoftTenantId: MSFT, status: 'ACTIVE', revision: T_REV,
    displayName: 'Before', primaryDomain: null as string | null }
  connection = { id: CONN, incarnation: INCARN as string | null, mode: 'CUSTOMER_MANAGED',
    clientId: CLIENT_OLD as string | null, credentialReference: REF_OLD as string | null,
    permissions: [...PERMS_OLD], status: 'CONNECTED', revision: C_REV,
    lastErrorCode: 'old-error' as string | null, lastErrorMessage: 'old message' as string | null, lastVerifiedAt: 'before' }
  active = false
  events: string[] = []
  statements: Array<{ sql: string; binds: any[] }> = []
  providerCalls = 0; credentialReads = 0; connectionWrites = 0; tenantWrites = 0
  transactions = 0
  injectedError: Error | undefined
  failAt: 'before-commit' | 'after-commit' | 'read' | 'mapper' | 'connection-write' | 'tenant-write' | null = null
  connectionRowCount: number | undefined
  tenantRowCount: number | undefined
  beforeCapture?: () => void
  disabled = false; memberships = [ORG]
  fail(message: string): never { this.injectedError = new Error(message); throw this.injectedError }
  snapshot() { return copy({ tenant: this.tenant, connection: this.connection }) }
  user = { findUnique: async (args: any) => {
    assert.equal(args.where.authProviderUserId, identity.subject)
    assert.deepEqual(args.select.memberships.where, { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
    return { disabledAt: this.disabled ? new Date() : null, memberships: this.memberships.map(organizationId => ({ organizationId })) }
  } }
  customerTenant = {
    findFirst: async (args: any) => {
      if (args.where.id !== this.tenant.id || !args.where.organizationId.in.includes(this.tenant.organizationId)) return null
      const selected = copy({ ...this.tenant, connection: { ...this.connection,
        connectionMode: this.connection.mode, consentedPermissions: this.connection.permissions } })
      this.beforeCapture?.()
      return selected
    },
    findUniqueOrThrow: async (args: any) => {
      assert.equal(this.active, false); assert.equal(args.where.id, TEN)
      this.events.push('refresh:read')
      if (this.failAt === 'read') this.fail('injected-response-read')
      return copy(this.tenant)
    },
    update: () => { throw Error('unfenced tenant update') },
  }
  tenantConnection = { update: () => { throw Error('unfenced connection update') } }
  async $transaction<T>(work: (tx: CustomerDatabase) => Promise<T>, options: any): Promise<T> {
    assert.equal(this.active, false)
    assert.equal(typeof work, 'function', 'array transaction would bypass the capture/publication contract')
    assert.deepEqual(options, { isolationLevel: 'ReadCommitted' })
    const phase = this.transactions++ === 0 ? 'capture' : 'publish'
    const before = this.snapshot()
    this.events.push(`${phase}:BEGIN`); this.active = true
    let committed = false
    try {
      const result = await work(this)
      if (phase === 'publish' && this.failAt === 'before-commit') this.fail('injected-before-commit')
      committed = true; this.events.push(`${phase}:COMMIT`)
      if (phase === 'publish' && this.failAt === 'after-commit') this.fail('injected-after-commit')
      return result
    } catch (error) {
      if (!committed) { Object.assign(this, before); this.events.push(`${phase}:ROLLBACK`) }
      throw error
    } finally { this.active = false }
  }
  async $queryRawUnsafe<T>(sql: string, ...binds: any[]): Promise<T> {
    assert.equal(this.active, true); this.statements.push({ sql, binds: copy(binds) })
    if (sql.includes('customer-fence:tenant-lock')) {
      this.events.push('customer-fence:tenant-lock')
      const { id, organizationId, microsoftTenantId, status, revision } = this.tenant
      return (binds[0] === id && binds[1] === organizationId && binds[2] === microsoftTenantId
        ? [{ id, organizationId, microsoftTenantId, status, revision }] : []) as T
    }
    if (sql.includes('customer-fence:connection-lock')) {
      this.events.push('customer-fence:connection-lock')
      const { id, incarnation, mode, clientId, credentialReference, permissions, status, revision } = this.connection
      return (binds[0] === this.tenant.id && binds[1] === this.tenant.organizationId
        ? [copy({ id, incarnation, mode, clientId, credentialReference, permissions, status, revision })] : []) as T
    }
    throw Error('Unexpected query: ' + sql)
  }
  async $executeRawUnsafe(sql: string, ...binds: any[]): Promise<number> {
    assert.equal(this.active, true); this.statements.push({ sql, binds: copy(binds) })
    const revisionGuard = /AND\s+updated_at::text\s*=\s*\$4/.test(sql)
    if (sql.includes('customer-fence:publish-connection')) {
      this.events.push('customer-fence:publish-connection')
      const matches = binds[0] === this.connection.id && binds[1] === this.tenant.id && binds[2] === this.tenant.organizationId
        && (!revisionGuard || binds[3] === this.connection.revision)
      if (!matches) return 0
      if (this.connectionRowCount !== undefined) return this.connectionRowCount
      if (this.failAt === 'connection-write') this.fail('injected-connection-write')
      this.connectionWrites++
      Object.assign(this.connection, { status: binds[4], permissions: [...binds[5]], lastErrorCode: binds[6],
        lastErrorMessage: binds[7], lastVerifiedAt: 'database-clock', revision: 'published-connection' })
      return 1
    }
    if (sql.includes('customer-fence:publish-tenant')) {
      this.events.push('customer-fence:publish-tenant')
      const matches = binds[0] === this.tenant.id && binds[1] === this.tenant.organizationId && binds[2] === this.tenant.microsoftTenantId
        && (!revisionGuard || binds[3] === this.tenant.revision)
      if (!matches) return 0
      if (this.tenantRowCount !== undefined) return this.tenantRowCount
      if (this.failAt === 'tenant-write') this.fail('injected-tenant-write')
      this.tenantWrites++
      this.tenant.status = binds[4]
      if (binds[5]) { this.tenant.displayName = binds[6]; this.tenant.primaryDomain = binds[7] }
      this.tenant.revision = 'published-tenant'
      return 1
    }
    throw Error('Unexpected write: ' + sql)
  }
}

function fixture(options: {
  provider?: (db: CustomerDatabase) => ReturnType<typeof freshResult> | Promise<ReturnType<typeof freshResult>>
  access?: (reference: string, db: CustomerDatabase) => string | Promise<string>
} = {}) {
  const db = new CustomerDatabase(), dispatch: string[] = [], providerArgs: unknown[][] = [], accessed: string[] = []
  const consent = new MicrosoftConsentService(db as any, { access: async (reference: string) => {
    assert.equal(db.active, false, 'credential access must be outside transactions')
    db.events.push('secret:access:' + reference); db.credentialReads++; accessed.push(reference)
    return options.access ? options.access(reference, db) : 'resolved-secret'
  } } as any)
  ;(consent as any).getManagedConnector = () => { throw Error('unexpected managed authority fallback') }
  consent.verifyCapturedConnectedTenant = () => { throw Error('unexpected managed verification dispatch') }
  consent.verifyTenantWithCredentials = async (tenant, credentials) => {
    assert.equal(db.active, false, 'provider must be outside transactions')
    db.events.push('provider:verifyTenantWithCredentials'); db.providerCalls++
    providerArgs.push([tenant, copy(credentials)])
    return options.provider ? options.provider(db) : freshResult()
  }
  const verifierInputs: unknown[] = []
  const verify = consent.verifyConnectedTenant.bind(consent)
  consent.verifyConnectedTenant = input => { dispatch.push('legacy'); verifierInputs.push(copy(input)); return verify(input) }
  const service: any = new TenantsService(db as any, consent, {} as any)
  service.mapTenant = (tenant: { displayName: string }) => {
    assert.equal(db.active, false)
    if (db.failAt === 'mapper') db.fail('injected-mapper')
    return { name: tenant.displayName }
  }
  return { db, dispatch, providerArgs, accessed, verifierInputs, service,
    run: (id = TEN) => service.verifyConnectionForIdentity(identity, id) }
}
async function superseded(run: () => Promise<unknown>) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ConflictException)
    assert.equal((error.getResponse() as any).code, 'CONNECTION_VERIFICATION_SUPERSEDED')
    return true
  })
}

test('A1 clean customer success publishes with captured dispatch, grants and unchanged incarnation', async () => {
  const f = fixture(), response = await f.run()
  assert.deepEqual(response, { connected: true, tenant: { name: 'Verified tenant' } })
  assert.deepEqual(f.dispatch, ['legacy'])
  assert.deepEqual(f.verifierInputs, [{ microsoftTenantId: MSFT, connectionMode: 'CUSTOMER_MANAGED', clientId: CLIENT_OLD, credentialReference: REF_OLD }])
  assert.deepEqual(f.providerArgs, [[MSFT, { clientId: CLIENT_OLD, clientSecret: 'resolved-secret' }]])
  assert.deepEqual(f.accessed, [REF_OLD])
  assert.equal(f.db.providerCalls, 1); assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 1)
  assert.equal(f.db.connection.status, 'CONNECTED'); assert.deepEqual(f.db.connection.permissions, PERMS_NEW)
  assert.equal(f.db.tenant.displayName, 'Verified tenant'); assert.equal(f.db.tenant.primaryDomain, 'contoso.example')
  assert.equal(f.db.connection.lastErrorCode, null); assert.equal(f.db.connection.incarnation, INCARN)
})

test('A2 connection-row revision-only change refuses stale publication (not a credential-value fence)', async () => {
  let newer: unknown
  const f = fixture({ provider: db => { db.connection.revision = 'changed-without-C-rotation'; newer = db.snapshot(); return freshResult() } })
  let failure: unknown
  try { await f.run() } catch (error) { failure = error }
  // These behavioral checks precede exception/shape checks so the mutant proves an actual stale write.
  assert.equal(f.db.connectionWrites, 0, 'a stale connection result was published')
  assert.equal(f.db.tenantWrites, 0)
  assert.deepEqual(f.db.snapshot(), newer)
  assert.equal(f.db.providerCalls, 1)
  assert.ok(failure instanceof ConflictException)
  assert.equal((failure.getResponse() as any).code, 'CONNECTION_VERIFICATION_SUPERSEDED')
  assert.equal(f.db.events.includes('customer-fence:publish-tenant'), false)
})

const changes: Array<[string, (db: CustomerDatabase) => void]> = [
  ['A3 reference', db => { db.connection.credentialReference = REF_NEW }],
  ['A4 grants', db => { db.connection.permissions = ['New.Read'] }],
  ['A5 terminal states', db => { db.tenant.status = 'DISCONNECTED'; db.connection.status = 'REVOKED' }],
  ['client', db => { db.connection.clientId = CLIENT_NEW }],
  ['mode', db => { db.connection.mode = 'HAWKVIEW_MANAGED' }],
  ['incarnation', db => { db.connection.incarnation = null }],
  ['connection id', db => { db.connection.id = CLIENT_NEW }],
  ['connection status', db => { db.connection.status = 'ERROR' }],
  ['tenant status', db => { db.tenant.status = 'SUSPENDED' }],
  ['tenant id', db => { db.tenant.id = CLIENT_NEW }],
  ['Microsoft tenant', db => { db.tenant.microsoftTenantId = CLIENT_NEW }],
  ['organization', db => { db.tenant.organizationId = CLIENT_NEW }],
]
for (const [name, change] of changes) for (const providerFailed of [false, true]) {
  test(`${name}: late ${providerFailed ? 'failure' : 'success'} cannot overwrite changed captured keys`, async () => {
    let newer: unknown
    const f = fixture({ provider: db => { change(db); newer = db.snapshot(); if (providerFailed) throw Error('provider failed'); return freshResult() } })
    await superseded(f.run)
    assert.deepEqual(f.db.snapshot(), newer); assert.equal(f.db.connectionWrites, 0); assert.equal(f.db.tenantWrites, 0)
    assert.equal(f.db.providerCalls, 1)
  })
}

test('A6 reference equality does not imply value identity; same-reference value replacement is NOT fenced', async () => {
  let secret = 'resolved-secret'
  const f = fixture({ access: () => secret, provider: () => { secret = 'replacement-value'; return freshResult() } })
  await f.run()
  assert.equal(f.db.connectionWrites, 1, 'G4 remains open: no customer secret-version primitive exists')
  assert.equal(f.db.connection.status, 'CONNECTED')
  assert.equal(f.db.connection.credentialReference, REF_OLD)
  assert.equal(secret, 'replacement-value')
})

for (const failAt of ['after-commit', 'read', 'mapper'] as const) test(`A7 ${failAt} failure preserves exactly one committed success`, async () => {
  const f = fixture(); f.db.failAt = failAt
  await assert.rejects(f.run, (error: unknown) => error === f.db.injectedError && error instanceof Error && !(error instanceof BadGatewayException))
  assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 1); assert.equal(f.db.providerCalls, 1)
  assert.equal(f.db.connection.status, 'CONNECTED'); assert.deepEqual(f.db.connection.permissions, PERMS_NEW)
  assert.equal(f.db.connection.lastErrorCode, null); assert.equal(f.db.tenant.displayName, 'Verified tenant')
})

test('A8 before-commit failure rolls back matched attempts and propagates its original error', async () => {
  const f = fixture(), before = f.db.snapshot(); f.db.failAt = 'before-commit'
  await assert.rejects(f.run, (error: unknown) => error === f.db.injectedError && error instanceof Error && error.message === 'injected-before-commit')
  assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 1)
  assert.deepEqual(f.db.snapshot(), before)
})

for (const [name, access] of [
  ['missing', () => { throw new ServiceUnavailableException('injected-private-missing') }],
  ['decryption', () => { throw new ServiceUnavailableException('injected-private-decryption') }],
  ['storage read', () => { throw Error('injected-private-storage') }],
  ['empty', () => ''],
] as const) test(`A9 ${name} credential failure is redacted and never publishes`, async () => {
  const f = fixture({ access }), before = f.db.snapshot()
  await assert.rejects(f.run, (error: unknown) => {
    assert.ok(error instanceof CustomerVerificationCredentialsUnavailable)
    assert.equal(error.getStatus(), 503)
    assert.deepEqual(error.getResponse(), { code: 'CUSTOMER_CREDENTIAL_UNAVAILABLE', message: 'Connection verification credentials are temporarily unavailable.' })
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /injected-private/)
    return true
  })
  assert.equal(f.db.credentialReads, 1); assert.equal(f.db.providerCalls, 0)
  assert.equal(f.db.connectionWrites, 0); assert.equal(f.db.tenantWrites, 0)
  assert.deepEqual(f.accessed, [REF_OLD]); assert.deepEqual(f.db.snapshot(), before)
})

for (const field of ['clientId', 'credentialReference'] as const) test(`missing captured ${field} is typed credential unavailability without provider work`, async () => {
  const f = fixture(); f.db.connection[field] = null; const before = f.db.snapshot()
  await assert.rejects(f.run, CustomerVerificationCredentialsUnavailable)
  assert.equal(f.db.credentialReads, 0); assert.equal(f.db.providerCalls, 0)
  assert.equal(f.db.connectionWrites, 0); assert.deepEqual(f.db.snapshot(), before)
})

test('A10 genuine provider 503 retains customer error dispatch and status policy, publishing once', async () => {
  const f = fixture({ provider: () => { throw new ServiceUnavailableException('injected-provider-unavailable') } })
  await assert.rejects(f.run, BadGatewayException)
  assert.deepEqual(f.dispatch, ['legacy'])
  assert.deepEqual(f.verifierInputs, [{ microsoftTenantId: MSFT, connectionMode: 'CUSTOMER_MANAGED', clientId: CLIENT_OLD, credentialReference: REF_OLD }])
  assert.equal(f.db.credentialReads, 1); assert.equal(f.db.providerCalls, 1)
  assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 1)
  assert.equal(f.db.connection.status, 'ERROR'); assert.equal(f.db.tenant.status, 'SUSPENDED')
  assert.deepEqual(f.db.connection.permissions, []); assert.equal(f.db.connection.incarnation, INCARN)
  assert.equal(f.db.connection.lastErrorCode, 'connection-verification-failed')
  assert.equal(f.db.tenant.displayName, 'Before'); assert.equal(f.db.tenant.primaryDomain, null)
})

test('missing required permission preserves optional Exchange grant and existing status policy', async () => {
  const f = fixture({ provider: () => ({ ...freshResult(), missingRequiredPermissions: ['Directory.Read.All'] }) })
  const response = await f.run()
  assert.equal(response.connected, false); assert.equal(f.db.connection.status, 'ERROR'); assert.equal(f.db.tenant.status, 'SUSPENDED')
  assert.deepEqual(f.db.connection.permissions, PERMS_NEW)
  assert.equal(f.db.connection.lastErrorCode, 'missing-permissions')
  assert.equal(f.db.connection.lastErrorMessage, 'Missing connection-required permissions: Directory.Read.All')
})

test('A11 exact observable lock/publication/credential trace, SQL predicates and captured bindings', async () => {
  const f = fixture(); await f.run()
  assert.deepEqual(f.db.events, [
    'capture:BEGIN', 'customer-fence:tenant-lock', 'customer-fence:connection-lock', 'capture:COMMIT',
    'secret:access:' + REF_OLD, 'provider:verifyTenantWithCredentials',
    'publish:BEGIN', 'customer-fence:tenant-lock', 'customer-fence:connection-lock',
    'customer-fence:publish-connection', 'customer-fence:publish-tenant', 'publish:COMMIT', 'refresh:read',
  ])
  for (const statement of f.db.statements) {
    assert.doesNotMatch(statement.sql, /advisory|DIRECTORY_ROLES|platform_microsoft_connectors/)
    assert.equal(statement.binds.some(value => value instanceof Date), false)
    if (statement.sql.includes('-lock')) assert.match(statement.sql, /FOR NO KEY UPDATE/)
  }
  const connection = f.db.statements.find(s => s.sql.includes('customer-fence:publish-connection'))!
  const tenant = f.db.statements.find(s => s.sql.includes('customer-fence:publish-tenant'))!
  assert.match(connection.sql, /AND updated_at::text = \$4/)
  assert.match(tenant.sql, /AND updated_at::text = \$4/)
  assert.match(connection.sql, /last_verified_at=clock_timestamp\(\)/)
  assert.match(connection.sql, /updated_at=clock_timestamp\(\)/)
  assert.match(tenant.sql, /updated_at=clock_timestamp\(\)/)
  assert.deepEqual(connection.binds, [CONN, TEN, ORG, C_REV, 'CONNECTED', PERMS_NEW, null, null])
  assert.deepEqual(tenant.binds, [TEN, ORG, MSFT, T_REV, 'ACTIVE', true, 'Verified tenant', 'contoso.example'])
  assert.deepEqual(f.db.statements[0].binds, [TEN, ORG, MSFT]); assert.deepEqual(f.db.statements[1].binds, [TEN, ORG])
})

test('A12 pre-capture change uses new captured credentials and revision, then publishes', async () => {
  const f = fixture({ access: reference => reference === REF_NEW ? 'secret-from-new-reference' : 'old-secret' })
  f.db.beforeCapture = () => Object.assign(f.db.connection, { clientId: CLIENT_NEW, credentialReference: REF_NEW, revision: '2026-10-07 02:00:05+00' })
  await f.run()
  assert.deepEqual(f.accessed, [REF_NEW])
  assert.deepEqual(f.providerArgs, [[MSFT, { clientId: CLIENT_NEW, clientSecret: 'secret-from-new-reference' }]])
  assert.equal(f.db.statements.find(s => s.sql.includes('customer-fence:publish-connection'))!.binds[3], '2026-10-07 02:00:05+00')
  assert.equal(f.db.connectionWrites, 1)
})

test('A12b post-capture revision change refuses and retains the original publication bind', async () => {
  let newer: unknown
  const f = fixture({ provider: db => { db.connection.revision = '2026-10-07 02:00:09+00'; newer = db.snapshot(); return freshResult() } })
  await superseded(f.run)
  assert.equal(f.db.statements.find(s => s.sql.includes('customer-fence:publish-connection'))!.binds[3], C_REV)
  assert.equal(f.db.connectionWrites, 0); assert.deepEqual(f.db.snapshot(), newer)
})

test('tenant revision conflict rolls back the already matched connection CAS', async () => {
  let newer: unknown
  const f = fixture({ provider: db => { db.tenant.revision = 'changed-tenant-revision'; newer = db.snapshot(); return freshResult() } })
  await superseded(f.run)
  assert.equal(f.db.connectionWrites, 1); assert.equal(f.db.tenantWrites, 0)
  assert.deepEqual(f.db.snapshot(), newer)
})

for (const table of ['connection', 'tenant'] as const) for (const count of [0, 2]) test(`${table} CAS count ${count} refuses exactly-one requirement`, async () => {
  const f = fixture(), before = f.db.snapshot()
  f.db[table === 'connection' ? 'connectionRowCount' : 'tenantRowCount'] = count
  await superseded(f.run)
  assert.deepEqual(f.db.snapshot(), before)
  assert.equal(f.db.tenantWrites, 0)
  assert.equal(f.db.connectionWrites, table === 'tenant' ? 1 : 0)
})
for (const failAt of ['connection-write', 'tenant-write'] as const) test(`${failAt} preserves rollback and does not compensate`, async () => {
  const f = fixture(), before = f.db.snapshot(); f.db.failAt = failAt
  await assert.rejects(f.run, new RegExp('injected-' + failAt))
  assert.deepEqual(f.db.snapshot(), before)
  assert.equal(f.db.connectionWrites, failAt === 'tenant-write' ? 1 : 0)
  assert.equal(f.db.tenantWrites, 0)
})

test('capture freezes copies and does not fence value-only secret replacement', async () => {
  const db = new CustomerDatabase(), captured = await captureCustomerConnectionVerification(db, who)
  assert.ok(captured)
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.tenant))
  assert.ok(Object.isFrozen(captured.connection)); assert.ok(Object.isFrozen(captured.connection.permissions))
  db.connection.permissions.push('Later.Read')
  assert.deepEqual(captured.connection.permissions, PERMS_OLD)
})

test('capture rechecks selected mode and terminal state before credential work', async () => {
  for (const change of [
    (db: CustomerDatabase) => { db.connection.mode = 'HAWKVIEW_MANAGED' },
    (db: CustomerDatabase) => { db.connection.status = 'REVOKED' },
    (db: CustomerDatabase) => { db.tenant.status = 'DISCONNECTED' },
  ]) {
    const f = fixture(); f.db.beforeCapture = () => change(f.db)
    await assert.rejects(f.run, ServiceUnavailableException)
    assert.equal(f.db.providerCalls, 0); assert.equal(f.db.credentialReads, 0); assert.equal(f.db.connectionWrites, 0)
  }
})
test('authorization refuses wrong organization, unknown tenant and disabled identity before capture', async () => {
  const f = fixture(); f.db.memberships = [CLIENT_NEW]
  await assert.rejects(f.run, NotFoundException)
  f.db.memberships = [ORG]; await assert.rejects(() => f.run(CLIENT_NEW), NotFoundException)
  f.db.disabled = true; await assert.rejects(f.run, ForbiddenException)
  assert.equal(f.db.providerCalls, 0); assert.deepEqual(f.db.events, [])
})

test('shared verifier retains managed credential, incomplete, resolution-error and provider-error behavior', async () => {
  for (const outcome of ['success', 'incomplete', 'resolution-error', 'provider-error'] as const) {
    const original = new ServiceUnavailableException('managed-original-error')
    let managedReads = 0, providers = 0
    const consent = new MicrosoftConsentService({} as any, { access: () => { throw Error('unexpected customer secret read') } } as any)
    ;(consent as any).getManagedConnector = async () => {
      managedReads++
      if (outcome === 'resolution-error') throw original
      return { clientId: CLIENT_OLD, clientSecret: outcome === 'incomplete' ? '' : 'managed-secret' }
    }
    consent.verifyTenantWithCredentials = async (tenant, credentials) => {
      providers++
      assert.equal(tenant, MSFT); assert.deepEqual(credentials, { clientId: CLIENT_OLD, clientSecret: 'managed-secret' })
      if (outcome === 'provider-error') throw original
      return freshResult()
    }
    const run = () => consent.verifyConnectedTenant({ microsoftTenantId: MSFT, connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null })
    if (outcome === 'success') assert.deepEqual(await run(), freshResult())
    else await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException)
      assert.equal(error instanceof CustomerVerificationCredentialsUnavailable, false)
      if (outcome === 'incomplete') assert.equal(error.message, 'The Microsoft tenant connection is incomplete.')
      else assert.equal(error, original)
      return true
    })
    assert.equal(managedReads, 1)
    assert.equal(providers, outcome === 'success' || outcome === 'provider-error' ? 1 : 0)
  }
})
