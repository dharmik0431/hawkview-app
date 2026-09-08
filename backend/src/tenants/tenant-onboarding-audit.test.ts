import assert from 'node:assert/strict'
import test from 'node:test'
import { BadGatewayException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { WorkspaceService } from '../workspace/workspace.service.js'
import { createWorkspaceAuditOperation } from '../workspace/workspace-audit.js'
import { TenantsService } from './tenants.service.js'

const organizationId = '22222222-2222-4222-8222-222222222222'
const foreignOrganizationId = '99999999-9999-4999-8999-999999999999'
const tenantId = '11111111-1111-4111-8111-111111111111'
const userId = '33333333-3333-4333-8333-333333333333'
const identity = { subject: 'synthetic-auth-user', email: 'private-owner@example.invalid' }
const deferredAt = new Date('2026-09-01T12:00:00.000Z')
const ready = { exchangeReadOnlySkippedAt: deferredAt, reportVisibilityDeferredAt: deferredAt }
const actions = [
  { method: 'skipExchangeReadOnlyForIdentity', action: 'TENANT_EXCHANGE_SETUP_DEFERRED', field: 'exchangeReadOnlySkippedAt' },
  { method: 'deferReportVisibilityForIdentity', action: 'TENANT_REPORT_VISIBILITY_DEFERRED', field: 'reportVisibilityDeferredAt' },
  { method: 'verifyReportVisibilityForIdentity', action: 'TENANT_REPORT_VISIBILITY_CHECKED', field: 'reportSettingsLastCheckedAt' },
  { method: 'completeTenantOnboardingForIdentity', action: 'TENANT_ONBOARDING_COMPLETED', field: 'onboardingCompletedAt' },
] as const

// This synthetic adapter stages both tables until commit and serializes writers.
// It exercises service transaction placement and conditional writes, not a live DB.
type Row = Record<string, any>
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'AND') return expected.every((condition: Row) => matches(row, condition))
    if (key === 'OR') return expected.some((condition: Row) => matches(row, condition))
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('not' in expected) return row[key] !== expected.not
      if ('in' in expected) return expected.in.includes(row[key])
      if ('gt' in expected) return row[key] > expected.gt
      if ('lte' in expected) return row[key] <= expected.lte
    }
    return row[key] === expected
  })
}

function harness(options: Row = {}) {
  let state = {
    connection: {
      customerTenantId: tenantId, organizationId,
      connectionMode: 'HAWKVIEW_MANAGED', status: 'CONNECTED',
      clientId: 'private-client-id', credentialReference: 'private-secret-reference',
      consentedPermissions: ['Organization.Read.All', 'ReportSettings.Read.All'],
      exchangeReadOnlyEnabledAt: null, exchangeReadOnlySkippedAt: null,
      reportSettingsLastCheckedAt: null, reportIdentifiersVisible: null,
      reportVisibilityDeferredAt: null, onboardingCompletedAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      ...options.connection,
    } as Row,
    audit: [] as Row[],
  }
  const counters = { provider: 0, stateWrites: 0, auditWrites: 0, transactions: 0, auditReads: 0 }
  const controls = { failState: false, failAudit: false, failSuccessAudit: false, failCommit: false, beforeTransaction: undefined as (() => void) | undefined }
  const organization = {
    id: organizationId, status: options.organizationStatus ?? 'ACTIVE',
    name: 'private-organization-name', businessDomain: 'private-org.example.invalid',
    timeZone: 'UTC', onboardingCompletedAt: deferredAt,
  }
  let queue = Promise.resolve()
  function auditClient(current: () => typeof state) {
    return {
      create: async ({ data }: Row) => {
        counters.auditWrites += 1
        if (controls.failAudit || (controls.failSuccessAudit && data.outcome === 'SUCCEEDED')) {
          throw new Error('private database credentials and provider payload')
        }
        const row = { ...data, createdAt: new Date() }
        current().audit.push(row)
        return row
      },
      deleteMany: async ({ where }: Row) => {
        current().audit = current().audit.filter((row) => !matches(row, where))
        return { count: 0 }
      },
      findMany: async ({ where }: Row) => {
        counters.auditReads += 1
        assert.equal(where.organizationId, organizationId)
        assert.ok(where.expiresAt.gt instanceof Date)
        return current().audit.filter((row) => matches(row, where))
      },
    }
  }
  const prisma = {
    user: {
      findUnique: async ({ where, select }: Row) => {
        assert.equal(where.authProviderUserId, identity.subject)
        if (options.missingUser) return null
        const filter = select.memberships?.where
        const role = options.role ?? 'MSP_OWNER'
        const membershipStatus = options.membershipStatus ?? 'ACTIVE'
        const allowed = !filter || (
          (typeof filter.role === 'string' ? filter.role === role : filter.role.in.includes(role)) &&
          membershipStatus === filter.status && organization.status === filter.organization.status
        )
        return {
          id: userId, email: identity.email, disabledAt: options.disabled ? deferredAt : null,
          memberships: allowed ? [{ organizationId, organization }] : [],
        }
      },
    },
    customerTenant: {
      findFirst: async ({ where }: Row) => {
        assert.ok(Array.isArray(where.organizationId.in))
        if (where.id !== tenantId || !where.organizationId.in.includes(organizationId) || options.foreignTenant) return null
        return {
          id: tenantId, organizationId, displayName: 'private-customer-name',
          primaryDomain: 'private-tenant.example.invalid',
          microsoftTenantId: '44444444-4444-4444-8444-444444444444',
          connection: options.missingConnection ? null : { ...state.connection },
        }
      },
    },
    workspaceAdminAuditLog: auditClient(() => state),
    async $transaction(work: (client: Row) => Promise<unknown>) {
      counters.transactions += 1
      const previous = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => { release = resolve })
      await previous
      controls.beforeTransaction?.()
      const draft = structuredClone(state)
      const write = (where: Row, data: Row) => {
        assert.equal(where.customerTenantId, tenantId)
        assert.equal(where.organizationId, organizationId)
        if (controls.failState) throw new Error('private database credentials and provider payload')
        if (!matches(draft.connection, where)) return { count: 0 }
        counters.stateWrites += 1
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) draft.connection[key] = value
        }
        return { count: 1 }
      }
      try {
        const result = await work({
          tenantConnection: {
            updateMany: async ({ where, data }: Row) => write(where, data),
            update: async ({ where, data }: Row) => {
              write(where.customerTenantId_organizationId, data)
              return draft.connection
            },
          },
          workspaceAdminAuditLog: auditClient(() => draft),
        })
        if (controls.failCommit) throw new Error('private commit failure')
        state = draft
        return result
      } finally { release() }
    },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    readTenantReportPrivacySetting: async () => {
      counters.provider += 1
      if (options.providerError) throw options.providerError
      return options.result ?? { status: 'READY', identifiersVisible: true, retryable: false }
    },
  } as never, {} as never)
  return { service, prisma, counters, controls, state: () => state }
}

for (const action of actions) {
  test(`${action.action}: commits scoped state and private version-2 evidence together`, async () => {
    const h = harness({ connection: action.field === 'onboardingCompletedAt' ? ready : {} })
    await h.service[action.method](identity, tenantId)
    assert.ok(h.state().connection[action.field] instanceof Date)
    assert.equal(h.state().audit.length, 1)
    const event = h.state().audit[0]
    assert.equal(event.action, action.action)
    assert.equal(event.organizationId, organizationId)
    assert.equal(event.actorUserId, userId)
    assert.equal(event.targetType, 'CUSTOMER_TENANT')
    assert.equal(event.targetOpaqueId, tenantId)
    assert.equal(event.actorEmail, null)
    assert.equal(event.targetEmail, null)
    assert.equal(event.targetUserId, null)
    assert.equal(event.eventVersion, 2)
    assert.equal(event.outcome, 'SUCCEEDED')
    assert.match(event.requestId, /^[0-9a-f-]{36}$/)
    assert.match(event.operationId, /^[0-9a-f-]{36}$/)
    assert.notEqual(event.requestId, event.operationId)
    assert.ok(Math.abs(event.expiresAt.getTime() - event.createdAt.getTime() - 365 * 86_400_000) < 1000)
    assert.doesNotMatch(JSON.stringify(event), /private-|44444444|Bearer|authorization|https:/i)
  })

  for (const failure of ['failState', 'failSuccessAudit', 'failCommit', 'failAudit'] as const) {
    test(`${action.action}: ${failure} cannot leave changed state or successful evidence`, async () => {
      const h = harness({ connection: action.field === 'onboardingCompletedAt' ? ready : {} })
      const before = structuredClone(h.state().connection)
      h.controls[failure] = true
      await assert.rejects(h.service[action.method](identity, tenantId), (error: unknown) => {
        assert.ok(error instanceof BadGatewayException)
        assert.doesNotMatch(JSON.stringify(error.getResponse()), /private|credentials|payload/)
        return true
      })
      assert.deepEqual(h.state().connection, before)
      assert.equal(h.state().audit.some((event) => event.outcome === 'SUCCEEDED'), false)
      if (failure !== 'failAudit') {
        assert.equal(h.state().audit.length, 1)
        assert.equal(h.state().audit[0].stage, 'LOCAL_PERSISTENCE')
        assert.equal(h.state().audit[0].errorCode, 'WORKSPACE_OPERATION_FAILED')
      } else {
        assert.equal(h.state().audit.length, 0)
      }
      assert.doesNotMatch(JSON.stringify(h.state().audit), /private|credentials|payload/)
    })
  }

  for (const denied of [
    { role: 'MSP_VIEWER' }, { membershipStatus: 'INVITED' },
    { organizationStatus: 'SUSPENDED' }, { disabled: true },
    { missingUser: true }, { foreignTenant: true }, { missingConnection: true },
  ]) {
    test(`${action.action}: denied ${JSON.stringify(denied)} has no tenant/audit/provider effects`, async () => {
      const h = harness({ ...denied, connection: ready })
      await assert.rejects(h.service[action.method](identity, tenantId))
      assert.deepEqual(h.counters, { provider: 0, stateWrites: 0, auditWrites: 0, transactions: 0, auditReads: 0 })
      assert.equal(h.state().audit.length, 0)
    })
  }
}

for (const action of actions.filter((action) => action.field !== 'reportSettingsLastCheckedAt')) {
  test(`${action.action}: concurrent calls and later retries emit only one successful transition`, async () => {
    const h = harness({ connection: action.field === 'onboardingCompletedAt' ? ready : {} })
    await Promise.all([h.service[action.method](identity, tenantId), h.service[action.method](identity, tenantId)])
    const timestamp = h.state().connection[action.field].toISOString()
    await h.service[action.method](identity, tenantId)
    assert.equal(h.state().connection[action.field].toISOString(), timestamp)
    assert.equal(h.state().audit.length, 1)
    assert.equal(h.counters.stateWrites, 1)
  })
}

for (const status of [
  'READY', 'IDENTIFIERS_CONCEALED', 'CONNECTION_INCOMPLETE', 'TOKEN_UNAVAILABLE',
  'MISSING_PERMISSION', 'MICROSOFT_DENIED', 'MICROSOFT_UNAVAILABLE', 'INVALID_RESPONSE', 'NETWORK_ERROR',
]) {
  test(`report verification ${status} records the observation without claiming onboarding completion`, async () => {
    const identifiersVisible = status === 'READY' ? true : status === 'IDENTIFIERS_CONCEALED' ? false : null
    const h = harness({ connection: ready, result: {
      status, identifiersVisible, retryable: false,
      accessToken: 'private-token', payload: 'private-provider-payload', url: 'https://private.example.invalid',
    } })
    const result = await h.service.verifyReportVisibilityForIdentity(identity, tenantId)
    assert.equal(result.verification.status, status)
    assert.equal(h.state().connection.reportIdentifiersVisible, identifiersVisible)
    assert.equal(h.state().connection.reportVisibilityDeferredAt?.toISOString() ?? null, identifiersVisible ? null : deferredAt.toISOString())
    assert.equal(h.state().connection.onboardingCompletedAt, null)
    const event = h.state().audit[0]
    assert.equal(event.action, 'TENANT_REPORT_VISIBILITY_CHECKED')
    assert.equal(event.outcome, identifiersVisible === null ? 'FAILED' : 'SUCCEEDED')
    assert.equal(event.errorCode, identifiersVisible === null ? `REPORT_VISIBILITY_${status}` : null)
    assert.deepEqual(event.metadata, { status })
    assert.doesNotMatch(JSON.stringify(event), /private-|payload|https:/)
  })
}

test('repeated unchanged READY checks are distinct read observations, not successful setup transitions', async () => {
  const h = harness()
  await h.service.verifyReportVisibilityForIdentity(identity, tenantId)
  await h.service.verifyReportVisibilityForIdentity(identity, tenantId)
  assert.equal(h.counters.provider, 2)
  assert.deepEqual(h.state().audit.map((event) => event.action), ['TENANT_REPORT_VISIBILITY_CHECKED', 'TENANT_REPORT_VISIBILITY_CHECKED'])
  assert.notEqual(h.state().audit[0].operationId, h.state().audit[1].operationId)
  assert.equal(h.state().connection.onboardingCompletedAt, null)
})

test('unknown provider statuses never enter audit metadata or error codes', async () => {
  const h = harness({ result: { status: 'private-provider.example.invalid', identifiersVisible: null, retryable: true } })
  await h.service.verifyReportVisibilityForIdentity(identity, tenantId)
  assert.deepEqual(h.state().audit[0].metadata, { status: 'INVALID_RESPONSE' })
  assert.equal(h.state().audit[0].errorCode, 'REPORT_VISIBILITY_INVALID_RESPONSE')
})

test('thrown provider failures leave local truth unchanged and save only sanitized failure evidence', async () => {
  const h = harness({ connection: ready, providerError: new Error('Bearer private-token https://private.example.invalid private-owner@example.invalid') })
  const before = structuredClone(h.state().connection)
  await assert.rejects(h.service.verifyReportVisibilityForIdentity(identity, tenantId), /Report visibility could not be verified/)
  assert.deepEqual(h.state().connection, before)
  assert.equal(h.state().audit.length, 1)
  assert.equal(h.state().audit[0].outcome, 'FAILED')
  assert.equal(h.state().audit[0].errorCode, 'WORKSPACE_OPERATION_FAILED')
  assert.equal(h.state().audit[0].metadata.status, 'CHECK_FAILED')
  assert.doesNotMatch(JSON.stringify(h.state().audit), /private-|Bearer|https:/)
})

test('a provider exception plus an unavailable audit store returns a sanitized failure, never success', async () => {
  const h = harness({ providerError: new Error('private-provider') })
  h.controls.failAudit = true
  await assert.rejects(h.service.verifyReportVisibilityForIdentity(identity, tenantId), /Onboarding audit evidence could not be saved/)
  assert.equal(h.counters.stateWrites, 0)
  assert.equal(h.state().audit.length, 0)
})

test('unresolved optional steps still prevent completion without inventing an event', async () => {
  const h = harness()
  await assert.rejects(h.service.completeTenantOnboardingForIdentity(identity, tenantId), /Resolve or explicitly defer/)
  assert.equal(h.counters.transactions, 0)
  assert.equal(h.state().audit.length, 0)
})

test('completion rechecks existing readiness in the conditional write if connection truth changes', async () => {
  const h = harness({ connection: ready })
  h.controls.beforeTransaction = () => { h.state().connection.status = 'ERROR' }
  await assert.rejects(h.service.completeTenantOnboardingForIdentity(identity, tenantId), /Resolve or explicitly defer/)
  assert.equal(h.state().connection.onboardingCompletedAt, null)
  assert.equal(h.state().audit.length, 0)
})

test('an owner sees tenant audit events through existing Audit History, excluding another MSP', async () => {
  const h = harness()
  await h.service.skipExchangeReadOnlyForIdentity(identity, tenantId)
  h.state().audit.push({ ...h.state().audit[0], organizationId: foreignOrganizationId })
  const workspace = new WorkspaceService(h.prisma)
  const result = await workspace.listAuditLogs(identity, organizationId)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].targetOpaqueId, tenantId)
  await assert.rejects(workspace.listAuditLogs(identity, foreignOrganizationId))
  assert.equal(h.counters.auditReads, 1)
})

for (const role of ['MSP_ADMIN', 'MSP_TECHNICIAN', 'MSP_VIEWER']) {
  test(`${role} cannot read owner Audit History`, async () => {
    const h = harness({ role })
    await assert.rejects(new WorkspaceService(h.prisma).listAuditLogs(identity, organizationId))
    assert.equal(h.counters.auditReads, 0)
  })
}

test('existing workspace private audit writer retains projection and supplied transaction client', async () => {
  let rootWrites = 0
  const transactionRows: Row[] = []
  const service = new WorkspaceService({ workspaceAdminAuditLog: {
    create: async () => { rootWrites += 1 },
  } } as unknown as PrismaService)
  await (service as any).audit({ organizationId, userId }, {
    ...createWorkspaceAuditOperation(), action: 'WORKSPACE_MEMBER_UPDATED', outcome: 'SUCCEEDED',
    stage: 'COMPLETED', targetType: 'WORKSPACE_MEMBER', targetUserId: userId,
    targetOpaqueId: 'x'.repeat(140), metadata: { role: 'MSP_ADMIN', accessToken: 'private-token' },
  }, { workspaceAdminAuditLog: { create: async ({ data }: Row) => { transactionRows.push(data) } } })
  assert.equal(rootWrites, 0)
  assert.equal(transactionRows.length, 1)
  assert.equal(transactionRows[0].targetOpaqueId.length, 128)
  assert.equal(transactionRows[0].targetUserId, userId)
  assert.equal(transactionRows[0].actorEmail, null)
  assert.equal(transactionRows[0].targetEmail, null)
  assert.deepEqual(transactionRows[0].metadata, { role: 'MSP_ADMIN' })
  assert.equal(transactionRows[0].eventVersion, 2)
})

test('existing workspace invitation stays fail-closed before provider invocation when intent evidence fails', async () => {
  let providerCalls = 0
  const service = new WorkspaceService({ workspaceAdminAuditLog: {
    create: async () => { throw new Error('synthetic audit outage') },
  } } as unknown as PrismaService)
  ;(service as any).ownerContext = async () => ({ organizationId, userId })
  ;(service as any).supabaseAdminRequest = async () => { providerCalls += 1 }
  await assert.rejects(service.inviteMember(identity, {
    organizationId, email: 'invitee@example.invalid', role: 'MSP_TECHNICIAN',
  }), /synthetic audit outage/)
  assert.equal(providerCalls, 0)
})

test('existing invitation completion evidence still uses the membership transaction client', async () => {
  const rootEvents: Row[] = []
  const transactionEvents: Row[] = []
  let memberships = 0
  const prisma = {
    user: { findUnique: async () => null, create: async () => ({ id: userId }) },
    workspaceAdminAuditLog: { create: async ({ data }: Row) => { rootEvents.push(data) } },
    $transaction: async (work: (transaction: Row) => Promise<unknown>) => work({
      membership: { upsert: async () => { memberships += 1; return {} } },
      workspaceAdminAuditLog: { create: async ({ data }: Row) => { transactionEvents.push(data) } },
    }),
  } as unknown as PrismaService
  const service = new WorkspaceService(prisma)
  ;(service as any).ownerContext = async () => ({ organizationId, userId })
  ;(service as any).authEmailRedirectUrl = () => 'https://example.invalid'
  ;(service as any).supabaseAdminRequest = async () => ({ id: 'synthetic-auth-id' })
  await service.inviteMember(identity, { organizationId, email: 'invitee@example.invalid', role: 'MSP_TECHNICIAN' })
  assert.equal(memberships, 1)
  assert.deepEqual(rootEvents.map((event) => event.stage), ['REQUEST_ACCEPTED', 'AUTH_PROVIDER'])
  assert.equal(transactionEvents.length, 1)
  assert.equal(transactionEvents[0].action, 'WORKSPACE_MEMBER_INVITE_REQUEST_RESOLVED')
  assert.equal(transactionEvents[0].stage, 'COMPLETED')
  assert.equal(transactionEvents[0].operationId, rootEvents[0].operationId)
  assert.equal(transactionEvents[0].requestId, rootEvents[0].requestId)
})
