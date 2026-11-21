import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import {
  IDENTITY_RISK_OPERATIONAL_EVENT_RETENTION_MS,
  IdentityRiskSafetyService,
} from './identity-risk-safety.service.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const visitOwner = {
  organizationId,
  customerTenantId: tenantId,
  token: '55555555-5555-4555-8555-555555555555',
  generation: 3n,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
}

test('global hard-stop diagnostic refuses a lost tenant visit before consuming the event key', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return []
      throw new Error('Unexpected visit-owner query')
    },
    get identityRiskOperationalEvent() { throw new Error('Stale hard-stop event escaped visit check') },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaService
  await assert.rejects(() => new IdentityRiskSafetyService(prisma).recordHardStopBlocked({
    organizationId,
    customerTenantId: tenantId,
    episodeId: '33333333-3333-4333-8333-333333333333',
    scopeType: 'GLOBAL',
    visitOwner,
  }), TenantVisitLeaseLostError)
  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('FOR NO KEY UPDATE'))
  assert.ok(calls[2].includes('FOR SHARE'))
})

test('hard-stop diagnostic rejects a foreign visit owner before opening its event transaction', async () => {
  let opened = false
  const prisma = {
    $transaction: async () => { opened = true },
  } as unknown as PrismaService
  await assert.rejects(() => new IdentityRiskSafetyService(prisma).recordHardStopBlocked({
    organizationId,
    customerTenantId: tenantId,
    episodeId: '33333333-3333-4333-8333-333333333333',
    scopeType: 'TENANT',
    visitOwner: { ...visitOwner, organizationId: 'foreign' },
  }), TenantVisitLeaseLostError)
  assert.equal(opened, false)
})

test('hard-stop diagnostic writes after a valid visit check in the same transaction', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '3' }]
      throw new Error('Unexpected visit-owner query')
    },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: { eventType: string; scopeType: string } }) => {
        calls.push('event-write')
        assert.equal(data.eventType, 'EVALUATION_BLOCKED')
        assert.equal(data.scopeType, 'GLOBAL')
      },
    },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaService
  await new IdentityRiskSafetyService(prisma).recordHardStopBlocked({
    organizationId,
    customerTenantId: tenantId,
    episodeId: '33333333-3333-4333-8333-333333333333',
    scopeType: 'GLOBAL',
    visitOwner,
  })
  assert.equal(calls.length, 4)
  assert.equal(calls[3], 'event-write')
})

test('hard-stop diagnostic retains ownerless scheduled event writes', async () => {
  let wrote = false
  const prisma = {
    get $transaction() { throw new Error('Ownerless hard-stop event opened visit transaction') },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        assert.equal(data.eventType, 'EVALUATION_BLOCKED')
        wrote = true
      },
    },
  } as unknown as PrismaService
  await new IdentityRiskSafetyService(prisma).recordHardStopBlocked({
    organizationId,
    customerTenantId: tenantId,
    episodeId: '33333333-3333-4333-8333-333333333333',
    scopeType: 'TENANT',
  })
  assert.equal(wrote, true)
})

test('detector rejection refuses a lost visit inside its event transaction', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return []
      throw new Error('Unexpected visit-owner query')
    },
    get identityRiskOperationalEvent() { throw new Error('Stale event write escaped visit check') },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaService
  await assert.rejects(() => new IdentityRiskSafetyService(prisma).recordDetectorRejection({
    organizationId,
    customerTenantId: tenantId,
    runKey: 'run',
    ruleId: 'HV-ID-CHG-001.v1',
    reasonCode: 'DETECTOR_FAILED',
    now: new Date(),
    visitOwner,
  }), TenantVisitLeaseLostError)
  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('FOR NO KEY UPDATE'))
  assert.ok(calls[2].includes('FOR SHARE'))
})

test('detector rejection rejects a foreign owner before opening its event transaction', async () => {
  let opened = false
  const prisma = {
    $transaction: async () => { opened = true },
  } as unknown as PrismaService
  await assert.rejects(() => new IdentityRiskSafetyService(prisma).recordDetectorRejection({
    organizationId,
    customerTenantId: tenantId,
    runKey: 'run',
    ruleId: 'HV-ID-CHG-001.v1',
    reasonCode: 'DETECTOR_FAILED',
    now: new Date(),
    visitOwner: { ...visitOwner, customerTenantId: 'foreign' },
  }), TenantVisitLeaseLostError)
  assert.equal(opened, false)
})

test('detector rejection writes after a valid owner check in the same transaction', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '3' }]
      throw new Error('Unexpected visit-owner query')
    },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        calls.push('event-write')
        assert.equal(data.eventType, 'DETECTOR_OUTPUT_REJECTED')
      },
    },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaService
  await new IdentityRiskSafetyService(prisma).recordDetectorRejection({
    organizationId,
    customerTenantId: tenantId,
    runKey: 'run',
    ruleId: 'HV-ID-CHG-001.v1',
    reasonCode: 'DETECTOR_FAILED',
    now: new Date(),
    visitOwner,
  })
  assert.equal(calls.length, 4)
  assert.equal(calls[3], 'event-write')
})

test('detector rejection retains ownerless scheduled event writes', async () => {
  let wrote = false
  const prisma = {
    get $transaction() { throw new Error('Ownerless event opened visit transaction') },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        assert.equal(data.eventType, 'DETECTOR_OUTPUT_REJECTED')
        wrote = true
      },
    },
  } as unknown as PrismaService
  await new IdentityRiskSafetyService(prisma).recordDetectorRejection({
    organizationId,
    customerTenantId: tenantId,
    runKey: 'run',
    ruleId: 'HV-ID-CHG-001.v1',
    reasonCode: 'DETECTOR_FAILED',
    now: new Date(),
  })
  assert.equal(wrote, true)
})

test('effective safety state reads only active global and exact tenant controls', async () => {
  let where: unknown
  const prisma = {
    identityRiskOperationalControl: {
      findMany: async (args: { where: unknown }) => {
        where = args.where
        return [
          {
            controlType: 'EVALUATION_HARD_DISABLED',
            episodeId: '33333333-3333-4333-8333-333333333333',
            scopeType: 'GLOBAL',
          },
          {
            controlType: 'ALERT_DELIVERY_DISABLED',
            episodeId: '44444444-4444-4444-8444-444444444444',
            scopeType: 'TENANT',
          },
        ]
      },
    },
  } as unknown as PrismaService
  const state = await new IdentityRiskSafetyService(prisma).stateForTenant(
    organizationId,
    tenantId,
  )
  assert.deepEqual(state, {
    evaluationHardDisabled: true,
    alertDeliveryDisabled: true,
    hardDisableEpisodeId: '33333333-3333-4333-8333-333333333333',
    hardDisableScopeType: 'GLOBAL',
  })
  const serialized = JSON.stringify(where)
  assert.match(serialized, new RegExp(organizationId, 'i'))
  assert.match(serialized, new RegExp(tenantId, 'i'))
  assert.match(serialized, /GLOBAL/)
})

test('activation is durable, audited, and idempotent while already active', async () => {
  let current: Record<string, unknown> | null = null
  const events: Array<Record<string, unknown>> = []
  const transaction = {
    $executeRawUnsafe: async () => 1,
    identityRiskOperationalControl: {
      findUnique: async () => current,
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        current = { id: 'control-1', ...create }
        return current
      },
    },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data)
        return data
      },
    },
  }
  const prisma = {
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
  } as unknown as PrismaService
  const service = new IdentityRiskSafetyService(prisma)
  const input = {
    controlType: 'EVALUATION_HARD_DISABLED' as const,
    scope: { type: 'TENANT' as const, organizationId, customerTenantId: tenantId },
    reasonCode: 'ISOLATION_FAILURE',
    actorServiceId: 'security-operator',
    now: new Date('2026-09-02T12:00:00.000Z'),
  }
  const first = await service.activate(input)
  const second = await service.activate(input)
  assert.equal(first?.id, 'control-1')
  assert.equal(second?.id, 'control-1')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.eventType, 'CONTROL_ACTIVATED')
  assert.equal(
    (events[0]?.expiresAt as Date).toISOString(),
    new Date(
      input.now.getTime() + IDENTITY_RISK_OPERATIONAL_EVENT_RETENTION_MS,
    ).toISOString(),
  )
  assert.doesNotMatch(JSON.stringify(events), new RegExp(tenantId, 'i'))
})

test('held stale visit cannot commit a tenant safety control or activation event after takeover', async () => {
  const writes: string[] = []
  const transaction = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [] // Exact generation predicate excludes the successor.
      throw new Error('Unexpected visit-owner query')
    },
    identityRiskOperationalControl: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        writes.push('control')
        return { id: 'control-after-takeover', ...create }
      },
    },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        assert.equal(data.eventType, 'CONTROL_ACTIVATED')
        writes.push('event')
      },
    },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaService
  const request = {
    controlType: 'EVALUATION_HARD_DISABLED' as const,
    scope: { type: 'TENANT' as const, organizationId, customerTenantId: tenantId },
    reasonCode: 'SOURCE_INTEGRITY_CONFLICT',
    actorServiceId: 'identity-risk-evaluator',
    visitOwner: { ...visitOwner, generation: 1n },
  }
  let failure: unknown = null
  try { await new IdentityRiskSafetyService(prisma).activate(request) }
  catch (error) { failure = error }
  assert.deepEqual(writes, [], 'superseded visitor committed a control/event without same-transaction owner proof')
  assert.ok(failure instanceof TenantVisitLeaseLostError)
})

for (const scope of [{ type: 'GLOBAL' as const }, {
  type: 'TENANT' as const, organizationId, customerTenantId: tenantId,
}]) {
  test(`${scope.type} activation holds the exact visit in the control transaction`, async () => {
    const calls: string[] = []
    let current: Record<string, unknown> | null = null
    const transaction = {
      $executeRawUnsafe: async (sql: string) => { assert.match(sql, /pg_advisory_xact_lock/); calls.push('control-lock'); return 1 },
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        if (sql.includes('FROM organizations')) { calls.push('organization'); return [{ id: organizationId }] }
        if (sql.includes('FROM customer_tenants')) { calls.push('tenant'); return [{ id: tenantId }] }
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          calls.push('visit')
          assert.deepEqual(values, [tenantId, organizationId, visitOwner.token, '3'])
          assert.match(sql, /FOR SHARE/)
          return [{ generation: '3' }]
        }
        throw new Error('Unexpected owner query')
      },
      identityRiskOperationalControl: {
        findUnique: async () => { calls.push('read-control'); return current },
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          calls.push('control-write'); current = { id: 'control', ...create }; return current
        },
      },
      identityRiskOperationalEvent: { create: async () => { calls.push('event-write') } },
    }
    const prisma = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) } as unknown as PrismaService
    const service = new IdentityRiskSafetyService(prisma)
    const input = { controlType: 'EVALUATION_HARD_DISABLED' as const, scope, visitOwner,
      reasonCode: 'SOURCE_INTEGRITY_CONFLICT', actorServiceId: 'identity-risk-evaluator' }
    await service.activate(input)
    assert.deepEqual(calls, ['control-lock', 'organization', 'tenant', 'visit', 'read-control', 'control-write', 'event-write'])
    calls.length = 0
    await service.activate(input)
    assert.deepEqual(calls, ['control-lock', 'organization', 'tenant', 'visit', 'read-control'], 'idempotent return also checks owner')
  })
}

test('tenant activation rejects a foreign owner before its transaction', async () => {
  const prisma = { $transaction: async () => { throw new Error('foreign scope opened transaction') } } as unknown as PrismaService
  await assert.rejects(() => new IdentityRiskSafetyService(prisma).activate({
    controlType: 'EVALUATION_HARD_DISABLED',
    scope: { type: 'TENANT', organizationId, customerTenantId: tenantId },
    reasonCode: 'SOURCE_INTEGRITY_CONFLICT', actorServiceId: 'identity-risk-evaluator',
    visitOwner: { ...visitOwner, customerTenantId: 'foreign' },
  }), TenantVisitLeaseLostError)
})

test('hard-stop recovery cannot resume without every required canary', async () => {
  const prisma = {} as PrismaService
  const service = new IdentityRiskSafetyService(prisma)
  const base = {
    controlType: 'EVALUATION_HARD_DISABLED' as const,
    scope: { type: 'TENANT' as const, organizationId, customerTenantId: tenantId },
    actorServiceId: 'security-operator',
    reasonCode: 'MANUAL_SECURITY_CONTROL',
  }
  await assert.rejects(
    () => service.resume({
      ...base,
      recovery: {
        evidenceBoundaryVerified: true,
        unsafeQueueRemediated: true,
        replayCanaryPassed: false,
      },
    }),
    BadRequestException,
  )
})

test('alert-delivery control is distinct and does not require hard-stop recovery', async () => {
  const events: Array<Record<string, unknown>> = []
  const transaction = {
    $executeRawUnsafe: async () => 1,
    identityRiskOperationalControl: {
      findUnique: async () => ({
        id: 'control-1',
        state: 'ACTIVE',
        episodeId: '33333333-3333-4333-8333-333333333333',
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    identityRiskOperationalEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data)
        return data
      },
    },
  }
  const prisma = {
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
  } as unknown as PrismaService
  const result = await new IdentityRiskSafetyService(prisma).resume({
    controlType: 'ALERT_DELIVERY_DISABLED',
    scope: { type: 'TENANT', organizationId, customerTenantId: tenantId },
    actorServiceId: 'security-operator',
    reasonCode: 'MANUAL_SECURITY_CONTROL',
  })
  assert.equal((result as { state?: unknown }).state, 'RESUMED')
  assert.equal(events[0]?.controlType, 'ALERT_DELIVERY_DISABLED')
})

test('operational event pruning is expiry-bounded and exact-scope isolated', async () => {
  const whereClauses: Array<Record<string, unknown>> = []
  const prisma = {
    identityRiskOperationalEvent: {
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        whereClauses.push(where)
        return { count: 1 }
      },
    },
  } as unknown as PrismaService
  const service = new IdentityRiskSafetyService(prisma)
  const now = new Date('2026-12-01T00:00:00.000Z')
  await service.pruneExpiredForScope({
    scope: { type: 'TENANT', organizationId, customerTenantId: tenantId },
    now,
  })
  await service.pruneExpiredForScope({
    scope: {
      type: 'TENANT',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      customerTenantId: tenantId,
    },
    now,
  })
  assert.equal(whereClauses[0]?.scopeType, 'TENANT')
  assert.deepEqual(whereClauses[0]?.expiresAt, { lte: now })
  assert.notEqual(whereClauses[0]?.scopeOpaqueId, whereClauses[1]?.scopeOpaqueId)
  assert.doesNotMatch(JSON.stringify(whereClauses), new RegExp(tenantId, 'i'))
})
