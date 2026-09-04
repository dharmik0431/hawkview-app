import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS } from './mailbox-risk-projector.service.js'
import { IdentityRiskEvaluationScheduler, IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { IdentityRiskService } from './identity-risk.service.js'
import { mailboxRule, syntheticManagedProvider } from './mailbox-risk.test-fixtures.js'
import { mailboxSourceDigest, sourceAttestationKey, MAILBOX_SOURCE_VERSION, MAILBOX_SOURCE_RESOURCES, MAILBOX_SOURCE_MAX_AGE_MS } from './mailbox-source-attestation.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'
import { approvedIdentitySignalDetectors } from './identity-risk-approved-evaluator.adapter.js'
import { projectMailboxEvidence, readActiveMailboxKeys } from './mailbox-risk-projector.service.js'
import { attested } from './mailbox-risk.test-fixtures.js'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'

test('registry deadline cancels the actual blocked PostgreSQL statement, not an abandoned promise',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1', timeout: 10000 }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local/CI PostgreSQL only')
    const locker = new pg.Client({ connectionString: url.toString() })
    const prisma = new PrismaService()
    await locker.connect(); await prisma.$connect()
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE identity_risk_pseudonym_key_versions IN ACCESS EXCLUSIVE MODE')
      const scope = { organizationId: randomUUID(), customerTenantId: randomUUID() }
      const started = Date.now()
      pending = readActiveMailboxKeys(scope, 'test', new Date(), started + 1500)
      const rejected = assert.rejects(pending, /IDENTITY_RISK_KEY_UNAVAILABLE/)
      const waitingQuery = `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND state='active' AND wait_event_type='Lock' AND query LIKE '%identity_risk_pseudonym_key_versions%'`
      let observedWaiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        await locker.query('SELECT pg_stat_clear_snapshot()')
        if ((await locker.query(waitingQuery)).rows[0].count > 0) { observedWaiting = true; break }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(observedWaiting, true)
      await rejected
      assert.ok(Date.now() - started < 2500, 'registry operation must settle within a bounded deadline')
      // The exclusive lock is STILL held. Zero waiters proves query cancellation,
      // rather than releasing the lock to let an abandoned request finish later.
      await locker.query('SELECT pg_stat_clear_snapshot()')
      assert.equal((await locker.query(waitingQuery)).rows[0].count, 0)
      await locker.query('ROLLBACK')
      assert.deepEqual(await readActiveMailboxKeys(scope, 'test', new Date(), Date.now() + 6000), [])
      await assert.rejects(() => withMailboxReadTransaction(Date.now() + 6000, 5000, async (client) => {
        assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
        assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read')
        assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC')
        // PostgreSQL must reject even a zero-row write; no fixture mutation.
        await client.query('DELETE FROM identity_risk_pseudonym_key_versions WHERE false')
      }), /IDENTITY_RISK_SOURCE_UNAVAILABLE/)
      assert.deepEqual(await readActiveMailboxKeys(scope, 'test', new Date(), Date.now() + 6000), [])
    } finally {
      await locker.query('ROLLBACK')
      await pending?.catch(() => undefined)
      await locker.end(); await prisma.$disconnect()
    }
  })

test('real concurrent key revocation serializes with claim/persist and never publishes after a winning revoke',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1', timeout: 30000 }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local/CI PostgreSQL only')
    const prisma = new PrismaService()
    const revoker = new pg.Client({ connectionString: url.toString() })
    await revoker.connect()
    const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
    process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
    try {
      const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      for (const phase of ['claim', 'persist'] as const) for (const timing of ['before', 'after'] as const) {
        const scope = { organizationId: randomUUID(), customerTenantId: randomUUID() }
        const keyId = randomUUID(); const now = new Date(); const observedAt = new Date(now.getTime() - 1000)
        let release!: () => void; let reached!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const reachedGate = new Promise<void>((resolve) => { reached = resolve })
        let running: Promise<{ status: string }> | undefined
        let revocation: Promise<unknown> | undefined
        try {
          await prisma.organization.create({ data: { id: scope.organizationId, name: 'Synthetic race', slug: `risk-${scope.organizationId}` } })
          await prisma.customerTenant.create({ data: { id: scope.customerTenantId, organizationId: scope.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' } })
          const key = await prisma.identityRiskPseudonymKeyVersion.create({ data: { id: keyId, ...scope, environment: 'test', provider: 'AWS_KMS_HMAC_256',
            immutableKeyId: `arn:aws:kms:us-east-1:000000000000:key/${keyId}`, status: 'ACTIVE', activatedAt: observedAt } })
          const session = await syntheticManagedProvider().pin({ ...key, provider: 'AWS_KMS_HMAC_256' }, Date.now() + 30000)
          const snapshots = [attested('EXCHANGE_MAILBOX_RULES', [mailboxRule()], observedAt),
            attested('EXCHANGE_ACCEPTED_DOMAINS', [{ domain: 'tenant.invalid' }], observedAt)].map((row) => ({ ...row, ...scope }))
          for (const row of snapshots) row.digest = mailboxSourceDigest(scope, row.resourceType, observedAt, row.payload)
          const batch = await projectMailboxEvidence(scope, now, snapshots, session)
          let keyReads = 0
          // The real transaction/query and row lock run unchanged. Only pause at
          // their boundary so a second PostgreSQL connection can revoke the key.
          const instrumented = new Proxy(prisma, { get(target, property) {
            if (property === '$transaction') return (callback: (tx: unknown) => Promise<unknown>) => target.$transaction(async (tx) => callback(new Proxy(tx, {
              get(transaction, field) {
                if (field === '$queryRaw') return async (...args: unknown[]) => {
                  const sql = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : ''
                  const targetRead = sql.includes('identity_risk_pseudonym_key_versions') && sql.includes('FOR SHARE') && ++keyReads === (phase === 'claim' ? 1 : 2)
                  if (targetRead && timing === 'before') { reached(); await gate }
                  const result = await Reflect.apply(transaction.$queryRaw, transaction, args)
                  if (targetRead && timing === 'after') { reached(); await gate }
                  return result
                }
                const value = Reflect.get(transaction, field)
                return typeof value === 'function' ? value.bind(transaction) : value
              },
            })), { timeout: 10000 })
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          } }) as PrismaService
          const detector = approvedIdentitySignalDetectors({ readiness: 'READY', featureFlags: MAILBOX_FIRST_SLICE_FLAGS })[0]!
          running = new IdentityRiskEvaluatorService(instrumented, new IdentityRiskSafetyService(prisma), { now: () => now }).evaluate({ ...scope,
            evaluationAt: now, windowStart: new Date(now.getTime() - 86400000), windowEnd: now,
            engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION, loadSources: async () => batch,
            detectors: [{ ...detector, evaluate: async (context) => {
              if (phase === 'claim' && timing === 'after') await revocation
              return detector.evaluate(context)
            } }],
          }).catch(() => ({ status: 'REJECTED' }))
          await Promise.race([reachedGate, running.then(() => { throw new Error('Evaluator exited before race gate') })])
          revocation = revoker.query("UPDATE identity_risk_pseudonym_key_versions SET status='DISABLED' WHERE id=$1", [keyId])
          if (timing === 'before') await revocation
          else {
            let waiting = false
            for (let attempt = 0; attempt < 100; attempt++) {
              const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`
              if (rows[0]?.waiting) { waiting = true; break }
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            assert.equal(waiting, true, 'revocation must actually block on the production FOR SHARE row lock')
          }
          release()
          const result = await running
          await revocation
          const completedFirst = phase === 'persist' && timing === 'after'
          assert.equal(result.status, completedFirst ? 'COMPLETED' : 'REJECTED', `${phase}/${timing}`)
          assert.equal(await prisma.identityRiskFinding.count({ where: scope }), completedFirst ? 1 : 0)
          assert.equal(await prisma.identityRiskMatchedResult.count({ where: scope }), completedFirst ? 1 : 0)
          assert.equal(await prisma.identityRiskRuleCoverage.count({ where: scope }), completedFirst ? 1 : 0)
          const runs = await prisma.identityRiskEvaluationRun.findMany({ where: scope })
          assert.equal(runs.length, phase === 'claim' && timing === 'before' ? 0 : 1)
          if (runs.length) assert.equal(runs[0]?.status, completedFirst ? 'COMPLETED' : 'FAILED')
          assert.equal((await prisma.identityRiskPseudonymKeyVersion.findUnique({ where: { id: keyId } }))?.status, 'DISABLED')
          assert.equal((await new IdentityRiskSafetyService(prisma).stateForTenant(scope.organizationId, scope.customerTenantId)).evaluationHardDisabled, false)
        } finally {
          release()
          await running
          await revocation
          await prisma.organization.deleteMany({ where: { id: scope.organizationId } })
        }
      }
    } finally {
      await revoker.end(); await prisma.$disconnect()
      if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE; else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
    }
  })

test('managed key versions preserve actual finding-result-run lookup, legacy nulls, rotation and tenant isolation',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local/CI PostgreSQL only')
    const client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
    const schema = `risk_key_${randomUUID().replaceAll('-', '')}`
    assert.match(schema, /^risk_key_[a-f0-9]{32}$/)
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      await client.query('CREATE TABLE organizations (id uuid PRIMARY KEY); CREATE TABLE customer_tenants (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, UNIQUE(id,organization_id))')
      await client.query(await readFile(new URL('../../prisma/migrations/20260902090000_add_identity_risk_platform/migration.sql', import.meta.url), 'utf8'))
      const org = randomUUID(); const tenant = randomUUID(); const foreignOrg = randomUUID(); const foreignTenant = randomUUID()
      await client.query('INSERT INTO organizations VALUES ($1),($2)', [org, foreignOrg])
      await client.query('INSERT INTO customer_tenants VALUES ($1,$2),($3,$4)', [tenant, org, foreignTenant, foreignOrg])
      const legacyRun = randomUUID()
      const createRun = async (id: string, key: string | null, otherOrg = org, otherTenant = tenant) => client.query(`INSERT INTO identity_risk_evaluation_runs
        (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,window_start,window_end,source_watermark_hash,source_content_hash,expires_at,completed_at,pseudonym_key_version_id)
        VALUES ($1::uuid,$2,$3,$1::uuid::text,'hawkview-identity-engine/1','hawkview-identity-signals/v1','COMPLETED',now()-interval '1 hour',now(),'watermark','content',now()+interval '1 hour',now(),$4)`, [id, otherOrg, otherTenant, key])
      await client.query(`INSERT INTO identity_risk_evaluation_runs (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,window_start,window_end,source_watermark_hash,source_content_hash,expires_at)
        VALUES ($1,$2,$3,'legacy','v','v','FAILED',now()-interval '1 hour',now(),'w','c',now()+interval '1 hour')`, [legacyRun, org, tenant])
      await client.query(await readFile(new URL('../../prisma/migrations/20260904090000_identity_risk_pseudonym_versions/migration.sql', import.meta.url), 'utf8'))
      const schemaSource = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
      assert.match(schemaSource, /@@index\(\[pseudonymKeyVersionId, organizationId, customerTenantId\], map: "identity_risk_runs_key_version"\)/)
      const index = await client.query('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2', [schema, 'identity_risk_runs_key_version'])
      assert.match(index.rows[0]?.indexdef, /\(pseudonym_key_version_id, organization_id, customer_tenant_id\)/)
      assert.equal((await client.query('SELECT pseudonym_key_version_id FROM identity_risk_evaluation_runs WHERE id=$1', [legacyRun])).rows[0].pseudonym_key_version_id, null)
      const firstKey = randomUUID(); const secondKey = randomUUID()
      const createKey = (id: string) => client.query(`INSERT INTO identity_risk_pseudonym_key_versions
        (id,organization_id,customer_tenant_id,environment,provider,immutable_key_id,status,activated_at)
        VALUES ($1,$2,$3,'test','AWS_KMS_HMAC_256',$4,'ACTIVE',now())`, [id, org, tenant, `arn:aws:kms:us-east-1:000000000000:key/${id}`])
      await createKey(firstKey)
      await assert.rejects(() => createKey(secondKey), /identity_risk_keys_one_active/)
      await assert.rejects(() => client.query('UPDATE identity_risk_pseudonym_key_versions SET immutable_key_id=$1 WHERE id=$2', ['changed', firstKey]), /immutable/)
      await assert.rejects(() => createRun(randomUUID(), firstKey, foreignOrg, foreignTenant), /identity_risk_run_key_scope_fk/)
      const run = randomUUID(); const match = randomUUID(); const finding = randomUUID()
      await createRun(run, firstKey)
      const subject = `hvr1_mailbox_${'a'.repeat(64)}`
      await client.query(`INSERT INTO identity_risk_matched_results (id,organization_id,customer_tenant_id,evaluation_run_id,result_key,rule_id,subject_type,subject_id,severity,confidence,coverage,observed_at,expires_at)
        VALUES ($1,$2,$3,$4,'result','HV-ID-MBX-001.v1','MAILBOX',$5,'HIGH','HIGH','FULL',now(),now()+interval '1 hour')`, [match, org, tenant, run, subject])
      await client.query(`INSERT INTO identity_risk_findings (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,subject_type,subject_id,severity,confidence,coverage,observed_at,expires_at)
        VALUES ($1,$2,$3,$4,'finding','HV-ID-MBX-001.v1','v1','MAILBOX',$5,'HIGH','HIGH','FULL',now(),now()+interval '1 hour')`, [finding, org, tenant, match, subject])
      const lookup = (organizationId: string) => client.query(`SELECT k.id,k.immutable_key_id FROM identity_risk_findings f
        JOIN identity_risk_matched_results m ON (m.id,m.organization_id,m.customer_tenant_id)=(f.matched_result_id,f.organization_id,f.customer_tenant_id)
        JOIN identity_risk_evaluation_runs r ON (r.id,r.organization_id,r.customer_tenant_id)=(m.evaluation_run_id,m.organization_id,m.customer_tenant_id)
        JOIN identity_risk_pseudonym_key_versions k ON (k.id,k.organization_id,k.customer_tenant_id)=(r.pseudonym_key_version_id,r.organization_id,r.customer_tenant_id)
        WHERE f.id=$1 AND f.organization_id=$2 AND f.customer_tenant_id=$3`, [finding, organizationId, tenant])
      assert.equal((await lookup(org)).rows[0].id, firstKey)
      assert.equal((await lookup(foreignOrg)).rowCount, 0)
      await client.query("UPDATE identity_risk_pseudonym_key_versions SET status='RETIRED',retired_at=now() WHERE id=$1", [firstKey])
      await createKey(secondKey)
      await createRun(randomUUID(), secondKey)
      assert.equal((await lookup(org)).rows[0].id, firstKey)
      await assert.rejects(() => client.query('DELETE FROM identity_risk_pseudonym_key_versions WHERE id=$1', [firstKey]), /identity_risk_run_key_scope_fk/)
      await client.query('DELETE FROM organizations WHERE id=$1', [org])
      assert.equal((await lookup(org)).rowCount, 0)
      assert.equal((await client.query('SELECT id FROM organizations WHERE id=$1', [foreignOrg])).rowCount, 1)
    } finally {
      await client.query('SET search_path TO public')
      await client.query(`DROP SCHEMA "${schema}" CASCADE`)
      await client.end()
    }
  })

test('real scoped snapshot reader -> managed test MAC -> approved evaluator -> PostgreSQL -> authorized v1 API',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1' }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local/CI PostgreSQL only')
    const prisma = new PrismaService()
    const organizationId = randomUUID(); const customerTenantId = randomUUID(); const userId = randomUUID(); const subject = randomUUID()
    const scope = { organizationId, customerTenantId }; const keyId = randomUUID()
    const now = new Date(); const observedAt = new Date(now.getTime() - 1000)
    const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE; const previousEnvironment = process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    const previousProvider = process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER; const previousPilot = process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
    process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'; process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
    process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'managed-kms'
    process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = JSON.stringify({ ...scope, expiresAt: new Date(now.getTime() + 86400000).toISOString() })
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Synthetic risk test', slug: `risk-${organizationId}` } })
      await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' } })
      await prisma.user.create({ data: { id: userId, authProviderUserId: subject, email: `${subject}@example.invalid` } })
      await prisma.membership.create({ data: { organizationId, userId, role: 'MSP_OWNER', status: 'ACTIVE' } })
      await prisma.identityRiskPseudonymKeyVersion.create({ data: { id: keyId, ...scope, environment: 'test', provider: 'AWS_KMS_HMAC_256',
        immutableKeyId: `arn:aws:kms:us-east-1:000000000000:key/${keyId}`, status: 'ACTIVE', activatedAt: observedAt } })
      for (const resourceType of MAILBOX_SOURCE_RESOURCES) {
        const payload = resourceType === 'EXCHANGE_MAILBOX_RULES' ? [mailboxRule()] : [{ domain: 'tenant.invalid' }]
        await prisma.tenantEntraSnapshot.create({ data: { ...scope, resourceType, payload, observedAt } })
        await prisma.syncState.create({ data: { ...scope, resourceType, status: 'SUCCEEDED', lastSuccessfulAt: now, lastAttemptAt: observedAt } })
        await prisma.tenantCollectionFieldState.create({ data: { ...scope, fieldKey: sourceAttestationKey(resourceType), state: 'COMPLETE', source: MAILBOX_SOURCE_VERSION,
          correlationId: mailboxSourceDigest(scope, resourceType, observedAt, payload), lastSuccessfulAt: observedAt } })
      }
      const projector = new MailboxRiskProjector(syntheticManagedProvider())
      const storedTime = await withMailboxReadTransaction(Date.now() + 6000, 5000, async (client) =>
        (await client.query('SELECT activated_at, $2::timestamptz AS compared_at, activated_at <= $2 AS eligible FROM identity_risk_pseudonym_key_versions WHERE id=$1', [keyId, now])).rows[0])
      assert.equal(storedTime?.eligible, true, JSON.stringify(storedTime))
      const activeKeys = await readActiveMailboxKeys(scope, 'test', now, Date.now() + 6000)
      assert.deepEqual(activeKeys.map(({ id, organizationId, customerTenantId, environment, provider }) => ({ id, organizationId, customerTenantId, environment, provider })),
        [{ id: keyId, ...scope, environment: 'test', provider: 'AWS_KMS_HMAC_256' }])
      const batch = await projector.load(scope, now)
      assert.equal(batch.capability, 'FULL')
      const safety = new IdentityRiskSafetyService(prisma)
      const scheduler = new IdentityRiskEvaluationScheduler(new IdentityRiskEvaluatorService(prisma, safety, { now: () => now }))
      const request = { ...scope, evaluationAt: now, windowEnd: now, windowStart: new Date(now.getTime() - 86400000),
        engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION, loadSources: () => projector.load(scope, now),
        approvedEvaluator: { readiness: 'READY' as const, featureFlags: MAILBOX_FIRST_SLICE_FLAGS } }
      assert.equal((await scheduler.runTenant(request)).status, 'COMPLETED')
      assert.equal((await scheduler.runTenant(request)).status, 'REPLAYED')
      const rows = await prisma.identityRiskFinding.findMany({ where: scope, include: { matchedResult: { include: { evaluationRun: { include: { pseudonymKeyVersion: true } } } } } })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.matchedResult.evaluationRun.pseudonymKeyVersion?.id, keyId)
      const page = await new IdentityRiskService(prisma).findings({ subject, email: `${subject}@example.invalid` }, customerTenantId)
      assert.equal(page.status, 'AVAILABLE'); assert.equal(page.findings.length, 1)
      assert.equal(page.observedAt, observedAt.toISOString())
      await assert.rejects(() => new IdentityRiskService(prisma).findings({ subject: randomUUID(), email: 'foreign@example.invalid' }, customerTenantId))
      const writer = new pg.Client({ connectionString: url.toString() })
      await writer.connect()
      const previousTZ = process.env.TZ
      const previousDatabaseUrl = process.env.DATABASE_URL
      try {
        for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
          process.env.TZ = zone
          const startupUrl = new URL(url)
          startupUrl.searchParams.set('options', `-c timezone=${zone}`)
          process.env.DATABASE_URL = startupUrl.toString()
          await writer.query("SELECT set_config('TimeZone', $1, false)", [zone])
          for (const age of [1000, MAILBOX_SOURCE_MAX_AGE_MS, MAILBOX_SOURCE_MAX_AGE_MS + 1, -300000, -300001]) {
            const observation = new Date(now.getTime() - age)
            await writer.query('BEGIN')
            for (const resource of MAILBOX_SOURCE_RESOURCES) {
              const payload = resource === 'EXCHANGE_MAILBOX_RULES' ? [mailboxRule()] : [{ domain: 'tenant.invalid' }]
              await writer.query('UPDATE tenant_entra_snapshots SET observed_at=$1::timestamptz WHERE organization_id=$2 AND customer_tenant_id=$3 AND resource_type::text=$4',
                [observation, organizationId, customerTenantId, resource])
              await writer.query('UPDATE tenant_collection_field_states SET last_successful_at=$1::timestamptz,correlation_id=$2 WHERE organization_id=$3 AND customer_tenant_id=$4 AND field_key=$5',
                [observation, mailboxSourceDigest(scope, resource, observation, payload), organizationId, customerTenantId, sourceAttestationKey(resource)])
              await writer.query('UPDATE sync_states SET last_successful_at=$1::timestamptz,last_attempt_at=$1::timestamptz WHERE organization_id=$2 AND customer_tenant_id=$3 AND resource_type::text=$4',
                [observation, organizationId, customerTenantId, resource])
            }
            await writer.query('COMMIT')
            // UTC Prisma connection and native loader must see the same instant,
            // regardless of writer-session or Node process timezone.
            const prismaSnapshot = await prisma.tenantEntraSnapshot.findFirst({ where: { ...scope, resourceType: 'EXCHANGE_MAILBOX_RULES' } })
            assert.equal(prismaSnapshot?.observedAt.getTime(), observation.getTime())
            const projected = await projector.load(scope, now)
            const expected = age <= MAILBOX_SOURCE_MAX_AGE_MS && age >= -300000 ? 'FULL' : 'UNAVAILABLE'
            assert.equal(projected.capability, expected, `${zone}/${age}`)
            if (expected === 'FULL') {
              assert.equal(projected.sourceObservedAt?.getTime(), observation.getTime())
              assert.equal(projected.earliestSourceExpiry?.getTime(), observation.getTime() + MAILBOX_SOURCE_MAX_AGE_MS)
            }
          }
        }
        // Historical writer/session drift cannot be silently reinterpreted as
        // fresh evidence: even otherwise-fresh timestamp drift breaks attestation.
        await writer.query('UPDATE tenant_entra_snapshots SET observed_at=$1 WHERE organization_id=$2 AND customer_tenant_id=$3', [now, organizationId, customerTenantId])
        assert.equal((await projector.load(scope, now)).capability, 'UNAVAILABLE')
      } finally {
        await writer.query('ROLLBACK'); await writer.end()
        if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl
      }
      await prisma.tenantCollectionFieldState.deleteMany({ where: { ...scope, fieldKey: sourceAttestationKey('EXCHANGE_MAILBOX_RULES') } })
      assert.equal((await projector.load(scope, now)).capability, 'UNAVAILABLE')
      await prisma.identityRiskPseudonymKeyVersion.update({ where: { id: keyId }, data: { status: 'DISABLED' } })
      await assert.rejects(() => projector.load(scope, now), /KEY_UNAVAILABLE/)
    } finally {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.$disconnect()
      if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE; else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
      if (previousEnvironment === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT; else process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = previousEnvironment
      if (previousProvider === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER; else process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = previousProvider
      if (previousPilot === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE; else process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = previousPilot
    }
  })
