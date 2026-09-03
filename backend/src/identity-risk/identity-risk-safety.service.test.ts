import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_OPERATIONAL_EVENT_RETENTION_MS,
  IdentityRiskSafetyService,
} from './identity-risk-safety.service.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'

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
