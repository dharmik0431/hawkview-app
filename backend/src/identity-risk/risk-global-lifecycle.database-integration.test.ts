import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { WrappedRiskPseudonymProvider } from './pilot-pseudonym-provider.js'
import { MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS } from './mailbox-risk-projector.service.js'
import { mailboxRule } from './mailbox-risk.test-fixtures.js'
import { MAILBOX_SOURCE_RESOURCES, MAILBOX_SOURCE_VERSION, mailboxSourceDigest, sourceAttestationKey } from './mailbox-source-attestation.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { IDENTITY_RISK_CATALOG_VERSION, IDENTITY_RISK_ENGINE_VERSION } from './identity-risk.contract.js'
import { approvedIdentitySignalDetectors } from './identity-risk-approved-evaluator.adapter.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import { withRiskKeyTransaction } from './mailbox-read-transaction.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
async function fixture(work: (f: { prisma: PrismaService; client: pg.Client; scope: { organizationId: string; customerTenantId: string; environment: string }; store: WrappedRiskKeyStore }) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local DB only')
  const prisma = new PrismaService(); const client = new pg.Client({ connectionString: url.toString() })
  await prisma.$connect(); await client.connect()
  const scope = { organizationId: randomUUID(), customerTenantId: randomUUID(), environment: `synthetic-${randomUUID().slice(0,8)}` }
  const config = { HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
    HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: scope.environment, HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1',
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined, SECRET_ENCRYPTION_KEY: '52'.repeat(32) }
  const before = Object.fromEntries(Object.keys(config).map(k => [k, process.env[k]]))
  for (const [k,v] of Object.entries(config)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    await prisma.organization.create({ data: { id: scope.organizationId, name: 'Synthetic global risk', slug: `synthetic-${scope.organizationId}` } })
    await prisma.customerTenant.create({ data: { id: scope.customerTenantId, organizationId: scope.organizationId,
      microsoftTenantId: randomUUID(), displayName: 'Synthetic scope', status: 'ACTIVE' } })
    await prisma.tenantConnection.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, status: 'CONNECTED' } })
    await work({ prisma, client, scope, store: new WrappedRiskKeyStore() })
  } finally {
    await client.query('ROLLBACK')
    await prisma.organization.deleteMany({ where: { id: scope.organizationId } })
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1', [scope.environment])
    await prisma.$disconnect(); await client.end()
    for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const deadline = () => Date.now() + 6_000

test('global claim and commit blocked locks cancel actual transport, settle and cannot write after lock release', { skip: !enabled, timeout: 15_000 }, () => fixture(async ({ scope, prisma, client }) => {
  const evaluator = new IdentityRiskEvaluatorService(prisma, new IdentityRiskSafetyService(prisma))
  const lockKey = `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${scope.organizationId}:${scope.customerTenantId}`
  const now = new Date()
  for (const method of ['claimRun', 'persistCompletedRun'] as const) {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])
    const start = Date.now()
    const request = { ...scope, executionDeadlineAt: start + 1_500,
      windowStart: new Date(now.getTime()-3_600_000), windowEnd: now,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION }
    const pending = (evaluator as any)[method]({ request, platformNow: now, capability: 'UNAVAILABLE',
      runId: randomUUID(), runKey: randomUUID(), leaseToken: randomUUID(),
      watermarkHash: 'a'.repeat(64), sourceContentHash: 'b'.repeat(64), expiresAt: new Date(now.getTime()+3_600_000),
      aggregates: [], matches: [] }).then(() => ({ rejected: false }), () => ({ rejected: true }))
    try {
      await waitForAdvisoryWait(client, lockKey)
      assert.equal((await pending).rejected, true)
      assert.ok(Date.now() - start < 3_000)
      const active = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='hawkview-risk-bounded-transaction'")
      assert.equal(active.rows[0].n, 0, `${method} must not leave a connection or queued rollback`)
    } finally { await client.query('ROLLBACK'); await pending }
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await prisma.identityRiskEvaluationRun.count({ where: { customerTenantId: scope.customerTenantId } }), 0)
    assert.equal(await prisma.identityRiskFinding.count({ where: { customerTenantId: scope.customerTenantId } }), 0)
  }
}))

async function waitForAdvisoryWait(client: pg.Client, key: string) {
  for (let attempt=0; attempt<100; attempt++) {
    const waiting = await client.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
      AND objid=(hashtext($1)::bigint & 4294967295) LIMIT 1`, [key])
    if (waiting.rowCount) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Synthetic lock ordering was not observed')
}

test('global ensure is idempotent under concurrency/lost acknowledgement and never regenerates retired or destroyed keys', { skip: !enabled }, () => fixture(async ({ scope, store, prisma }) => {
  const keys = await Promise.all(Array.from({ length: 5 }, () => store.ensureVersion(scope, deadline())))
  assert.equal(new Set(keys.map(k => k.id)).size, 1)
  const key = keys[0]!
  assert.equal((await store.ensureVersion(scope, deadline())).id, key.id, 'Lost-ack retry reloads exact immutable winner')
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { customerTenantId: scope.customerTenantId } }), 1)
  await store.retireOrDestroy(key, false, deadline())
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  await store.retireOrDestroy(key, true, deadline())
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { customerTenantId: scope.customerTenantId } }), 1)
}))

test('missing/damaged key material is unavailable, not an automatic new key; pilot versions preserve hvr1 identities globally', { skip: !enabled }, () => fixture(async ({ scope, store, client }) => {
  delete process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT
  process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'wrapped-pilot-v1'
  process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = JSON.stringify({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, expiresAt: new Date(Date.now()+3_600_000).toISOString() })
  const key = await store.createVersion(scope, randomUUID(), deadline())
  const provider = new WrappedRiskPseudonymProvider(store)
  const first = await provider.pin(key, deadline()); const oldRef = await first.reference('mailbox', ['synthetic-mailbox']); first.close?.()
  delete process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
  process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT = 'global'; process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'wrapped-v1'
  assert.equal((await store.ensureVersion(scope, deadline())).id, key.id)
  const second = await provider.pin(key, deadline()); assert.equal(await second.reference('mailbox', ['synthetic-mailbox']), oldRef); second.close?.()
  process.env.SECRET_ENCRYPTION_KEY = '53'.repeat(32)
  await assert.rejects(() => provider.pin(key, deadline()), /KEY_UNAVAILABLE/)
  assert.equal((await store.ensureVersion(scope, deadline())).id, key.id)
  process.env.SECRET_ENCRYPTION_KEY = '52'.repeat(32)
  await client.query('DELETE FROM identity_risk_wrapped_keys WHERE key_version_id=$1', [key.id])
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
}))

test('foreign, suspended, disconnected and deleted scopes fail closed without enrollment', { skip: !enabled }, () => fixture(async ({ scope, store, prisma }) => {
  await assert.rejects(() => store.ensureVersion({ ...scope, organizationId: randomUUID() }, deadline()), /KEY_UNAVAILABLE/)
  await assert.rejects(() => store.ensureVersion({ ...scope, environment: 'foreign' }, deadline()), /KEY_UNAVAILABLE/)
  await prisma.organization.update({ where: { id: scope.organizationId }, data: { status: 'SUSPENDED' } })
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  await prisma.organization.update({ where: { id: scope.organizationId }, data: { status: 'ACTIVE' } })
  await prisma.tenantConnection.updateMany({ where: { customerTenantId: scope.customerTenantId }, data: { status: 'REVOKED' } })
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  await prisma.customerTenant.delete({ where: { id: scope.customerTenantId } })
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { organizationId: scope.organizationId } }), 0)
}))

test('global/tenant stop before provisioning denies key creation', { skip: !enabled }, () => fixture(async ({ scope, store, prisma }) => {
  const safety = new IdentityRiskSafetyService(prisma)
  await safety.activate({ controlType: 'EVALUATION_HARD_DISABLED', scope: { type: 'TENANT', ...scope },
    reasonCode: 'CROSS_TENANT_SCOPE_FAILURE', actorServiceId: 'synthetic-test' })
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { customerTenantId: scope.customerTenantId } }), 0)
}))

test('global stop guard is database-backed without publishing a global stop to parallel fixtures', { skip: !enabled }, () => fixture(async ({ scope, store, client }) => {
  await client.query('BEGIN')
  try {
    await client.query(`INSERT INTO identity_risk_operational_controls
      (id,control_type,scope_type,scope_key,state,episode_id,reason_code,actor_service_id,activated_at,created_at,updated_at)
      VALUES ($1,'EVALUATION_HARD_DISABLED','GLOBAL','GLOBAL','ACTIVE',$2,'MANUAL_SECURITY_CONTROL','synthetic-test',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [randomUUID(), randomUUID()])
    await assert.rejects(() => (store as any).assertAutomaticScope(client, scope), /KEY_UNAVAILABLE/)
  } finally { await client.query('ROLLBACK') }
}))

test('absolute key/cursor SQL deadline cancels actual database work, not only the awaiting Promise', { skip: !enabled }, () => fixture(async ({ client }) => {
  const start=Date.now()
  await assert.rejects(() => withRiskKeyTransaction(start+400, c=>c.query('SELECT pg_sleep(10) /* synthetic-global-cycle-deadline */')), /SOURCE_UNAVAILABLE/)
  assert.ok(Date.now()-start<2_000,'Bounded transport/statement must stop promptly')
  const remaining=await client.query(`SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid()
    AND state='active' AND application_name='hawkview-mailbox-risk-read' AND query LIKE '%synthetic-global-cycle-deadline%'`)
  assert.equal(remaining.rows[0].count,'0')
}))

test('creation first is serialized before stop; completed stop prevents all later enrollment', { skip: !enabled }, () => fixture(async ({ scope, store, prisma, client }) => {
  const keyLock = `risk-key:${scope.environment}:${scope.organizationId}:${scope.customerTenantId}`
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [keyLock])
  const creating = store.ensureVersion(scope, deadline())
  await waitForAdvisoryWait(client, keyLock)
  const stop = new IdentityRiskSafetyService(prisma).activate({ controlType: 'EVALUATION_HARD_DISABLED',
    scope: { type: 'TENANT', ...scope }, reasonCode: 'CROSS_TENANT_SCOPE_FAILURE', actorServiceId: 'synthetic-test' })
  await waitForAdvisoryWait(client, `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${scope.organizationId}:${scope.customerTenantId}`)
  await client.query('COMMIT')
  const key = await creating; await stop
  assert.ok(key.id)
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { customerTenantId: scope.customerTenantId } }), 1)
}))

test('creation/deletion ordering cannot leave orphan or silently recreate deleted tenant key', { skip: !enabled }, () => fixture(async ({ scope, store, prisma, client }) => {
  const keyLock = `risk-key:${scope.environment}:${scope.organizationId}:${scope.customerTenantId}`
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [keyLock])
  const creating = store.ensureVersion(scope, deadline())
  await waitForAdvisoryWait(client, keyLock)
  const deleting = prisma.customerTenant.delete({ where: { id: scope.customerTenantId } })
  // Prisma promises are lazy; start the deletion while the enrollment owns row locks.
  const deleted = deleting.then(() => undefined)
  await client.query('COMMIT'); await creating; await deleted
  assert.equal(await prisma.identityRiskPseudonymKeyVersion.count({ where: { organizationId: scope.organizationId } }), 0)
  await assert.rejects(() => store.ensureVersion(scope, deadline()), /KEY_UNAVAILABLE/)
}))

test('global projector/commit preserves actual source evidence; changed or stale attestation cannot produce current findings', { skip: !enabled }, () => fixture(async ({ scope, store, prisma, client }) => {
  const key = await store.ensureVersion(scope, deadline())
  const now = new Date(); const rules = [mailboxRule(undefined, { mailboxUserId: randomUUID() })]
  // Match the production collector's explicit UTC transaction. Local fixture
  // DB intentionally retains its non-UTC default to catch adapter regressions.
  await prisma.$transaction(async tx => {
  await enforceRiskUtcTransaction(tx)
  for (const resource of MAILBOX_SOURCE_RESOURCES) {
    const payload = resource === 'EXCHANGE_MAILBOX_RULES' ? rules : [{ domain: 'tenant.invalid' }]
    await tx.tenantEntraSnapshot.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, resourceType: resource, payload: payload as never, observedAt: now } })
    await tx.tenantCollectionFieldState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      fieldKey: sourceAttestationKey(resource), state: 'COMPLETE', source: MAILBOX_SOURCE_VERSION,
      correlationId: mailboxSourceDigest(scope, resource, now, payload), lastSuccessfulAt: now } })
    await tx.syncState.create({ data: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      resourceType: resource, status: 'SUCCEEDED', lastAttemptAt: now, lastSuccessfulAt: now } })
  }
  })
  const sourceChecks = await client.query(`SELECT s.resource_type,s.observed_at,s.payload,f.correlation_id,f.last_successful_at
    FROM tenant_entra_snapshots s JOIN tenant_collection_field_states f ON f.customer_tenant_id=s.customer_tenant_id
    AND f.field_key='identity-risk/v1/'||s.resource_type::text WHERE s.customer_tenant_id=$1`, [scope.customerTenantId])
  for (const row of sourceChecks.rows) {
    assert.equal(row.observed_at.getTime(), now.getTime(), 'Synthetic persisted source clock')
    assert.equal(row.last_successful_at.getTime(), now.getTime(), 'Synthetic attestation clock')
    assert.equal(row.correlation_id, mailboxSourceDigest(scope, row.resource_type, now, row.payload), 'Synthetic stored digest')
  }
  const projector = new MailboxRiskProjector(new WrappedRiskPseudonymProvider(store))
  const sourceScope = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }
  const batch = await projector.load(sourceScope, now)
  assert.equal(batch.capability, 'FULL'); assert.equal(batch.pseudonymKeyVersionId, key.id)
  const evaluator = new IdentityRiskEvaluatorService(prisma, new IdentityRiskSafetyService(prisma), { now: () => new Date() })
  const request = { ...scope, evaluationAt: now, windowStart: new Date(now.getTime()-86_400_000), windowEnd: now,
    engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    loadSources: async () => batch, detectors: approvedIdentitySignalDetectors({ readiness: 'READY', featureFlags: MAILBOX_FIRST_SLICE_FLAGS }) }
  await prisma.tenantCollectionFieldState.updateMany({ where: { customerTenantId: scope.customerTenantId, fieldKey: sourceAttestationKey('EXCHANGE_MAILBOX_RULES') }, data: { state: 'UNAVAILABLE' } })
  await assert.rejects(() => evaluator.evaluate({ ...request, executionDeadlineAt: Date.now()+15_000 }), /SOURCE_UNAVAILABLE/)
  assert.equal(await prisma.identityRiskFinding.count({ where: { customerTenantId: scope.customerTenantId } }), 0)
  await prisma.tenantCollectionFieldState.updateMany({ where: { customerTenantId: scope.customerTenantId, fieldKey: sourceAttestationKey('EXCHANGE_MAILBOX_RULES') }, data: { state: 'COMPLETE' } })
  assert.equal((await evaluator.evaluate({ ...request, executionDeadlineAt: Date.now()+15_000 })).status, 'COMPLETED')
  assert.equal(await prisma.identityRiskFinding.count({ where: { customerTenantId: scope.customerTenantId } }), 1)
  const stale = await projector.load(sourceScope, new Date(now.getTime()+36*3_600_000+1))
  assert.equal(stale.capability, 'UNAVAILABLE')
  await assert.rejects(() => evaluator.evaluate({ ...request, executionDeadlineAt: Date.now()-1 }), /CYCLE_DEFERRED/)
}))

// Windows creates a real bounded connection for each of 1,005 operations. This
// test timebox does not change the runtime 45-second/five-candidate cycle cap.
test('durable keyset advances beyond 1000 including failed/ineligible tenants, overlap/CAS, crash recovery and lower-ID insertion', { skip: !enabled, timeout: 180_000 }, () => fixture(async ({ scope, prisma, client }) => {
  const rows = Array.from({ length: 1_005 }, (_, i) => ({ id: `f0000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    organizationId: scope.organizationId, microsoftTenantId: randomUUID(), displayName: 'Synthetic cursor scope', status: 'PENDING' as const }))
  await prisma.customerTenant.createMany({ data: rows })
  const work = new RiskGlobalWorkStore(); const lease = await work.claimCycle(deadline()); assert.ok(lease)
  assert.equal(await work.claimCycle(deadline()), null, 'Overlap does not own a second cycle')
  // Jump to the first synthetic candidate to avoid unrelated fixture rows;
  // production has no offset/reset path and advances one scanned item at a time.
  await client.query('UPDATE identity_risk_scheduler_cursors SET after_tenant_id=$2 WHERE environment=$1', [scope.environment, 'efffffff-ffff-ffff-ffff-ffffffffffff'])
  for (const expected of rows) {
    assert.equal((await work.nextScope(lease, deadline()))?.customerTenantId, expected.id)
  }
  const low = { ...rows[0]!, id: 'e0000000-0000-0000-0000-000000000001', microsoftTenantId: randomUUID() }
  await prisma.customerTenant.create({ data: low })
  // Expire a crashed worker; its stale CAS cannot consume work or release successor.
  await client.query("UPDATE identity_risk_scheduler_cursors SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE environment=$1", [scope.environment])
  const successor = await work.claimCycle(deadline()); assert.ok(successor)
  await assert.rejects(() => work.nextScope(lease, deadline()), /SOURCE_UNAVAILABLE/)
  await work.releaseCycle(lease, deadline())
  assert.equal(await work.claimCycle(deadline()), null)
  let wrapped = false; let foundLow = false
  for (let i=0; i<2_100; i++) {
    const next = await work.nextScope(successor, deadline())
    if (!next) wrapped = true
    if (next?.customerTenantId === low.id) { foundLow = true; break }
  }
  assert.equal(wrapped, true); assert.equal(foundLow, true)
  await work.releaseCycle(successor, deadline())
}))
