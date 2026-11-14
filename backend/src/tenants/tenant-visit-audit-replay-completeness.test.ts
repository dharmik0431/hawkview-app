import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'

const tenant = { id: 'audit-completeness-tenant', organizationId: 'audit-completeness-organization' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 1n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function bareService(prisma: unknown = {}) {
  const service = new TenantSyncService(prisma as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  ;(service as any).runSnapshotSync = async (
    _tenant: unknown, _resource: unknown, collect: () => Promise<void>,
  ) => collect()
  return service as any
}

for (const resource of ['EXCHANGE_MAILBOX_USAGE', 'SHAREPOINT_USAGE'] as const) {
  const method = resource === 'EXCHANGE_MAILBOX_USAGE' ? 'syncExchangeMailboxUsage' : 'syncSharePointUsage'
  for (const transport of ['direct', 'download', 'redirect'] as const) {
    for (const qualification of ['206', 'warning'] as const) {
      if (transport === 'redirect' && qualification === '206') continue
      test(`${resource} rejects ${qualification} on ${transport} before audit publication`, async (t) => {
        const service = bareService()
        const saves: unknown[][] = []
        let downloads = 0
        service.saveSnapshot = async (...args: unknown[]) => { saves.push(args) }
        const qualified = () => new Response('User Principal Name\nuser@example.test', {
          status: qualification === '206' ? 206 : 200,
          headers: qualification === 'warning' ? { Warning: '199 partial response' } : {},
        })
        service.fetchGraphPage = async () => transport === 'direct' ? qualified() : new Response(null, {
          status: 302, headers: {
            location: 'https://reports.example.test/fixture.csv',
            ...(transport === 'redirect' ? { Warning: '199 partial response' } : {}),
          },
        })
        t.mock.method(globalThis, 'fetch', async () => { downloads++; return qualified() })

        await assert.rejects(() => service[method](tenant, 'synthetic-token', owner, 2n), /invalid response/)
        assert.equal(saves.length, 0)
        assert.equal(downloads, transport === 'download' ? 1 : 0)
      })
    }
  }

  test(`${resource} complete direct response carries exact revision to publication`, async () => {
    const service = bareService()
    const saves: unknown[][] = []
    service.saveSnapshot = async (...args: unknown[]) => { saves.push(args) }
    service.fetchGraphPage = async (url: string) => new Response(
      resource === 'EXCHANGE_MAILBOX_USAGE' ? 'User Principal Name\nuser@example.test'
        : url.includes('OneDrive') ? 'Report Refresh Date,Owner Principal Name,Report Period\r\n'
          : 'Report Refresh Date,Site Id,Report Period\r\n',
      { status: 200 },
    )
    await service[method](tenant, 'synthetic-token', owner, 2n)
    assert.equal(saves.length, 1)
    assert.equal(saves[0][1], resource)
    assert.equal(saves[0][8], 2n)
  })
}

function groupsFixture(options: {
  definitions?: unknown[]; owners?: unknown[]; members?: unknown[]; superseded?: boolean
} = {}) {
  const events: string[] = []
  let enriched: any
  let acknowledgedAt: Date | undefined
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '1' }]
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    $executeRawUnsafe: async () => { events.push('snapshot-lock'); return 0 },
    directoryGroup: {
      upsert: async () => { events.push('definition') },
      deleteMany: async () => { events.push('definition-prune') },
    },
    directoryGroupMembership: {
      deleteMany: async () => { events.push('membership-delete') },
      createMany: async () => { events.push('membership-create') },
    },
    tenantEntraSnapshot: {
      updateMany: async (args: unknown) => {
        events.push('owners'); enriched = args
        return { count: options.superseded ? 0 : 1 }
      },
    },
    tenantAuditReconciliationWork: {
      updateMany: async (args: any) => {
        events.push('ack'); acknowledgedAt = args.data.lastCompletedAt
        return { count: 1 }
      },
    },
  }
  const service = bareService({
    $transaction: async (work: (tx: typeof transaction) => Promise<void>) => work(transaction),
    directoryUser: { findMany: async () => [{ id: 'user-row', microsoftUserId: 'user-1' }] },
    directoryGroup: { findMany: async () => [{ id: 'group-row', microsoftGroupId: 'group-1' }] },
  })
  service.collectEntraCollection = async (_token: string, _resource: string, url: string) =>
    url.includes('/owners?') ? options.owners ?? [{ id: 'owner-1', displayName: 'Owner' }]
      : url.includes('/members?') ? options.members ?? [{ id: 'user-1' }, { id: 'non-user-principal' }]
        : options.definitions ?? [{ id: 'group-1', displayName: 'Group' }]
  service.saveSnapshot = async (
    _tenant: unknown, _resource: unknown, _result: unknown, persist: (tx: typeof transaction) => Promise<void>,
  ) => { events.push('definition-snapshot'); await persist(transaction) }
  return { service, events, enriched: () => enriched, acknowledgedAt: () => acknowledgedAt }
}

for (const definition of [{}, { id: '', displayName: 'Bad' }, { id: 'group-1' }]) {
  test(`GROUPS invalid definition ${JSON.stringify(definition)} cannot be dropped before publication`, async () => {
    const fixture = groupsFixture({ definitions: [definition] })
    await assert.rejects(() => fixture.service.syncGroups(tenant, 'synthetic-token', owner, 2n), /invalid or repeated identity/)
    assert.deepEqual(fixture.events, [])
  })
}

for (const relation of ['owners', 'members'] as const) {
  for (const rows of [[{}], [{ id: '' }], [{ id: 'repeated' }, { id: 'repeated' }]]) {
    test(`GROUPS invalid ${relation} ${JSON.stringify(rows)} leave audit work pending`, async () => {
      const fixture = groupsFixture({ [relation]: rows })
      await assert.rejects(() => fixture.service.syncGroups(tenant, 'synthetic-token', owner, 2n), /relationship refresh was incomplete/)
      assert.equal(fixture.events.includes('owners'), false)
      assert.equal(fixture.events.includes('ack'), false)
      if (relation === 'members') assert.equal(fixture.events.includes('membership-delete'), false)
    })
  }
}

test('GROUPS publishes complete owners with memberships before acknowledging the same observed time', async () => {
  const fixture = groupsFixture()
  await fixture.service.syncGroups(tenant, 'synthetic-token', owner, 2n)
  const enriched = fixture.enriched()
  assert.deepEqual(enriched.where, {
    organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: 'GROUPS',
    payload: { equals: [{ id: 'group-1', displayName: 'Group' }] },
  })
  assert.deepEqual(enriched.data.payload[0].owners, [{ id: 'owner-1', displayName: 'Owner' }])
  assert.equal(enriched.data.observedAt, fixture.acknowledgedAt())
  assert.ok(fixture.events.indexOf('snapshot-lock') < fixture.events.indexOf('owners'))
  assert.ok(fixture.events.indexOf('owners') < fixture.events.indexOf('membership-create'))
  assert.ok(fixture.events.indexOf('membership-create') < fixture.events.indexOf('ack'))
})

test('GROUPS superseding definition refuses stale owner enrichment and audit acknowledgement', async () => {
  const fixture = groupsFixture({ superseded: true })
  await assert.rejects(() => fixture.service.syncGroups(tenant, 'synthetic-token', owner, 2n), /GROUP_RELATIONSHIP_DEFINITION_CHANGED/)
  assert.equal(fixture.events.includes('membership-delete'), false)
  assert.equal(fixture.events.includes('ack'), false)
})

for (const [resource, expansion] of [
  ['SERVICE_PRINCIPALS', 'appRoleAssignedTo'], ['APPLICATIONS', 'owners'], ['DEVICES', 'registeredOwners'],
] as const) {
  test(`${resource} expanded continuation is rejected before closed projection loses it`, async () => {
    const service = bareService()
    let saved = false
    service.saveSnapshot = async () => { saved = true }
    service.fetchGraphPage = async () => Response.json({ value: [{
      id: 'object-1', [expansion]: [{ id: 'principal-1' }],
      [`${expansion}@odata.nextLink`]: 'https://graph.microsoft.com/v1.0/continuation',
    }] })
    await assert.rejects(
      () => service.syncEntraCollection(tenant, 'synthetic-token', resource,
        'https://graph.microsoft.com/v1.0/objects', owner, 2n),
      /incomplete expanded relationship/,
    )
    assert.equal(saved, false)
  })
}

test('expanded continuation nested inside a retained relationship is incomplete', async () => {
  const service = bareService()
  service.saveSnapshot = async () => { assert.fail('Partial relationship must not publish') }
  service.fetchGraphPage = async () => Response.json({ value: [{
    id: 'app-1', owners: [{ id: 'owner-1', nested: { '@odata.nextLink': '' } }],
  }] })
  await assert.rejects(() => service.syncEntraCollection(tenant, 'synthetic-token', 'APPLICATIONS',
    'https://graph.microsoft.com/v1.0/applications', owner, 2n), /incomplete expanded relationship/)
})

for (const link of ['', '  ', null, 7]) {
  test(`owned generic collection refuses malformed continuation ${JSON.stringify(link)}`, async () => {
    const service = bareService()
    service.saveSnapshot = async () => { assert.fail('Malformed continuation must not publish') }
    service.fetchGraphPage = async () => Response.json({ value: [{ id: 'app-1' }], '@odata.nextLink': link })
    await assert.rejects(() => service.syncEntraCollection(tenant, 'synthetic-token', 'APPLICATIONS',
      'https://graph.microsoft.com/v1.0/applications', owner, 2n), /invalid APPLICATIONS link/)
  })
}

test('complete multi-page expanded relationship forwards exact audit revision', async () => {
  const service = bareService()
  const saves: unknown[][] = []
  let pages = 0
  service.saveSnapshot = async (...args: unknown[]) => { saves.push(args) }
  service.fetchGraphPage = async () => Response.json(++pages === 1
    ? { value: [{ id: 'app-1', owners: [{ id: 'owner-1' }] }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?cursor=2' }
    : { value: [{ id: 'app-2', owners: [] }] })
  await service.syncEntraCollection(tenant, 'synthetic-token', 'APPLICATIONS',
    'https://graph.microsoft.com/v1.0/applications', owner, 2n)
  assert.equal(pages, 2)
  assert.deepEqual(saves[0][2], { completeness: 'authoritative_complete', rows: [
    { id: 'app-1', owners: [{ id: 'owner-1' }] }, { id: 'app-2', owners: [] },
  ] })
  assert.equal(saves[0][8], 2n)
})

test('ownerless generic collector retains its existing expanded-pagination behavior', async () => {
  const service = bareService()
  let saved = false
  service.saveSnapshot = async () => { saved = true }
  service.fetchGraphPage = async () => Response.json({ value: [{ id: 'app-1', owners: [], 'owners@odata.nextLink': 'legacy' }] })
  await service.syncEntraCollection(tenant, 'synthetic-token', 'APPLICATIONS',
    'https://graph.microsoft.com/v1.0/applications')
  assert.equal(saved, true)
})

for (const source of ['root', 'search'] as const) {
  for (const site of [{}, { id: '' }, { id: ' ' }, { id: 7 }]) {
    test(`SHAREPOINT_SITES ${source} invalid ID ${JSON.stringify(site)} cannot disappear before receipt`, async () => {
      const service = bareService()
      service.saveSnapshot = async () => { assert.fail('Malformed identity must not publish') }
      service.fetchGraphPage = async (url: string) => url.includes('/sites/root?')
        ? source === 'root' ? Response.json(site) : new Response(null, { status: 404 })
        : Response.json({ value: [site] })
      await assert.rejects(() => service.syncSharePointSites(tenant, 'synthetic-token', undefined, owner, 2n), /invalid identity/)
    })
  }
}

test('SHAREPOINT_SITES accepts valid root/search duplicates and carries exact receipt', async () => {
  const service = bareService()
  const saves: any[][] = []
  service.saveSnapshot = async (...args: unknown[]) => { saves.push(args) }
  service.fetchGraphPage = async (url: string) => url.includes('/sites/root?')
    ? Response.json({ id: 'site-1', displayName: 'Root' })
    : Response.json({ value: [{ id: 'site-1', displayName: 'Root' }, { id: 'site-2', displayName: 'Second' }] })
  await service.syncSharePointSites(tenant, 'synthetic-token', undefined, owner, 2n)
  assert.deepEqual(saves[0][2].rows.map((row: { id: string }) => row.id), ['site-1', 'site-2'])
  assert.equal(saves[0][8], 2n)
})

test('SHAREPOINT_SITES refuses blank continuation before publication', async () => {
  const service = bareService()
  service.saveSnapshot = async () => { assert.fail('Malformed continuation must not publish') }
  service.fetchGraphPage = async (url: string) => url.includes('/sites/root?')
    ? new Response(null, { status: 404 }) : Response.json({ value: [], '@odata.nextLink': ' ' })
  await assert.rejects(() => service.syncSharePointSites(tenant, 'synthetic-token', undefined, owner, 2n), /invalid SharePoint sites link/)
})

for (const condition of ['missing', 'failed', 'undated', 'stale', 'newer-attempt', 'healthy'] as const) {
  test(`MAILBOX_SETTINGS ${condition} directory controls audit receipt independently of collection`, async () => {
    const successfulAt = new Date(Date.now() - 1000)
    const state = condition === 'missing' ? null : {
      status: condition === 'failed' ? 'FAILED' : 'SUCCEEDED',
      lastSuccessfulAt: condition === 'undated' ? null : condition === 'stale'
        ? new Date(Date.now() - 37 * 60 * 60 * 1000) : successfulAt,
      lastAttemptAt: condition === 'newer-attempt' ? new Date(successfulAt.getTime() + 1) : successfulAt,
    }
    const service = bareService({ directoryUser: { findMany: async () => [] } })
    const saves: unknown[][] = []
    let prerequisiteReads = 0
    service.saveSnapshot = async (...args: unknown[]) => { saves.push(args) }
    service.fetchGraphPage = async () => { assert.fail('Empty directory has no provider workload') }
    service.withSnapshotUtc = async (resource: string, read: (tx: unknown) => Promise<unknown>, candidateOwner: unknown) => {
      assert.equal(resource, 'USERS')
      assert.equal(candidateOwner, owner)
      return read({ syncState: { findFirst: async (query: any) => {
        prerequisiteReads++
        assert.deepEqual(query.where, { organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: 'USERS' })
        return state
      } } })
    }
    await service.syncExchangeMailboxSettings(tenant, 'synthetic-token', owner, undefined, 2n)
    assert.equal(prerequisiteReads, 1)
    assert.equal(saves.length, 1)
    assert.equal(saves[0][8], condition === 'healthy' ? 2n : undefined)
  })
}

test('MAILBOX_SETTINGS without audit revision preserves existing collection path', async () => {
  const service = bareService({ directoryUser: { findMany: async () => [] } })
  let saved = false
  service.saveSnapshot = async () => { saved = true }
  service.withSnapshotUtc = async () => { assert.fail('No new prerequisite read without receipt') }
  await service.syncExchangeMailboxSettings(tenant, 'synthetic-token', owner)
  assert.equal(saved, true)
})
