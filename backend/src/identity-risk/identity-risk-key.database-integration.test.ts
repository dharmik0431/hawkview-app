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
import { mailboxSourceDigest, sourceAttestationKey, MAILBOX_SOURCE_VERSION, MAILBOX_SOURCE_RESOURCES } from './mailbox-source-attestation.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'

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
    process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'; process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
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
      const projector = new MailboxRiskProjector(prisma, syntheticManagedProvider())
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
    }
  })
