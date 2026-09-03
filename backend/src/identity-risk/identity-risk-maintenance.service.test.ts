import assert from 'node:assert/strict'
import test from 'node:test'
import type { Request } from 'express'
import type { PrismaService } from '../prisma/prisma.service.js'
import type { SchedulerTokenVerifier } from '../tenants/scheduler-token-verifier.service.js'
import { ScheduledSyncController } from '../tenants/scheduled-sync.controller.js'
import type { TenantSyncService } from '../tenants/tenant-sync.service.js'
import {
  IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE,
  IdentityRiskMaintenanceService,
} from './identity-risk-maintenance.service.js'
import type { IdentityRiskPlatformClock } from './identity-risk-evaluator.service.js'

type EventRow = {
  id: string
  eventKey: string
  expiresAt: Date
  scopeType: 'GLOBAL' | 'TENANT'
}

function maintenanceStore(initial: EventRow[]) {
  const rows = [...initial]
  const calls = {
    take: 0,
    deletes: 0,
    upserts: 0,
    auditCreates: [] as Array<Record<string, unknown>>,
  }
  const transaction = {
    identityRiskOperationalEvent: {
      findMany: async (input: {
        where: { expiresAt: { lte: Date } }
        take: number
      }) => {
        calls.take = input.take
        return rows
          .filter((row) => row.expiresAt.getTime() <= input.where.expiresAt.lte.getTime())
          .sort((left, right) =>
            left.expiresAt.getTime() - right.expiresAt.getTime() ||
            left.id.localeCompare(right.id),
          )
          .slice(0, input.take)
          .map(({ id }) => ({ id }))
      },
      deleteMany: async (input: { where: { id: { in: string[] } } }) => {
        const ids = new Set(input.where.id.in)
        let count = 0
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (ids.has(rows[index]!.id)) {
            rows.splice(index, 1)
            count += 1
          }
        }
        calls.deletes += 1
        return { count }
      },
      upsert: async (input: {
        where: { eventKey: string }
        create: Record<string, unknown>
      }) => {
        calls.upserts += 1
        calls.auditCreates.push(input.create)
        const existing = rows.find((row) => row.eventKey === input.where.eventKey)
        if (existing) return existing
        const created: EventRow = {
          id: `maintenance-${calls.upserts}`,
          eventKey: input.create.eventKey as string,
          expiresAt: input.create.expiresAt as Date,
          scopeType: input.create.scopeType as 'GLOBAL',
        }
        rows.push(created)
        return created
      },
    },
  }
  const prisma = {
    $transaction: async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
  } as unknown as PrismaService
  return { prisma, rows, calls }
}

test('scheduled maintenance is bounded, idempotent, and preserves unexpired rows', async () => {
  const now = new Date('2026-09-02T12:00:00.000Z')
  const expired = Array.from(
    { length: IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE + 2 },
    (_, index): EventRow => ({
      id: `expired-${String(index).padStart(4, '0')}`,
      eventKey: `expired-key-${index}`,
      expiresAt: new Date(now.getTime() - 1),
      scopeType: index % 2 === 0 ? 'GLOBAL' : 'TENANT',
    }),
  )
  const fresh: EventRow = {
    id: 'fresh-other-scope',
    eventKey: 'fresh-key',
    expiresAt: new Date(now.getTime() + 1),
    scopeType: 'TENANT',
  }
  const store = maintenanceStore([...expired, fresh])
  const service = new IdentityRiskMaintenanceService(
    store.prisma,
    { now: () => now } as IdentityRiskPlatformClock,
  )

  const first = await service.runAuthorizedScheduledMaintenance()
  assert.deepEqual(first, {
    status: 'COMPLETED',
    deletedCount: IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE,
    hasMore: true,
  })
  assert.equal(
    store.calls.take,
    IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE + 1,
  )
  assert.equal(store.rows.filter((row) => row.id.startsWith('expired-')).length, 2)
  assert.equal(store.rows.some((row) => row.id === fresh.id), true)

  const second = await service.runAuthorizedScheduledMaintenance()
  assert.deepEqual(second, {
    status: 'COMPLETED',
    deletedCount: 2,
    hasMore: false,
  })
  assert.equal(store.rows.some((row) => row.id === fresh.id), true)
  assert.equal(
    store.rows.filter((row) => row.eventKey.length === 64).length,
    1,
  )
  assert.equal(store.calls.deletes, 2)
  assert.equal(store.calls.auditCreates[0]?.eventType, 'RETENTION_MAINTENANCE')
  assert.equal(store.calls.auditCreates[0]?.scopeType, 'GLOBAL')
  assert.equal(store.calls.auditCreates[0]?.reasonCode, 'RETENTION_POLICY_APPLIED')
  assert.equal('organizationId' in store.calls.auditCreates[0]!, false)
  assert.equal('customerTenantId' in store.calls.auditCreates[0]!, false)
})

test('scheduler authorization succeeds before retention maintenance and tenant sync', async () => {
  const order: string[] = []
  const verifier = {
    verify: async () => { order.push('verify') },
  } as unknown as SchedulerTokenVerifier
  const sync = {
    syncDueTenants: async () => {
      order.push('sync')
      return { status: 'ok' }
    },
  } as unknown as TenantSyncService
  const maintenance = {
    runAuthorizedScheduledMaintenance: async () => {
      order.push('maintenance')
      return { status: 'COMPLETED', deletedCount: 0, hasMore: false }
    },
  } as unknown as IdentityRiskMaintenanceService
  const controller = new ScheduledSyncController(verifier, sync, maintenance)

  assert.deepEqual(
    await controller.syncDueTenants({
      headers: { authorization: 'Bearer scheduler-token' },
    } as Request),
    { status: 'ok' },
  )
  assert.deepEqual(order, ['verify', 'maintenance', 'sync'])
})

test('failed scheduler authorization prevents retention and tenant work', async () => {
  let maintenanceCalls = 0
  let syncCalls = 0
  const verifier = {
    verify: async () => { throw new Error('unauthorized') },
  } as unknown as SchedulerTokenVerifier
  const sync = {
    syncDueTenants: async () => { syncCalls += 1 },
  } as unknown as TenantSyncService
  const maintenance = {
    runAuthorizedScheduledMaintenance: async () => { maintenanceCalls += 1 },
  } as unknown as IdentityRiskMaintenanceService
  const controller = new ScheduledSyncController(verifier, sync, maintenance)
  const messages: string[] = []
  ;(controller as any).logger = { log: (message: string) => messages.push(message) }

  await assert.rejects(
    () => controller.syncDueTenants({ headers: {} } as Request),
    /unauthorized/,
  )
  assert.equal(maintenanceCalls, 0)
  assert.equal(syncCalls, 0)
  assert.deepEqual(messages, [])
})
