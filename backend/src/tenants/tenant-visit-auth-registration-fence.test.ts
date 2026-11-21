import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MicrosoftGraphCollectionError,
  NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
  projectMfaTruth,
  TenantSyncService,
} from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-registration', organizationId: 'organization-registration' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

for (const source of ['premium-report', 'non-premium-fallback'] as const) {
  test(`${source} authentication registration results cannot write after visit takeover`, async () => {
    const events: string[] = []
    let checks = 0
    const transaction = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          events.push('owner-check')
          return ++checks === 1 ? [{ generation: '4' }] : []
        }
        assert.fail(`Unexpected SQL: ${sql}`)
      },
      syncState: {
        upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
        update: async () => { events.push('terminal') },
      },
      $executeRawUnsafe: async () => { events.push('snapshot-lock') },
      tenantEntraSnapshot: {
        findUnique: async () => { events.push('snapshot-read'); return null },
        upsert: async () => { events.push('snapshot-upsert') },
      },
      changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
    }
    const prisma = {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    }
    const service = new TenantSyncService(prisma as any, {} as any, {} as any,
      { resolveIncident: async () => { events.push('resolve') },
        publishIncident: async () => { events.push('publish') } } as any,
      {} as any, {} as any)
    ;(service as any).collectEntraCollection = async () => {
      events.push('premium-report')
      if (source === 'non-premium-fallback') {
        throw new MicrosoftGraphCollectionError('Premium report unavailable', 403,
          NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE)
      }
      return [{ id: 'user-1', isMfaRegistered: true }]
    }
    ;(service as any).collectPerUserAuthenticationMethods = async () => {
      events.push('fallback')
      return [{ id: 'user-1', isMfaRegistered: true }]
    }
    ;(service as any).enrichAuthenticationRegistrationsWithPerUserMfaState = async (
      _accessToken: string, rows: unknown[],
    ) => { events.push('mfa-enrichment'); return rows }
    ;(service as any).enrichAuthenticationRegistrationsWithConditionalAccessContext = async (
      _accessToken: string, rows: unknown[],
    ) => { events.push('conditional-access-enrichment'); return rows }

    await assert.rejects(
      () => (service as any).syncAuthenticationRegistrations(tenant, 'synthetic-token', owner),
      TenantVisitLeaseLostError,
    )
    assert.deepEqual(events, [
      'owner-check', 'running', 'premium-report',
      ...(source === 'non-premium-fallback' ? ['fallback'] : []),
      'mfa-enrichment', 'conditional-access-enrichment', 'owner-check',
    ])
  })
}

test('audit reconciliation forwards the visit owner into authentication registrations', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncAuthenticationRegistrations = async (...args: unknown[]) => { calls.push(args) }

  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['AUTH_REGISTRATIONS'], owner,
  )
  assert.deepEqual(calls, [[tenant, 'synthetic-token', owner]])
})

type EnrichmentWitness = {
  source: 'requirements' | 'membership'
  response: 'complete' | 'permission-limited' | 'item-partial' | 'continuation'
    | 'batch-partial' | 'batch-warning' | 'item-warning' | 'malformed-headers' | 'nested-continuation'
}

type ReceiptProbeOptions = Parameters<typeof registrationCompletenessFixture>[3]

// Keep the real transport classifier, paged collector, wrapper and snapshot
// writer. Only network, database and optional enrichment boundaries are fake.
// This probes the inactive audit-work receipt seam without adding production
// replay callers or changing production failure policy.
async function registrationCompletenessFixture(
  partialPage = 0, partialStatus = 200, warning?: string,
  options: {
    fallback?: 'users' | 'batch' | 'item'; continuation?: boolean; ownerless?: boolean
    reportRows?: (page: number) => unknown[]; userRows?: (page: number) => unknown[]; methodRows?: unknown[]
    enrichment?: EnrichmentWitness
    auditRequestedRevision?: bigint
    pendingRevision?: bigint
    completedRevision?: bigint
    writeFailure?: 'evidence' | 'snapshot' | 'receipt'
    lostOwnerAtSnapshot?: boolean
  } = {},
) {
  const events: string[] = []
  const snapshots: unknown[] = []
  const observations: Date[] = []
  const writes: Array<{ kind: string; transaction: number }> = []
  const committedTransactions: number[] = []
  const receipts: Array<{
    where: Record<string, unknown>; data: { completedRevision: bigint; lastCompletedAt: Date }
  }> = []
  let completedRevision = options.completedRevision ?? 0n
  let sequence = 0
  let active = 0
  let ownerChecks = 0
  const recordWrite = (kind: 'evidence' | 'snapshot' | 'receipt') => {
    events.push(kind)
    writes.push({ kind, transaction: active })
    if (options.writeFailure === kind) throw new Error(`synthetic-${kind}-failure`)
  }
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        ownerChecks++
        return options.lostOwnerAtSnapshot && ownerChecks > 1 ? [] : [{ generation: '4' }]
      }
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    $executeRawUnsafe: async () => {},
    syncState: {
      upsert: async () => { events.push('RUNNING'); return { lastSuccessfulAt: null } },
      update: async ({ data }: { data: { status: string } }) => {
        events.push(data.status)
        return { consecutiveFailures: 1 }
      },
    },
    tenantEntraSnapshot: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: { payload: unknown; observedAt: Date } }) => {
        recordWrite('snapshot')
        snapshots.push(create.payload)
        observations.push(create.observedAt)
      },
    },
    changeEvidenceEvent: { createMany: async () => { recordWrite('evidence') } },
    tenantAuditReconciliationWork: {
      updateMany: async (request: typeof receipts[number]) => {
        assert.notEqual(options.auditRequestedRevision, undefined, 'Ordinary collection cannot acknowledge audit work')
        assert.deepEqual(request.where, {
          organizationId: tenant.organizationId, customerTenantId: tenant.id,
          resourceType: 'AUTH_REGISTRATIONS', requestedRevision: options.auditRequestedRevision,
          completedRevision: { lt: options.auditRequestedRevision },
        })
        assert.equal(request.data.completedRevision, options.auditRequestedRevision)
        receipts.push(request)
        recordWrite('receipt')
        if (request.where.requestedRevision !== (options.pendingRevision ?? 7n) ||
            completedRevision >= request.data.completedRevision) return { count: 0 }
        completedRevision = request.data.completedRevision
        return { count: 1 }
      },
    },
  }
  const database = {
    ...transaction,
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      active = ++sequence
      const previousRevision = completedRevision
      try {
        const result = await work(transaction)
        committedTransactions.push(active)
        return result
      } catch (error) {
        completedRevision = previousRevision
        throw error
      } finally {
        active = 0
      }
    },
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    { resolveIncident: async () => { events.push('resolve') },
      publishIncident: async () => { events.push('publish') } } as any,
    { buildSnapshotDifferenceEvidence: () => [{ sourceEventId: 'synthetic' }] } as any,
    {} as any) as any
  if (!options.enrichment) {
    service.enrichAuthenticationRegistrationsWithPerUserMfaState = async (
      _token: string, rows: unknown[],
    ) => rows
    service.enrichAuthenticationRegistrationsWithConditionalAccessContext = async (
      _token: string, rows: unknown[],
    ) => rows
  }
  const originalFetch = globalThis.fetch
  let pages = 0
  let error: unknown
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (options.enrichment && url.endsWith('/$batch')) {
      const requests = JSON.parse(String(init?.body)).requests as Array<{ id: string; url: string }>
      const enrichmentSource = requests[0]?.url.includes('/authentication/requirements') ? 'requirements'
        : requests[0]?.url.includes('/transitiveMemberOf/') ? 'membership' : undefined
      if (enrichmentSource) {
        assert.equal(requests.length, 2)
        assert.ok(requests.every(request => request.url.includes(
          enrichmentSource === 'requirements' ? '/authentication/requirements' : '/transitiveMemberOf/')))
        const variant = options.enrichment.source === enrichmentSource ? options.enrichment.response : 'complete'
        events.push(`enrichment:${enrichmentSource}:${variant}`)
        return new Response(JSON.stringify({ responses: requests.map((request, index) => ({
          id: request.id,
          status: index === 1 && variant === 'permission-limited' ? 403
            : index === 1 && variant === 'item-partial' ? 206 : 200,
          ...(index === 1 && variant === 'item-warning' ? { headers: { WaRnInG: '299 synthetic "partial"' } } : {}),
          ...(index === 1 && variant === 'malformed-headers' ? { headers: ['synthetic-unverified'] } : {}),
          body: {
            ...(enrichmentSource === 'requirements' ? { perUserMfaState: 'enforced' }
              : { value: [{ id: 'group-1' }] }),
            ...(index === 1 && variant === 'nested-continuation'
              ? { nested: { 'members@odata.nextLink': 'https://graph.microsoft.com/unread-nested-page' } } : {}),
            ...(index === 1 && variant === 'continuation'
              ? { '@odata.nextLink': 'https://graph.microsoft.com/unread-enrichment-page' } : {}),
          },
        })) }), { status: variant === 'batch-partial' ? 206 : 200,
          headers: variant === 'batch-warning' ? { warning: '299 synthetic "partial"' } : {} })
      }
    }
    if (options.fallback) {
      if (url.includes('/reports/authenticationMethods/userRegistrationDetails')) {
        events.push('premium-unavailable')
        return new Response(JSON.stringify({ error: { code: NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE } }),
          { status: 403 })
      }
      if (url.includes('/users?')) {
        assert.ok(++pages <= 2)
        const qualified = options.fallback === 'users' && pages === partialPage
        events.push(qualified ? 'qualified-page' : 'complete-page')
        return new Response(JSON.stringify({
          value: options.userRows?.(pages) ?? [{ id: `user-${pages}`, userPrincipalName: `user-${pages}@example.test` }],
          ...(pages === 1 ? { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=synthetic' } : {}),
        }), { status: qualified ? partialStatus : 200,
          headers: qualified && warning !== undefined ? { warning } : {} })
      }
      assert.equal(url, 'https://graph.microsoft.com/v1.0/$batch')
      const requests = JSON.parse(String(init?.body)).requests as Array<{ id: string }>
      assert.equal(requests.length, 2)
      const qualified = options.fallback === 'batch' && partialPage > 0
      events.push(qualified || options.fallback === 'item' ? 'qualified-page' : 'complete-batch')
      return new Response(JSON.stringify({ responses: requests.map((request, index) => {
        const itemQualified = options.fallback === 'item' && index + 1 === partialPage
        return { id: request.id, status: itemQualified ? partialStatus : 200,
          ...(itemQualified && warning !== undefined ? { headers: { WaRnInG: warning } } : {}),
          body: { value: options.methodRows ?? [{ '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }],
            ...(itemQualified && options.continuation ? { '@odata.nextLink': 'https://graph.microsoft.com/remaining' } : {}) } }
      }) }), { status: qualified ? partialStatus : 200,
        headers: qualified && warning !== undefined ? { warning } : {} })
    }
    assert.ok(url.startsWith('https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails'))
    assert.ok(++pages <= 2, 'The fixture has only two pages')
    const qualified = pages === partialPage
    events.push(qualified ? 'qualified-page' : 'complete-page')
    return new Response(JSON.stringify({
      value: options.reportRows?.(pages) ?? [{ id: `user-${pages}`, isMfaRegistered: true }],
      ...(pages === 1 ? { '@odata.nextLink':
        'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$skiptoken=synthetic',
      } : {}),
    }), {
      status: qualified ? partialStatus : 200,
      headers: qualified && warning !== undefined ? { warning } : {},
    })
  }
  try {
    await service.syncAuthenticationRegistrations(tenant, 'synthetic-token',
      options.ownerless ? undefined : owner, options.auditRequestedRevision)
  } catch (caught) {
    error = caught
  } finally {
    globalThis.fetch = originalFetch
  }
  return { events, snapshots, pages, error, observations, writes, committedTransactions, receipts, completedRevision }
}

test('complete paged authentication registrations still reach the snapshot boundary', async () => {
  const result = await registrationCompletenessFixture()
  assert.equal(result.error, undefined)
  assert.equal(result.pages, 2)
  assert.deepEqual(result.snapshots, [[
    { id: 'user-1', isMfaRegistered: true }, { id: 'user-2', isMfaRegistered: true },
  ]])
  assert.ok(result.events.includes('SUCCEEDED'))
})

for (const page of [1, 2]) {
  for (const qualifier of ['http-206', 'warning'] as const) {
    test(`owner-bearing AUTH_REGISTRATIONS ${qualifier} on page ${page} must not produce a complete snapshot`, async () => {
      const result = await registrationCompletenessFixture(page,
        qualifier === 'http-206' ? 206 : 200,
        qualifier === 'warning' ? '299 synthetic "partial response"' : undefined)
      assert.ok(result.events.includes('qualified-page'), 'The target provider response must be reached')
      assert.deepEqual({
        snapshotCount: result.snapshots.length,
        evidenceWrites: result.events.filter(event => event === 'evidence').length,
        successful: result.events.includes('SUCCEEDED'),
      }, { snapshotCount: 0, evidenceWrites: 0, successful: false },
        'A qualified partial registration page cannot authorize a complete snapshot or a future audit-work receipt')
    })
  }
}


test('complete non-premium fallback still reaches one snapshot after all users and method batches', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined, { fallback: 'batch' })
  assert.equal(result.error, undefined)
  assert.equal(result.pages, 2)
  assert.equal(result.snapshots.length, 1)
  assert.ok(result.events.includes('SUCCEEDED'))
})

for (const stage of ['users', 'batch', 'item'] as const) {
  for (const qualifier of ['http-206', 'warning', ...(stage === 'item' ? ['continuation'] : [])]) {
    test(`owner-bearing registration fallback refuses ${qualifier} at ${stage} boundary`, async () => {
      const result = await registrationCompletenessFixture(stage === 'batch' ? 1 : 2,
        qualifier === 'http-206' ? 206 : 200,
        qualifier === 'warning' ? '299 synthetic "private partial detail"' : undefined,
        { fallback: stage, continuation: qualifier === 'continuation' })
      assert.ok(result.events.includes('qualified-page'))
      assert.equal(result.snapshots.length, 0)
      assert.ok(!result.events.includes('evidence'))
      assert.ok(!result.events.includes('SUCCEEDED'))
      assert.ok(result.events.includes('FAILED'))
    })
  }
}

test('ownerless registration transport behavior is unchanged by the inactive guard', async () => {
  for (const fallback of [undefined, 'users', 'batch', 'item'] as const) {
    const result = await registrationCompletenessFixture(1, 200, '299 synthetic "partial"',
      { fallback, ownerless: true })
    assert.equal(result.error, undefined)
    assert.equal(result.snapshots.length, 1)
    assert.ok(result.events.includes('SUCCEEDED'))
  }
})

for (const [label, methods] of [
  ['no methods', []],
  ['only a password method', [{ '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' }]],
  ['only a recovery email', [{ '@odata.type': '#microsoft.graph.emailAuthenticationMethod' }]],
] as const) {
  test(`complete fallback with ${label} keeps explicit negative registration`, async () => {
    const result = await registrationCompletenessFixture(0, 200, undefined,
      { fallback: 'batch', methodRows: [...methods] })
    assert.equal(result.error, undefined)
    assert.ok(result.events.includes('SUCCEEDED'))
    const rows = result.snapshots[0] as Array<Record<string, unknown>>
    assert.deepEqual(rows.map(row => row.id), ['user-1', 'user-2'])
    assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistration), ['Not registered', 'Not registered'])
  })
}

// Complete HTTP pages are insufficient proof for an audit-work receipt when
// row identities or method meaning remain unverified. Keep these regressions
// active while the owner-bearing runtime candidate remains unactivated.
for (const defect of ['missing-report-id', 'conflicting-report-id', 'missing-method-type', 'unknown-method-type'] as const) {
  test(`AUTH_REGISTRATIONS completion must refuse ${defect}`, async () => {
    const report = defect === 'missing-report-id' || defect === 'conflicting-report-id'
    const result = report
      ? await registrationCompletenessFixture(0, 200, undefined, {
        reportRows: page => page === 1 ? [{ id: 'user-1', isMfaRegistered: true }]
          : [defect === 'missing-report-id' ? { isMfaRegistered: false } : { id: 'user-1', isMfaRegistered: false }],
      })
      : await registrationCompletenessFixture(0, 200, undefined, {
        fallback: 'batch', methodRows: defect === 'missing-method-type' ? [{ displayName: 'unclassified' }]
          : [{ '@odata.type': '#microsoft.graph.syntheticFutureAuthenticationMethod' }],
      })
    assert.equal(result.pages, 2, 'Both complete transport pages must be exercised')
    assert.ok(!result.events.includes('qualified-page'), 'This is a row-semantics witness, not partial HTTP')
    assert.deepEqual({
      snapshotCount: result.snapshots.length,
      evidenceWrites: result.events.filter(event => event === 'evidence').length,
      successful: result.events.includes('SUCCEEDED'),
    }, { snapshotCount: 0, evidenceWrites: 0, successful: false },
    `Unverified registration rows cannot authorize complete source publication: ${JSON.stringify(result.snapshots)}`)
  })
}

test('owner-bearing registration rejects empty, padded, overlong and non-string identities', async () => {
  for (const id of ['', ' user-2', 'x'.repeat(129), 7]) {
    const result = await registrationCompletenessFixture(0, 200, undefined, {
      reportRows: page => [{ id: page === 1 ? 'user-1' : id, isMfaRegistered: true }],
    })
    assert.equal(result.snapshots.length, 0)
    assert.ok(result.events.includes('FAILED'))
    assert.ok(!result.events.includes('SUCCEEDED'))
  }
})

test('owner-bearing registration rejects repeated identities even when their facts agree', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined, {
    reportRows: () => [{ id: 'user-1', isMfaRegistered: true }],
  })
  assert.equal(result.snapshots.length, 0)
  assert.ok(result.events.includes('FAILED'))
})

test('owner-bearing fallback cannot publish duplicate users from separate discovery pages', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined, {
    fallback: 'batch', userRows: () => [{ id: 'user-1', userPrincipalName: 'user-1@example.test' }],
  })
  assert.equal(result.pages, 2)
  assert.ok(result.events.includes('complete-batch'))
  assert.equal(result.snapshots.length, 0)
  assert.ok(result.events.includes('FAILED'))
  assert.ok(!result.events.includes('SUCCEEDED'))
})

test('owner-bearing method fallback refuses malformed or unclassified items alongside a known method', async () => {
  for (const method of [null, 7, { '@odata.type': 7 }, { '@odata.type': 'toString' },
    { '@odata.type': '#microsoft.graph.syntheticFutureAuthenticationMethod' }]) {
    const result = await registrationCompletenessFixture(0, 200, undefined, {
      fallback: 'batch', methodRows: [
        { '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }, method,
      ],
    })
    assert.equal(result.snapshots.length, 0)
    assert.ok(result.events.includes('FAILED'))
    assert.ok(!result.events.includes('SUCCEEDED'))
  }
})

test('inactive row guard preserves existing ownerless registration behavior', async () => {
  for (const options of [
    { reportRows: () => [{ isMfaRegistered: false }] },
    { fallback: 'batch' as const, methodRows: [{ '@odata.type': '#microsoft.graph.syntheticFutureAuthenticationMethod' }] },
  ]) {
    const result = await registrationCompletenessFixture(0, 200, undefined, { ...options, ownerless: true })
    assert.equal(result.error, undefined)
    assert.equal(result.snapshots.length, 1)
    assert.ok(result.events.includes('SUCCEEDED'))
  }
})

const unverifiedRegistrationValues: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: 'missing', value: undefined }, { label: 'null', value: null },
  { label: 'string-true', value: 'true' }, { label: 'string-false', value: 'false' },
  { label: 'zero', value: 0 }, { label: 'one', value: 1 },
  { label: 'array', value: [] }, { label: 'object', value: {} },
]

// A complete transport response does not establish the registration fact if
// its value is missing or malformed. Independent enrichment cannot repair it.
for (const page of [1, 2]) {
  for (const { label, value } of unverifiedRegistrationValues) {
    test(`owner-bearing registration refuses ${label} registration value on page ${page}`, async () => {
      const result = await registrationCompletenessFixture(0, 200, undefined, {
        reportRows: current => [{ id: `user-${current}`, isMfaRegistered: current === page ? value : true }],
        enrichment: { source: 'requirements', response: 'complete' },
      })
      assert.equal(result.pages, 2, 'Both complete report pages must be exercised')
      assert.equal(result.events.filter(event => event === 'complete-page').length, 2)
      assert.deepEqual({
        snapshots: result.snapshots.length,
        evidence: result.events.filter(event => event === 'evidence').length,
        succeeded: result.events.includes('SUCCEEDED'),
        failed: result.events.includes('FAILED'),
      }, { snapshots: 0, evidence: 0, succeeded: false, failed: true })
      assert.ok(!result.events.some(event => event.startsWith('enrichment:')),
        'Unknown primary registration cannot be promoted by independent optional evidence')
    })
  }
}

test('minimal boolean registration facts remain complete without optional report fields', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined, {
    reportRows: page => [{ id: `user-${page}`, isMfaRegistered: page === 1 }],
    enrichment: { source: 'requirements', response: 'complete' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.snapshots.length, 1)
  assert.equal(result.events.filter(event => event === 'evidence').length, 1)
  assert.ok(result.events.includes('SUCCEEDED'))
  const rows = result.snapshots[0] as Array<Record<string, unknown>>
  assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistration), ['Registered', 'Not registered'])
  assert.deepEqual(rows.map(row => projectMfaTruth(row).perUserMfaState), ['Enforced', 'Enforced'])
  assert.ok(rows.every(row => projectMfaTruth(row).mfaRegistrationSource === 'microsoft-graph-user-registration-details'))
})

test('registration value is not inferred from capability, method names or optional enforcement', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined, {
    reportRows: page => [{ id: `user-${page}`, isMfaRegistered: page === 1,
      isMfaCapable: page !== 1, methodsRegistered: page === 1 ? [] : ['microsoftAuthenticatorPush'] }],
    enrichment: { source: 'requirements', response: 'complete' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.snapshots.length, 1)
  assert.ok(result.events.includes('SUCCEEDED'))
  assert.deepEqual((result.snapshots[0] as unknown[]).map(row => projectMfaTruth(row).mfaRegistration),
    ['Registered', 'Not registered'])
})

test('inactive value guard preserves ownerless unknown registration handling', async () => {
  for (const { value } of unverifiedRegistrationValues) {
    const result = await registrationCompletenessFixture(0, 200, undefined, {
      ownerless: true,
      reportRows: page => [{ id: `user-${page}`, isMfaRegistered: value }],
      enrichment: { source: 'requirements', response: 'complete' },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.snapshots.length, 1)
    assert.ok(result.events.includes('SUCCEEDED'))
    const rows = result.snapshots[0] as unknown[]
    assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistration), ['Unknown', 'Unknown'])
    assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistrationSource), [null, null])
    assert.deepEqual(rows.map(row => projectMfaTruth(row).perUserMfaState), ['Enforced', 'Enforced'])
  }
})

for (const fallback of [false, true]) {
  const route = fallback ? 'fallback' : 'report'
  for (const revision of [7n, 11n]) {
    test(`${route} registration saves exact audit revision ${revision} with its snapshot`, async () => {
      const result = await registrationCompletenessFixture(0, 200, undefined, {
        ...(fallback ? { fallback: 'batch' as const } : {}),
        auditRequestedRevision: revision, pendingRevision: revision,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.completedRevision, revision)
      assert.equal(result.receipts.length, 1)
      assert.deepEqual(result.writes.map(write => write.kind), ['evidence', 'snapshot', 'receipt'])
      const transaction = result.writes[0].transaction
      assert.ok(transaction > 0 && result.committedTransactions.includes(transaction))
      assert.ok(result.writes.every(write => write.transaction === transaction),
        'Evidence, snapshot and exact-revision acknowledgment must share the owner-checked transaction')
      assert.equal(result.receipts[0].data.lastCompletedAt.getTime(), result.observations[0].getTime())
      assert.ok(result.events.indexOf('receipt') < result.events.indexOf('SUCCEEDED'))
    })
  }

  for (const source of ['requirements', 'membership'] as const) {
    test(`${route} complete registration can acknowledge while optional ${source} stays unknown`, async () => {
      const result = await registrationCompletenessFixture(0, 200, undefined, {
        ...(fallback ? { fallback: 'batch' as const } : {}), auditRequestedRevision: 7n,
        enrichment: { source, response: 'batch-warning' },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.completedRevision, 7n)
      assert.equal(result.receipts.length, 1)
      assert.ok(result.events.includes('SUCCEEDED'))
      const rows = result.snapshots[0] as Array<Record<string, any>>
      assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistration), ['Registered', 'Registered'])
      if (source === 'requirements') assert.ok(rows.every(row => projectMfaTruth(row).perUserMfaState === 'Unknown'))
      else assert.ok(rows.every(row => row.conditionalAccessContext.membershipComplete === false))
    })
  }
}

test('ordinary registration has no audit receipt without an explicit revision', async () => {
  const result = await registrationCompletenessFixture()
  assert.equal(result.error, undefined)
  assert.equal(result.snapshots.length, 1)
  assert.deepEqual(result.receipts, [])
  assert.equal(result.completedRevision, 0n)
})

test('older registration collection cannot acknowledge a newer or already completed audit revision', async () => {
  for (const [pendingRevision, completedRevision] of [[8n, 2n], [7n, 7n]]) {
    const result = await registrationCompletenessFixture(0, 200, undefined, {
      auditRequestedRevision: 7n, pendingRevision, completedRevision,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.snapshots.length, 1)
    assert.equal(result.receipts.length, 1, 'The conditional exact-revision acknowledgment must be attempted')
    assert.equal(result.completedRevision, completedRevision)
    assert.ok(result.events.includes('SUCCEEDED'), 'A complete snapshot is independent from whether newer work stays pending')
  }
})

test('partial or unverified registration sources cannot acknowledge audit work', async () => {
  const cases: Array<{ page: number; status: number; warning?: string; options: ReceiptProbeOptions }> = [
    { page: 2, status: 206, options: {} },
    { page: 2, status: 200, warning: '299 synthetic "partial"', options: {} },
    { page: 0, status: 200, options: { reportRows: page => [{ id: `user-${page}`, isMfaRegistered: page === 1 ? true : null }] } },
    { page: 0, status: 200, options: { reportRows: () => [{ id: 'duplicate-user', isMfaRegistered: true }] } },
    { page: 2, status: 206, options: { fallback: 'users' } },
    { page: 1, status: 206, options: { fallback: 'batch' } },
    { page: 2, status: 200, options: { fallback: 'item', continuation: true } },
    { page: 0, status: 200, options: { fallback: 'batch', methodRows: [{ '@odata.type': '#microsoft.graph.syntheticUnknownMethod' }] } },
  ]
  for (const probe of cases) {
    const result = await registrationCompletenessFixture(probe.page, probe.status, probe.warning,
      { ...probe.options, auditRequestedRevision: 7n })
    assert.equal(result.snapshots.length, 0)
    assert.deepEqual(result.writes, [])
    assert.deepEqual(result.receipts, [])
    assert.equal(result.completedRevision, 0n)
    assert.ok(result.events.includes('FAILED'))
    assert.ok(!result.events.includes('SUCCEEDED'))
  }
})

for (const writeFailure of ['evidence', 'snapshot', 'receipt'] as const) {
  test(`registration ${writeFailure} failure cannot commit a snapshot receipt or report success`, async () => {
    const result = await registrationCompletenessFixture(0, 200, undefined,
      { auditRequestedRevision: 7n, writeFailure })
    assert.ok(result.writes.some(write => write.kind === writeFailure), 'The intended failure boundary must be reached')
    assert.ok(result.writes.every(write => !result.committedTransactions.includes(write.transaction)),
      'The transaction callback must reject; physical rollback remains a registered PostgreSQL requirement')
    assert.equal(result.completedRevision, 0n)
    assert.ok(result.events.includes('FAILED'))
    assert.ok(!result.events.includes('SUCCEEDED'))
  })
}

test('registration owner loss before snapshot leaves the audit request pending', async () => {
  const result = await registrationCompletenessFixture(0, 200, undefined,
    { auditRequestedRevision: 7n, lostOwnerAtSnapshot: true })
  assert.ok(result.error instanceof TenantVisitLeaseLostError)
  assert.equal(result.pages, 2)
  assert.deepEqual(result.writes, [])
  assert.deepEqual(result.receipts, [])
  assert.equal(result.completedRevision, 0n)
  assert.ok(!result.events.includes('SUCCEEDED'))
})

test('invalid registration audit requests refuse before status or provider work', async () => {
  for (const [suppliedOwner, revision] of [
    [undefined, 7n], [owner, 0n], [owner, -1n], [owner, 9223372036854775808n], [owner, '7'],
  ]) {
    const service = new TenantSyncService({} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any) as any
    service.runSnapshotSync = async () => assert.fail('invalid receipt entered collection')
    await assert.rejects(() => service.syncAuthenticationRegistrations(tenant, 'synthetic-token', suppliedOwner, revision),
      /TENANT_AUDIT_RECONCILIATION_SNAPSHOT_RECEIPT_INVALID/)
  }
  for (const suppliedOwner of [{ ...owner, organizationId: 'another-organization' },
    { ...owner, customerTenantId: 'another-tenant' }]) {
    const service = new TenantSyncService({} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any) as any
    service.runSnapshotSync = async () => assert.fail('cross-scope receipt entered collection')
    await assert.rejects(() => service.syncAuthenticationRegistrations(tenant, 'synthetic-token', suppliedOwner, 7n),
      TenantVisitLeaseLostError)
  }
})


// These cases exercise both real optional enrichers through the owner-bearing
// collector and snapshot boundary. A valid registration fact is independent
// from whether optional requirement or group-membership evidence was read.
// Keep these regressions active while strict enrichment remains inactive.

async function enrichedRegistrationWitness(fallback: boolean, enrichment: EnrichmentWitness, ownerless = false) {
  const result = await registrationCompletenessFixture(0, 200, undefined,
    { ...(fallback ? { fallback: 'batch' as const } : {}), enrichment, ownerless })
  assert.equal(result.error, undefined)
  assert.equal(result.pages, 2)
  assert.ok(result.events.includes(`enrichment:${enrichment.source}:${enrichment.response}`))
  assert.equal(result.snapshots.length, 1)
  assert.equal(result.events.filter(event => event === 'evidence').length, 1)
  assert.ok(result.events.includes('SUCCEEDED'), 'Optional unknowns must not erase complete registration facts')
  const rows = result.snapshots[0] as Array<Record<string, any>>
  assert.deepEqual(rows.map(row => row.id), ['user-1', 'user-2'])
  assert.deepEqual(rows.map(row => projectMfaTruth(row).mfaRegistration), ['Registered', 'Registered'])
  return rows
}

for (const fallback of [false, true]) {
  const route = fallback ? 'fallback' : 'report'
  test(`${route} completion keeps verified optional enrichment distinct from registration`, async () => {
    const rows = await enrichedRegistrationWitness(fallback, { source: 'requirements', response: 'complete' })
    assert.deepEqual(rows.map(row => projectMfaTruth(row).perUserMfaState), ['Enforced', 'Enforced'])
    for (const row of rows) {
      assert.equal(row.conditionalAccessContext.membershipComplete, true)
      assert.deepEqual(row.conditionalAccessContext.transitiveGroupIds, ['group-1'])
    }
  })

  for (const source of ['requirements', 'membership'] as const) {
    const assertUnknown = (rows: Array<Record<string, any>>, all: boolean) => {
      const targets = all ? rows : [rows[1]]
      if (source === 'requirements') {
        for (const row of targets) {
          assert.equal(row.perUserMfaState, null, 'Unverified requirement evidence must remain null')
          assert.equal(projectMfaTruth(row).perUserMfaState, 'Unknown')
          assert.equal(projectMfaTruth(row).perUserMfaStateSource, null)
        }
        assert.ok(rows.every(row => row.conditionalAccessContext.membershipComplete === true))
        if (!all) assert.equal(projectMfaTruth(rows[0]).perUserMfaState, 'Enforced')
      } else {
        for (const row of targets) {
          assert.equal(row.conditionalAccessContext.membershipComplete, false,
            'Unverified membership cannot become complete group evidence')
          assert.deepEqual(row.conditionalAccessContext.transitiveGroupIds, [])
          assert.ok(row.conditionalAccessContext.reasonCode)
        }
        assert.ok(rows.every(row => projectMfaTruth(row).perUserMfaState === 'Enforced'))
        if (!all) assert.equal(rows[0].conditionalAccessContext.membershipComplete, true)
      }
    }
    for (const response of ['permission-limited', 'item-partial',
      ...(source === 'membership' ? ['continuation' as const] : [])] as const) {
      test(`${route} completion preserves unknown ${source} for ${response}`, async () => {
        assertUnknown(await enrichedRegistrationWitness(fallback, { source, response }), false)
      })
    }
    for (const response of ['batch-partial', 'batch-warning', 'item-warning', 'malformed-headers', 'nested-continuation'] as const) {
      test(`${route} completion must not certify ${source} after ${response}`,
        async () => {
          assertUnknown(await enrichedRegistrationWitness(fallback, { source, response }), response === 'batch-partial' || response === 'batch-warning')
        })
    }
  }
}


test('inactive enrichment qualification preserves ownerless collection behavior', async () => {
  for (const fallback of [false, true]) {
    for (const source of ['requirements', 'membership'] as const) {
      for (const response of ['batch-partial', 'batch-warning', 'item-warning'] as const) {
        const rows = await enrichedRegistrationWitness(fallback, { source, response }, true)
        assert.ok(rows.every(row => projectMfaTruth(row).perUserMfaState === 'Enforced'))
        assert.ok(rows.every(row => row.conditionalAccessContext.membershipComplete === true))
      }
    }
  }
})
