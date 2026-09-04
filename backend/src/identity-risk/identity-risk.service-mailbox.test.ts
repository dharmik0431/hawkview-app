import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import type { MailboxInvestigationResolver } from './mailbox-investigation-resolver.js'
import { IdentityRiskService } from './identity-risk.service.js'

const identity = { subject: 'owner-auth', email: 'owner@example.invalid' }
const org = '11111111-1111-4111-8111-111111111111'
const tenant = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const subject = `hvr1_mailbox_${'a'.repeat(64)}`

function fixture(options: {
  role?: string; foreign?: boolean; disabled?: boolean; missing?: boolean;
  stale?: boolean; missingKey?: boolean; missingSource?: boolean; partial?: boolean;
  mismatch?: boolean; resolverThrows?: boolean; label?: string; hardDisableAfter?: number;
  expiredRun?: boolean; revokeAfterResolve?: boolean;
  utcFailure?: boolean;
} = {}) {
  const now = new Date()
  const sourceObservedAt = new Date(now.getTime() - (options.stale ? 37 * 3600_000 : 1000))
  const calls: { where?: any; resolved: number; reads: number; controls: number; args?: unknown[]; order: string[] } = { resolved: 0, reads: 0, controls: 0, order: [] }
  const models = {
    $executeRawUnsafe: async () => { calls.order.push('utc-set'); return 0 },
    $queryRawUnsafe: async () => { calls.order.push('utc-confirm'); return [{ timezone: options.utcFailure ? 'America/New_York' : 'UTC' }] },
    user: { findUnique: async () => ({ disabledAt: options.disabled ? now : null, memberships: [{ organizationId: org, role: options.revokeAfterResolve && calls.resolved ? 'MSP_VIEWER' : options.role ?? 'MSP_OWNER' }] }) },
    customerTenant: { findFirst: async () => options.foreign ? null : ({ id: tenant, organizationId: org }) },
    identityRiskOperationalControl: { findMany: async () => ++calls.controls >= (options.hardDisableAfter ?? Infinity) ? [{ controlType: 'EVALUATION_HARD_DISABLED' }] : [] },
    identityRiskEvaluationRun: { findFirst: async () => {
      calls.reads++
      calls.order.push('run-read')
      if (options.expiredRun) return null
      return { id: runId, engineVersion: 'hawkview-identity-engine/1', catalogVersion: 'hawkview-identity-signals/v1', capability: options.partial ? 'PARTIAL' : 'FULL', completedAt: now, sourceObservedAt: options.missingSource ? null : sourceObservedAt, pseudonymKeyVersionId: options.missingKey ? null : '44444444-4444-4444-8444-444444444444' }
    } },
    identityRiskFinding: { findMany: async () => [{ id: 'finding-1', ruleId: 'HV-ID-MBX-001.v1', state: 'OPEN', severity: 'HIGH', confidence: 'HIGH', coverage: 'FULL', subjectType: 'MAILBOX', subjectId: subject, observedAt: sourceObservedAt }], findFirst: async (args: any) => {
      calls.where = args.where
      calls.order.push('finding-read')
      return options.missing ? null : { subjectId: subject, observedAt: sourceObservedAt, matchedResult: { subjectId: options.mismatch ? 'foreign' : subject, evaluationRunId: runId } }
    } },
  }
  const prisma = { ...models, $transaction: async (callback: (transaction: typeof models) => unknown) => callback(models) } as unknown as PrismaService
  const resolver = { resolve: async (...args: unknown[]) => {
    calls.resolved++
    calls.args = args
    if (options.resolverThrows) throw new Error('secret provider payload')
    return { status: 'AVAILABLE', mailboxId: 'mailbox-123', label: options.label ?? 'Pilot mailbox', observedAt: sourceObservedAt.toISOString() }
  } } as unknown as MailboxInvestigationResolver
  return { service: new IdentityRiskService(prisma, resolver), calls }
}

async function shadow(action: () => Promise<void>) {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const keys = ['HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER', 'HAWKVIEW_IDENTITY_RISK_ENVIRONMENT', 'HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE'] as const
  const old = keys.map((key) => process.env[key])
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'wrapped-pilot-v1'
  process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
  process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = JSON.stringify({ organizationId: org, customerTenantId: tenant, expiresAt: new Date(Date.now() + 86400000).toISOString() })
  try { await action() } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index] })
  }
}

test('owner/admin explicit investigation scopes finding and exact run/key, returns only closed inventory projection', async () => shadow(async () => {
  for (const role of ['MSP_OWNER', 'MSP_ADMIN']) {
    const { service, calls } = fixture({ role })
    const result = await service.mailboxInvestigation(identity, tenant, 'finding-1')
    assert.equal(result.status, 'AVAILABLE')
    assert.deepEqual(Object.keys(result).sort(), ['mailbox', 'status', 'version'])
    assert.equal(result.mailbox?.inventoryPath, `/tenants/${tenant}/exchange`)
    assert.equal(calls.where.organizationId, org)
    assert.equal(calls.where.customerTenantId, tenant)
    assert.equal(calls.where.matchedResult.organizationId, org)
    assert.equal(calls.where.matchedResult.customerTenantId, tenant)
    assert.equal(calls.where.matchedResult.evaluationRunId, runId)
    assert.ok(calls.where.expiresAt.gt instanceof Date)
    assert.ok(calls.where.matchedResult.expiresAt.gt instanceof Date)
    assert.deepEqual(calls.args?.[0], { organizationId: org, customerTenantId: tenant })
    assert.equal((calls.args?.[1] as any).subjectId, subject)
    assert.equal((calls.args?.[1] as any).pseudonymKeyVersionId, '44444444-4444-4444-8444-444444444444')
    assert.doesNotMatch(JSON.stringify(result), /pseudonym|hvr1_|provider|secret/)
  }
}))

test('viewer, technician, disabled identity and foreign tenant cannot resolve or read evidence', async () => shadow(async () => {
  for (const options of [{ role: 'MSP_VIEWER' }, { role: 'MSP_TECHNICIAN' }, { disabled: true }, { foreign: true }]) {
    const { service, calls } = fixture(options)
    await assert.rejects(() => service.mailboxInvestigation(identity, tenant, 'finding-1'), ForbiddenException)
    assert.equal(calls.resolved, 0)
    assert.equal(calls.reads, 0)
  }
}))

test('missing/expired finding, stale/partial/missing source/key and mismatched matched subject fail closed before resolution', async () => shadow(async () => {
  for (const options of [{ missing: true }, { expiredRun: true }, { stale: true }, { missingKey: true }, { missingSource: true }, { partial: true }, { mismatch: true }]) {
    const { service, calls } = fixture(options)
    assert.deepEqual(await service.mailboxInvestigation(identity, tenant, 'finding-1'), { version: 1, status: 'UNAVAILABLE', mailbox: null })
    assert.equal(calls.resolved, 0)
  }
}))

test('OFF and operational hard disable do not resolve mailbox identities', async () => shadow(async () => {
  for (const hardDisableAfter of [1, 2]) {
    const { service, calls } = fixture({ hardDisableAfter })
    assert.equal((await service.mailboxInvestigation(identity, tenant, 'finding-1')).status, 'UNAVAILABLE')
    assert.equal(calls.resolved, 0)
  }
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'off'
  const { service, calls } = fixture()
  assert.equal((await service.mailboxInvestigation(identity, tenant, 'finding-1')).status, 'UNAVAILABLE')
  assert.equal(calls.reads, 0)
  assert.equal(calls.resolved, 0)
}))

test('late hard disable, resolver failure and unsafe labels never expose identity/error payloads', async () => shadow(async () => {
  for (const options of [{ hardDisableAfter: 3 }, { revokeAfterResolve: true }, { resolverThrows: true }, { label: '<script>secret</script>' }, { label: 'hidden\u202ename' }]) {
    const { service } = fixture(options)
    const result = await service.mailboxInvestigation(identity, tenant, 'finding-1')
    assert.deepEqual(result, { version: 1, status: 'UNAVAILABLE', mailbox: null })
    assert.doesNotMatch(JSON.stringify(result), /secret|script|hidden/)
  }
}))

test('ordinary mailbox finding lists keep only opaque subject and restricted label without resolving identity', async () => shadow(async () => {
  for (const role of ['MSP_OWNER', 'MSP_VIEWER']) {
    const { service, calls } = fixture({ role })
    const result = await service.findings(identity, tenant)
    assert.equal(result.findings[0]?.affectedIdentity.id, subject)
    assert.equal(result.findings[0]?.affectedIdentity.label, 'Affected mailbox (restricted details)')
    assert.equal(calls.resolved, 0)
    assert.doesNotMatch(JSON.stringify(result), /Pilot mailbox|mailbox-123|owner@example/)
  }
}))

test('investigation capability is scoped owner/admin only with no identity payload', async () => shadow(async () => {
  for (const role of ['MSP_OWNER', 'MSP_ADMIN', 'MSP_TECHNICIAN', 'MSP_VIEWER']) {
    const { service, calls } = fixture({ role })
    assert.deepEqual(await service.investigationAccess(identity, tenant), { version: 1, allowed: role === 'MSP_OWNER' || role === 'MSP_ADMIN' })
    assert.equal(calls.resolved, 0)
  }
}))

test('missing, expired and non-opted-in pilot config prevents every HawkView risk read and mailbox resolution', async () => shadow(async () => {
  const future = new Date(Date.now() + 86400000).toISOString()
  const configs = [undefined, '{invalid',
    JSON.stringify({ organizationId: org, customerTenantId: tenant, expiresAt: new Date(Date.now() - 1).toISOString() }),
    JSON.stringify({ organizationId: '99999999-9999-4999-8999-999999999999', customerTenantId: tenant, expiresAt: future }),
    JSON.stringify({ organizationId: org, customerTenantId: '99999999-9999-4999-8999-999999999999', expiresAt: future }),
  ]
  for (const config of configs) {
    if (config === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
    else process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = config
    const { service, calls } = fixture()
    assert.equal((await service.summary(identity, tenant)).status, 'UNAVAILABLE')
    assert.deepEqual((await service.findings(identity, tenant)).findings, [])
    assert.equal((await service.findingDetail(identity, tenant, 'finding-1')).finding, null)
    assert.deepEqual(await service.investigationAccess(identity, tenant), { version: 1, allowed: false })
    assert.equal((await service.mailboxInvestigation(identity, tenant, 'finding-1')).mailbox, null)
    assert.equal(calls.reads, 0)
    assert.equal(calls.resolved, 0)
    assert.equal(calls.controls, 0)
    assert.deepEqual(calls.order, [])
  }
}))

test('run and mailbox finding timestamp reads verify transaction-local UTC before evidence IO', async () => shadow(async () => {
  const { service, calls } = fixture()
  assert.equal((await service.mailboxInvestigation(identity, tenant, 'finding-1')).status, 'AVAILABLE')
  assert.deepEqual(calls.order, ['utc-set', 'utc-confirm', 'run-read', 'utc-set', 'utc-confirm', 'finding-read'])
  const failed = fixture({ utcFailure: true })
  await assert.rejects(() => failed.service.findings(identity, tenant), /IDENTITY_RISK_UTC_UNAVAILABLE/)
  assert.equal(failed.calls.reads, 0)
  assert.equal(failed.calls.resolved, 0)
}))
