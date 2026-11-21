import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CollectionInitializingError, CollectionPartialError, TenantSyncService,
} from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('resource wrapper propagates lost visit ownership without a false terminal state or incident', async () => {
  for (const outcome of [
    { name: 'success', collect: async () => {} },
    { name: 'initializing', collect: async () => { throw new CollectionInitializingError('INITIALIZING', 'Provisioning') } },
    { name: 'partial', collect: async () => { throw new CollectionPartialError('PARTIAL', 'Incomplete') } },
    { name: 'failure', collect: async () => { throw new Error('Provider failure') } },
  ]) {
    const writes: string[] = []
    const incidents: string[] = []
    const service = new TenantSyncService({} as any, {} as any, {} as any,
      {
        resolveIncident: async () => { incidents.push('resolve') },
        publishIncident: async () => { incidents.push('publish') },
      } as any, {} as any, {} as any)
    ;(service as any).withSnapshotUtc = async (
      resource: string, _write: unknown, suppliedOwner: unknown,
    ) => {
      assert.equal(resource, 'DOMAINS')
      assert.equal(suppliedOwner, owner)
      writes.push(writes.length ? 'terminal-attempt' : 'running')
      if (writes.length === 2) throw new TenantVisitLeaseLostError()
      return { lastSuccessfulAt: null }
    }
    await assert.rejects(
      () => (service as any).runSnapshotSync(tenant, 'DOMAINS', outcome.collect, owner),
      (error: unknown) => error instanceof TenantVisitLeaseLostError,
      outcome.name,
    )
    assert.deepEqual(writes, ['running', 'terminal-attempt'], outcome.name)
    assert.deepEqual(incidents, [], `${outcome.name} must not publish or resolve an incident`)
  }
})

test('resource wrapper rejects a mismatched visit owner before state or provider work', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  ;(service as any).withSnapshotUtc = async () => assert.fail('state write attempted')
  await assert.rejects(
    () => (service as any).runSnapshotSync(tenant, 'DOMAINS',
      async () => assert.fail('provider work attempted'), { ...owner, customerTenantId: 'other' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})

test('resource wrapper forwards optional owner to every incident path', async () => {
  for (const scenario of [
    { name: 'success', collect: async () => {}, kind: 'resolve' },
    { name: 'initializing', collect: async () => { throw new CollectionInitializingError('INITIALIZING', 'Provisioning') }, kind: 'resolve' },
    { name: 'partial', collect: async () => { throw new CollectionPartialError('PARTIAL', 'Incomplete') }, kind: 'resolve' },
    { name: 'failure', collect: async () => { throw new Error('Provider failure') }, kind: 'publish' },
  ]) {
    for (const suppliedOwner of [owner, undefined]) {
      const incidents: Array<{ kind: string; owner: unknown; recovery: unknown }> = []
      const service = new TenantSyncService({} as any, {} as any, {} as any,
        {
          resolveIncident: async (_organization: string, _key: string, recovery: unknown, actualOwner: unknown) => {
            incidents.push({ kind: 'resolve', owner: actualOwner, recovery })
          },
          publishIncident: async (_input: unknown, actualOwner: unknown) => {
            incidents.push({ kind: 'publish', owner: actualOwner, recovery: null })
          },
        } as any, {} as any, {} as any)
      let writes = 0
      ;(service as any).withSnapshotUtc = async (_resource: string, _write: unknown, actualOwner: unknown) => {
        assert.equal(actualOwner, suppliedOwner)
        writes += 1
        return writes === 1 ? { lastSuccessfulAt: null } : { consecutiveFailures: 6 }
      }
      if (scenario.name === 'failure') {
        await assert.rejects(() => (service as any).runSnapshotSync(tenant, 'DOMAINS', scenario.collect, suppliedOwner))
      } else {
        await (service as any).runSnapshotSync(tenant, 'DOMAINS', scenario.collect, suppliedOwner)
      }
      assert.equal(writes, 2, scenario.name)
      assert.deepEqual(incidents.map((incident) => incident.kind), [scenario.kind], scenario.name)
      assert.equal(incidents[0]?.owner, suppliedOwner, scenario.name)
      if (scenario.kind === 'resolve') {
        assert.equal(incidents[0]?.recovery === undefined, scenario.name !== 'success', scenario.name)
      }
    }
  }
})

test('fulfilled resource wrapper result is not an audit completion receipt', async () => {
  // Audit replay must not acknowledge a requested revision merely because a
  // selected collector's promise fulfilled. Initializing and partial results
  // deliberately return normally, and partial advances lastSuccessfulAt.
  const outcomes = [
    { name: 'complete', collect: async () => {}, expectedStatus: 'SUCCEEDED' },
    { name: 'initializing', collect: async () => { throw new CollectionInitializingError('INITIALIZING', 'Provisioning') }, expectedStatus: 'RUNNING' },
    { name: 'partial', collect: async () => { throw new CollectionPartialError('PARTIAL', 'Incomplete') }, expectedStatus: 'RUNNING' },
  ]
  for (const outcome of outcomes) {
    const terminalWrites: Array<{ status: string; lastSuccessfulAt?: Date }> = []
    const transaction = {
      syncState: {
        upsert: async () => ({ lastSuccessfulAt: null }),
        update: async ({ data }: { data: { status: string; lastSuccessfulAt?: Date } }) => {
          terminalWrites.push(data)
          return { consecutiveFailures: 0 }
        },
      },
    }
    const service = new TenantSyncService({} as any, {} as any, {} as any,
      { resolveIncident: async () => {} } as any, {} as any, {} as any)
    ;(service as any).withSnapshotUtc = async (
      resource: string, write: (client: typeof transaction) => Promise<unknown>, suppliedOwner: unknown,
    ) => {
      assert.equal(resource, 'DOMAINS')
      assert.equal(suppliedOwner, owner)
      return write(transaction)
    }
    const result = await (service as any).runSnapshotSync(tenant, 'DOMAINS', outcome.collect, owner)
    assert.equal(result, undefined, outcome.name)
    assert.equal(terminalWrites.length, 1, outcome.name)
    assert.equal(terminalWrites[0].status, outcome.expectedStatus, outcome.name)
    assert.equal(terminalWrites[0].lastSuccessfulAt instanceof Date,
      outcome.name !== 'initializing', outcome.name)
  }
})

test('resource wrapper propagates notification lease loss without converting it to provider failure', async () => {
  const stateWrites: string[] = []
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    { resolveIncident: async () => { throw new TenantVisitLeaseLostError() } } as any,
    {} as any, {} as any)
  ;(service as any).withSnapshotUtc = async (_resource: string, _write: unknown, suppliedOwner: unknown) => {
    assert.equal(suppliedOwner, owner)
    stateWrites.push('write')
    return { lastSuccessfulAt: null }
  }
  await assert.rejects(
    () => (service as any).runSnapshotSync(tenant, 'DOMAINS', async () => {}, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(stateWrites, ['write', 'write'], 'notice loss cannot create a FAILED state')
})
