import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'
import { NativeRiskSummaryController } from './native-risk-summary.controller.js'

const request = { auth: { subject: 'synthetic-auth' }, query: { tenantId: 'foreign', organizationId: 'foreign' } } as never

test('new route is no-store and has no caller-controlled scope parameters', async () => {
  assert.equal(Reflect.getMetadata('path', NativeRiskSummaryController), 'api/risky-users')
  assert.equal(Reflect.getMetadata('path', NativeRiskSummaryController.prototype.summary), 'summary')
  assert.deepEqual(Reflect.getMetadata('__headers__', NativeRiskSummaryController.prototype.summary), [{ name: 'Cache-Control', value: 'no-store' }])
  const transaction = { marker: 'same snapshot' }
  let authorized = 0
  const controller = new NativeRiskSummaryController({ authorizeRiskyUsersFleetRead: async (identity: unknown, client: unknown) => {
    assert.deepEqual(identity, { subject: 'synthetic-auth' })
    assert.equal(client, transaction)
    authorized++
    return { totalTenants: 0, tenants: [] }
  } } as never, { $transaction: async (callback: (client: unknown) => unknown, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: 'RepeatableRead', timeout: 10_000 })
    return callback(transaction)
  } } as never)
  const result = await controller.summary(request)
  assert.equal(authorized, 1)
  assert.equal(result.fleet.distinctUserCount, null)
  assert.doesNotMatch(JSON.stringify(result), /foreign/)
})

test('authorization denial prevents run reads', async () => {
  const controller = new NativeRiskSummaryController({ authorizeRiskyUsersFleetRead: async () => { throw new ForbiddenException('Tenant access denied') } } as never,
    { $transaction: async (callback: (client: unknown) => unknown) => callback({ $queryRawUnsafe: () => assert.fail('no evidence read permitted') }) } as never)
  await assert.rejects(controller.summary(request), ForbiddenException)
})

test('transaction and database failures are static safe 503, never raw errors', async () => {
  const controller = new NativeRiskSummaryController({} as never, { $transaction: async () => { throw new Error('postgres://secret@private/db') } } as never)
  await assert.rejects(controller.summary(request), (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException)
    assert.equal(error.getStatus(), 503)
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /postgres|secret|private/)
    return true
  })
})
