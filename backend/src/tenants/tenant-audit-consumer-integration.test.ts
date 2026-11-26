import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
  AUDIT_EVIDENCE_SENTINEL_ROWS,
  AUDIT_EVIDENCE_TENANT_CAP,
  auditEvidencePageCount,
} from './tenant-health-audit-evidence.js'
import { TENANT_HEALTH_MODEL_VERSION, TENANT_HEALTH_RESOURCE_REGISTRY } from './tenant-health.js'
import { TenantsService } from './tenants.service.js'

/**
 * Consumer integration for the tenant-scoped audit-evidence reader.
 *
 * These exercise the REAL service entrypoints — `listForIdentity`,
 * `verifyConnectionForIdentity`, `createForIdentity` — against controlled fake
 * storage, rather than the standalone reader. Nothing here opens a connection,
 * starts a server, or makes a provider call.
 *
 * What these do NOT establish: actual SQL ranking or byte accounting, driver
 * row shapes, query plans, transfer cost, RSS or latency, deployed permissions
 * or `search_path`, provider completeness, source-version coherence, history
 * admission, or any part of the customer-facing HAW-70 outcome. Those remain
 * with the registered physical witness and with later gates.
 */

const NOW = new Date('2026-11-25T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const identity = { subject: 'consumer-owner' } as never
const consent = {
  getRequiredPermissions: () => [],
  getAccessContract: () => ({ connectionRequiredPermissions: [], capabilities: [] }),
}

const uuid = (kind: string, slot: number) =>
  `${kind}0000-0000-4000-8000-${String(slot).padStart(12, '0')}`
const ORG = uuid('0a11', 1)
const ORG_OTHER = uuid('0a11', 2)
const QUIET = uuid('0b22', 1)
const NOISY = uuid('0b22', 2)
const FOREIGN_TENANT = uuid('0b22', 9)

type SeedEvent = {
  organizationId: string
  customerTenantId: string
  microsoftAuditId: string
  eventDateTime: Date
  expiresAt: Date
  activityDisplayName: string
  category: string | null
  operationType: string | null
  result: string | null
  initiatedByText: string | null
  targetResourcesText: string | null
  fieldOversize?: boolean
  overBudget?: boolean
}

function event(partial: Partial<SeedEvent> & { microsoftAuditId: string }): SeedEvent {
  return {
    organizationId: ORG,
    customerTenantId: QUIET,
    eventDateTime: new Date(NOW.getTime() - 1000),
    expiresAt: new Date(NOW.getTime() + DAY),
    activityDisplayName: 'Update authentication method',
    category: 'UserManagement',
    operationType: 'Update',
    result: 'success',
    initiatedByText: JSON.stringify({ user: { userPrincipalName: 'admin@example.invalid' } }),
    targetResourcesText: JSON.stringify([{ type: 'authenticationMethod', displayName: 'method' }]),
    ...partial,
  }
}

/** A critical, policy-destructive finding: the kind that must survive. */
function criticalEvent(partial: Partial<SeedEvent> & { microsoftAuditId: string }): SeedEvent {
  return event({
    activityDisplayName: 'Disable conditional access policy',
    category: 'Policy',
    targetResourcesText: JSON.stringify([{ type: 'conditionalAccessPolicy', displayName: 'Require MFA' }]),
    ...partial,
  })
}

type SyncStateRow = {
  resourceType: string; status: string; lastAttemptAt: Date | null; lastSuccessfulAt: Date | null
  lastErrorCode: string | null; lastErrorMessage: string | null; consecutiveFailures: number
}

function tenantRow(id: string, organizationId = ORG, displayName = id) {
  return {
    id, microsoftTenantId: `microsoft-${id}`, displayName, primaryDomain: null,
    status: 'ACTIVE', organization: { id: organizationId, name: organizationId, slug: organizationId },
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      consentedPermissions: [] as string[], lastVerifiedAt: NOW, lastErrorCode: null,
      onboardingCompletedAt: null },
    tenantLicenses: [] as Array<{ enabledUnits: number; servicePlans?: unknown }>,
    syncStates: [] as SyncStateRow[],
    entraSnapshots: [] as Array<{ resourceType: string; payload: unknown; observedAt: Date }>,
    collectionFieldStates: [] as Array<{ fieldKey: string; state: string; reasonCode: string | null }>,
    m365ActivitySubscriptions: [] as Array<{ contentType: string; status: string
      lastStartRequestedAt: Date | null; lastVerifiedAt: Date | null
      lastSuccessfulPollAt: Date | null; lastError: string | null }>,
  }
}

type AuditRead = { sql: string; params: unknown[]; pairs: Array<[string, string]> }

function pairsOf(params: unknown[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 5; index < params.length; index += 2) {
    pairs.push([String(params[index]), String(params[index + 1])])
  }
  return pairs
}

/** Adapter-level projection of the bound statement. See the note in
 *  `tenant-list-expiry.test.ts`: this honours the bound parameters, it is not
 *  evidence that the statement itself is correct. */
function project(read: AuditRead, seeds: readonly SeedEvent[]) {
  const [fieldBytes, eventFloor, asOf, sentinelRows, tenantBytes] = read.params as
    [number, Date, Date, number, number]
  const requested = new Set(read.pairs.map(([org, tenant]) => `${org}\u0000${tenant}`))
  const rows: any[] = []
  const byTenant = new Map<string, SeedEvent[]>()
  for (const seed of seeds) {
    if (!requested.has(`${seed.organizationId}\u0000${seed.customerTenantId}`)) continue
    if (seed.eventDateTime < eventFloor || seed.expiresAt <= asOf) continue
    const bucket = byTenant.get(seed.customerTenantId) ?? []
    bucket.push(seed)
    byTenant.set(seed.customerTenantId, bucket)
  }
  for (const [, bucket] of byTenant) {
    bucket.sort((left, right) =>
      right.eventDateTime.getTime() - left.eventDateTime.getTime() ||
      right.microsoftAuditId.localeCompare(left.microsoftAuditId))
    let running = 0
    bucket.slice(0, sentinelRows).forEach((seed, offset) => {
      const initiatedBytes = Buffer.byteLength(seed.initiatedByText ?? '', 'utf8')
      const targetBytes = Buffer.byteLength(seed.targetResourcesText ?? '', 'utf8')
      running += Math.min(initiatedBytes, fieldBytes) + Math.min(targetBytes, fieldBytes)
      const oversize = seed.fieldOversize ?? (initiatedBytes > fieldBytes || targetBytes > fieldBytes)
      const overBudget = seed.overBudget ?? running > tenantBytes
      const withheld = oversize || overBudget
      rows.push({
        organization_id: seed.organizationId,
        customer_tenant_id: seed.customerTenantId,
        microsoft_audit_id: seed.microsoftAuditId,
        event_date_time: seed.eventDateTime,
        activity_display_name: seed.activityDisplayName,
        category: seed.category,
        operation_type: seed.operationType,
        result: seed.result,
        row_position: String(offset + 1),
        field_oversize: oversize,
        over_payload_budget: overBudget,
        initiated_by_withheld: withheld,
        target_resources_withheld: withheld,
        initiated_by_text: withheld ? null : seed.initiatedByText,
        target_resources_text: withheld ? null : seed.targetResourcesText,
      })
    })
  }
  return rows
}

type Options = {
  tenants?: ReturnType<typeof tenantRow>[]
  organizations?: string[]
  seeds?: readonly SeedEvent[]
  override?: (read: AuditRead, index: number) => unknown[] | Error | undefined
  previous?: Map<string, any>
  onCreate?: (data: any) => void
}

function harness(options: Options = {}) {
  const tenants = options.tenants ?? [tenantRow(QUIET)]
  const seeds = options.seeds ?? []
  const previous = options.previous ?? new Map<string, any>()
  const reads: AuditRead[] = []
  const writes: any[] = []
  const events: string[] = []
  const concurrency = { activeReads: 0, peakReads: 0, activeHistory: 0, peakHistory: 0 }
  const prisma: any = {
    user: { findUnique: async () => ({ disabledAt: null,
      memberships: (options.organizations ?? [ORG]).map(organizationId => ({
        organizationId,
        // The role-scoped lookup also projects organization onboarding.
        organization: { onboardingCompletedAt: NOW },
      })) }) },
    customerTenant: {
      findMany: async ({ where }: any) => tenants
        .filter(t => where.organizationId.in.includes(t.organization.id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }: any) => ({ ...tenantRow(QUIET), ...data }),
      findUniqueOrThrow: async () => tenants[0],
    },
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (!sql.includes('directory_audit_logs')) return []
      const read = { sql, params, pairs: pairsOf(params) }
      const index = reads.length
      reads.push(read)
      events.push(`read:${index}`)
      concurrency.activeReads += 1
      concurrency.peakReads = Math.max(concurrency.peakReads, concurrency.activeReads)
      try {
        await new Promise(resolve => setImmediate(resolve))
        const replacement = options.override?.(read, index)
        if (replacement instanceof Error) throw replacement
        return replacement ?? project(read, seeds)
      } finally {
        concurrency.activeReads -= 1
      }
    },
    tenantHealthSnapshot: {
      findFirst: async ({ where }: any) => {
        concurrency.activeHistory += 1
        concurrency.peakHistory = Math.max(concurrency.peakHistory, concurrency.activeHistory)
        try {
          await new Promise(resolve => setImmediate(resolve))
          return previous.get(where.customerTenantId) ?? null
        } finally {
          concurrency.activeHistory -= 1
        }
      },
      create: async ({ data }: any) => {
        options.onCreate?.(data)
        events.push(`write:${data.customerTenantId}`)
        writes.push(data)
        return data
      },
    },
    markInitialSyncDue: undefined,
  }
  const service = new TenantsService(prisma, consent as never, {} as never)
  const warnings: string[] = []
  ;(service as any).logger = { debug() {}, warn(message: string) { warnings.push(message) } }
  return { service, prisma, reads, writes, events, concurrency, warnings, tenants }
}

const list = (h: ReturnType<typeof harness>) =>
  h.service.listForIdentity(identity, { now: () => NOW })
const auditKeys = (value: { attention: Array<{ key: string }> }) =>
  value.attention.filter(item => item.key.startsWith('audit-')).map(item => item.key)

// ---------------------------------------------------------------------------
// Exact pairs, authorization scope and response preservation
// ---------------------------------------------------------------------------

test('a noisy tenant cannot hide a quiet tenant’s older critical event, and the quiet finding is saved', async () => {
  const seeds: SeedEvent[] = [
    ...Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS }, (_, index) => event({
      customerTenantId: NOISY, microsoftAuditId: `noisy-${String(index).padStart(4, '0')}`,
      eventDateTime: new Date(NOW.getTime() - 1000 - index),
    })),
    criticalEvent({ customerTenantId: QUIET, microsoftAuditId: 'quiet-critical',
      eventDateTime: new Date(NOW.getTime() - 20 * 60 * 60 * 1000) }),
  ]
  const h = harness({ tenants: [tenantRow(NOISY, ORG, 'a-noisy'), tenantRow(QUIET, ORG, 'b-quiet')], seeds })
  const result = await list(h)
  assert.deepEqual(result.tenants.map(t => t.id), [NOISY, QUIET])
  const quiet = result.tenants[1]!
  assert.deepEqual(auditKeys(quiet), ['audit-ca-quiet-critical'])
  assert.equal(quiet.tenantHealth.security.criticalFindings, 1)
  assert.equal(quiet.tenantHealth.auditEvidence.status, 'COMPLETE')
  const savedQuiet = h.writes.find(w => w.customerTenantId === QUIET)!
  assert.deepEqual(auditKeys(savedQuiet.payload), ['audit-ca-quiet-critical'])
  // The noisy tenant's own window is capped and therefore never clean.
  const noisy = result.tenants[0]!
  assert.equal(noisy.tenantHealth.auditEvidence.status, 'CAPPED')
  assert.equal(noisy.tenantHealth.auditEvidence.observedCount, AUDIT_EVIDENCE_TENANT_CAP)
  assert.notEqual(noisy.tenantHealth.overallStatus, 'HEALTHY')
  // Exact pairs and bound values forwarded unchanged by the service adapter.
  assert.equal(h.reads.length, 1)
  assert.deepEqual(h.reads[0]!.pairs, [[ORG, NOISY], [ORG, QUIET]])
  assert.deepEqual(h.reads[0]!.params.slice(0, 5),
    [4096, new Date(NOW.getTime() - DAY), NOW, AUDIT_EVIDENCE_SENTINEL_ROWS, 262144])
})

test('zero authorized tenants and zero returned tenants issue no audit read', async () => {
  const none = harness({ organizations: [] })
  assert.deepEqual(await list(none), { tenants: [] })
  assert.equal(none.reads.length, 0)
  assert.equal(none.writes.length, 0)
  assert.deepEqual(none.warnings, [])
  // Authorized workspace, but the tenant query returned nothing.
  const empty = harness({ tenants: [] })
  assert.deepEqual(await list(empty), { tenants: [] })
  assert.equal(empty.reads.length, 0, 'no pair means no query, not a query with an empty list')
  assert.equal(empty.writes.length, 0)
  // Nor is the reader asked for an empty batch and refused: having no tenant is
  // an ordinary outcome, not a diagnostic event.
  assert.deepEqual(empty.warnings, [], 'no audit read is attempted, so nothing is reported')
})

test('rows for a pair that was not requested cannot become another tenant’s evidence', async () => {
  const seeds = [criticalEvent({ microsoftAuditId: 'authorized' })]
  const h = harness({
    seeds,
    override: (read) => [
      // A foreign tenant inside the authorized organization, and the authorized
      // tenant under a different organization: both are unrequested pairs.
      ...project({ ...read, pairs: [[ORG, FOREIGN_TENANT]] },
        [criticalEvent({ customerTenantId: FOREIGN_TENANT, microsoftAuditId: 'foreign' })]),
      ...project({ ...read, pairs: [[ORG_OTHER, QUIET]] },
        [criticalEvent({ organizationId: ORG_OTHER, microsoftAuditId: 'crossed' })]),
    ],
  })
  const result = await list(h)
  assert.equal(result.tenants.length, 1)
  const only = result.tenants[0]!
  assert.equal(only.id, QUIET)
  assert.deepEqual(auditKeys(only), [], 'no foreign or crossed evidence is adopted')
  assert.equal(only.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(only.tenantHealth.auditEvidence.reason, 'SCOPE_MISMATCH')
  assert.notEqual(only.tenantHealth.overallStatus, 'HEALTHY')
  assert.equal(h.writes.length, 1, 'the authorized tenant is still saved, as unread')
  assert.equal(h.writes[0].payload.auditEvidence.reason, 'SCOPE_MISMATCH')
})

test('reordered storage results neither reorder nor lose authorized response tenants', async () => {
  const ids = Array.from({ length: 5 }, (_, index) => uuid('0b33', index + 1))
  const seeds = ids.map((id, index) => criticalEvent({
    customerTenantId: id, microsoftAuditId: `finding-${index}`,
  }))
  const h = harness({
    tenants: ids.map((id, index) => tenantRow(id, ORG, `tenant-${index}`)),
    seeds,
    // Deliver the projection in reverse, which the reader must not trust.
    override: (read) => project(read, seeds).reverse(),
  })
  const result = await list(h)
  assert.deepEqual(result.tenants.map(t => t.id), ids, 'response order follows the tenant query')
  for (const [index, tenant] of result.tenants.entries()) {
    assert.deepEqual(auditKeys(tenant), [`audit-ca-finding-${index}`], `tenant ${index} keeps its own evidence`)
    assert.equal(tenant.tenantHealth.auditEvidence.status, 'COMPLETE')
  }
  assert.deepEqual(h.writes.map(w => w.customerTenantId).sort(), [...ids].sort())
})

// ---------------------------------------------------------------------------
// Incomplete evidence can never become a clean response or a clean snapshot
// ---------------------------------------------------------------------------

const incompleteCases: Array<{
  name: string
  reason: string
  override?: (read: AuditRead) => unknown[] | Error
  seeds?: SeedEvent[]
}> = [
  {
    name: 'read failed',
    reason: 'READ_FAILED',
    override: () => new Error('synthetic storage failure with secret://credential inside'),
  },
  {
    name: 'malformed row',
    reason: 'ROW_VALIDATION_FAILED',
    override: (read) => project(read, [criticalEvent({ microsoftAuditId: 'malformed' })])
      .map((row: any) => ({ ...row, row_position: 'not-a-position' })),
  },
  {
    name: 'omitted projected column',
    reason: 'ROW_VALIDATION_FAILED',
    override: (read) => project(read, [criticalEvent({ microsoftAuditId: 'omitted' })])
      .map((row: any) => { const { target_resources_text: _dropped, ...rest } = row; return rest }),
  },
  {
    name: 'unrecognized withholding flag',
    reason: 'ROW_VALIDATION_FAILED',
    override: (read) => project(read, [criticalEvent({ microsoftAuditId: 'flag' })])
      .map((row: any) => ({ ...row, target_resources_withheld: 'maybe' })),
  },
  {
    name: 'oversize payload field',
    reason: 'PAYLOAD_FIELD_OVERSIZE',
    seeds: [criticalEvent({ microsoftAuditId: 'oversize', fieldOversize: true })],
  },
  {
    name: 'tenant payload budget exceeded',
    reason: 'PAYLOAD_BYTES_WITHHELD',
    seeds: [criticalEvent({ microsoftAuditId: 'budget', overBudget: true })],
  },
]

for (const { name, reason, override, seeds } of incompleteCases) {
  test(`incomplete evidence (${name}) cannot produce a clean response or a clean saved snapshot`, async () => {
    const h = harness({ seeds: seeds ?? [], override: override ? (read) => override(read) : undefined })
    const result = await list(h)
    const tenant = result.tenants[0]!
    assert.equal(tenant.tenantHealth.auditEvidence.status, 'UNREAD', name)
    assert.equal(tenant.tenantHealth.auditEvidence.reason, reason, name)
    assert.equal(tenant.tenantHealth.auditEvidence.windowComplete, false, name)
    assert.notEqual(tenant.tenantHealth.security.status, 'HEALTHY', name)
    assert.notEqual(tenant.tenantHealth.overallStatus, 'HEALTHY', name)
    // The saved snapshot carries the SAME summary the response carries.
    assert.equal(h.writes.length, 1, name)
    assert.deepEqual(h.writes[0].payload.auditEvidence, tenant.tenantHealth.auditEvidence, name)
    assert.notEqual(h.writes[0].overallStatus, 'HEALTHY', name)
    // No source error text, statement or payload reaches the API.
    const serialized = JSON.stringify(result)
    for (const forbidden of ['secret://', 'synthetic storage failure', 'SELECT', 'directory_audit_logs']) {
      assert.equal(serialized.includes(forbidden), false, `${name}: ${forbidden} must not reach the response`)
    }
  })
}

test('a withheld payload keeps the observed adverse finding while refusing a clean read', async () => {
  // Two events: one whose payload is withheld, one delivered. The delivered
  // adverse finding survives, and the window is still not complete.
  const seeds = [
    criticalEvent({ microsoftAuditId: 'delivered', eventDateTime: new Date(NOW.getTime() - 1000) }),
    event({ microsoftAuditId: 'withheld', eventDateTime: new Date(NOW.getTime() - 2000), overBudget: true }),
  ]
  const h = harness({ seeds })
  const tenant = (await list(h)).tenants[0]!
  assert.deepEqual(auditKeys(tenant), ['audit-ca-delivered'])
  assert.equal(tenant.tenantHealth.security.criticalFindings, 1)
  assert.equal(tenant.tenantHealth.security.status, 'CRITICAL', 'severity is not lowered by unknown coverage')
  assert.equal(tenant.tenantHealth.overallStatus, 'CRITICAL')
  assert.equal(tenant.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(tenant.tenantHealth.auditEvidence.reason, 'PAYLOAD_BYTES_WITHHELD')
  assert.equal(tenant.tenantHealth.auditEvidence.withheldPayloads, 1)
  assert.deepEqual(h.writes[0].payload.auditEvidence, tenant.tenantHealth.auditEvidence)
})

test('a COMPLETE empty window is clean, which is the control for every case above', async () => {
  // A tenant whose collectors are all currently successful, so the audit window
  // is the only thing that can hold security back.
  const collected = TENANT_HEALTH_RESOURCE_REGISTRY.map(resource => ({
    resourceType: resource.resourceType, status: 'SUCCEEDED',
    lastAttemptAt: NOW, lastSuccessfulAt: NOW,
    lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
  }))
  const healthy = { ...tenantRow(QUIET), syncStates: collected }
  const complete = harness({ tenants: [healthy], seeds: [] })
  const clean = (await list(complete)).tenants[0]!
  assert.equal(clean.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.equal(clean.tenantHealth.auditEvidence.reason, 'OK')
  assert.equal(clean.tenantHealth.auditEvidence.windowComplete, true)
  assert.equal(clean.tenantHealth.auditEvidence.observedCount, 0)
  assert.deepEqual(auditKeys(clean), [])
  assert.equal(clean.tenantHealth.security.status, 'HEALTHY')
  // The same fixture with an unread window: only the audit gate changed, and
  // it alone moves security off HEALTHY. This is what fails if the gate is
  // removed, and it is also the old default-empty behaviour the previous
  // contract would have reported as clean.
  const unread = harness({ tenants: [healthy], seeds: [], override: () => new Error('synthetic') })
  const gated = (await list(unread)).tenants[0]!
  assert.equal(gated.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(gated.tenantHealth.security.status, 'UNKNOWN')
  assert.notEqual(gated.tenantHealth.overallStatus, clean.tenantHealth.overallStatus)
  assert.notEqual(gated.tenantHealth.overallStatus, 'HEALTHY')
  // Nothing else about the two evaluations differs.
  assert.deepEqual(gated.tenantHealth.data, clean.tenantHealth.data)
  assert.deepEqual(gated.tenantHealth.operations, clean.tenantHealth.operations)
  assert.deepEqual(gated.tenantHealth.connection, clean.tenantHealth.connection)
})

// ---------------------------------------------------------------------------
// Mapper paths that perform no audit read
// ---------------------------------------------------------------------------

test('a reconnect return maps an explicitly unread window and reads no audit evidence', async () => {
  const h = harness({ tenants: [tenantRow(QUIET)] })
  h.prisma.customerTenant.create = async () => tenantRow(QUIET)
  const created = await h.service.createForIdentity(identity, {
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(created.requiresConsent, true)
  assert.equal(created.tenant.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(created.tenant.tenantHealth.auditEvidence.reason, 'NOT_READ')
  assert.equal(created.tenant.tenantHealth.auditEvidence.windowComplete, false)
  assert.notEqual(created.tenant.tenantHealth.overallStatus, 'HEALTHY')
  assert.equal(h.reads.length, 0, 'no second database read is added on this path')
})

test('a verification return maps an unread window without reclassifying the publication', async () => {
  const tenant = tenantRow(QUIET)
  const h = harness({ tenants: [tenant] })
  const fenceRows = (sql: string) => sql.includes('customer-fence:tenant-lock')
    ? [{ id: QUIET, organizationId: ORG, microsoftTenantId: tenant.microsoftTenantId,
        status: 'ACTIVE', revision: 'rev-tenant' }]
    : [{ id: 'connection-1', incarnation: null, mode: 'CUSTOMER_MANAGED', clientId: 'client',
        credentialReference: 'reference', permissions: [], status: 'CONNECTED', revision: 'rev-connection' }]
  let providerCalls = 0
  h.prisma.customerTenant.findFirst = async () => ({
    id: QUIET, organizationId: ORG, microsoftTenantId: tenant.microsoftTenantId,
    connection: { connectionMode: 'CUSTOMER_MANAGED', clientId: 'client',
      credentialReference: 'reference', consentedPermissions: [] },
  })
  h.prisma.$transaction = async (run: (tx: unknown) => Promise<unknown>) => run({
    $queryRawUnsafe: async (sql: string) => fenceRows(sql),
    $executeRawUnsafe: async () => 1,
  })
  const service = new TenantsService(h.prisma, {
    ...consent,
    verifyConnectedTenant: async () => {
      providerCalls += 1
      return { displayName: 'Verified tenant', primaryDomain: null,
        grantedPermissions: [], missingRequiredPermissions: [] }
    },
  } as never, {} as never)
  ;(service as any).logger = { debug() {}, warn() {} }
  const verified = await service.verifyConnectionForIdentity(identity, QUIET)
  assert.equal(verified.connected, true, 'the publication verdict is unchanged by the new mapping')
  assert.equal(verified.tenant.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(verified.tenant.tenantHealth.auditEvidence.reason, 'NOT_READ')
  assert.notEqual(verified.tenant.tenantHealth.overallStatus, 'HEALTHY')
  assert.equal(providerCalls, 1, 'exactly the pre-existing provider verification, and no more')
  assert.equal(h.reads.length, 0, 'no audit read is issued on the verification path')
})

test('every mapper call outside the tenant-list path passes no audit evidence', () => {
  // A structural control over the seven mapping calls: the compiler already
  // requires the argument, and this pins that only the list path supplies one.
  const source = readFileSync(new URL('./tenants.service.ts', import.meta.url), 'utf8')
  const calls = source.match(/this\.mapTenant\([^\n]*/g) ?? []
  assert.equal(calls.length, 8, 'six non-list calls, plus the list page and its uncovered-tenant tail')
  const unread = calls.filter(call => call.includes(', null, '))
  assert.equal(unread.length, 7, 'two verification, four reconnect, and the list tail map an unread window')
  const withEvidence = calls.filter(call => !call.includes(', null, '))
  assert.equal(withEvidence.length, 1)
  assert.match(withEvidence[0]!, /matched \? evidence :/)
  // The audit store is constructed in exactly one place.
  assert.equal((source.match(/this\.auditEvidenceStore\(\)/g) ?? []).length, 1)
})

// ---------------------------------------------------------------------------
// One captured clock
// ---------------------------------------------------------------------------

/**
 * The value the injected clock returns on its FIRST call. Every fixture below
 * is built relative to this, because the boundaries are resolved against the
 * captured assessment time and not against the moment the fixture was written.
 * A second call deliberately returns a different value, so a service that read
 * the clock twice would bind a window this test does not expect.
 */
const ASSESSED = new Date('2026-11-25T09:00:00.000Z')
const countingClock = () => {
  const state = { calls: 0 }
  return {
    state,
    now: () => {
      state.calls += 1
      return state.calls === 1 ? new Date(ASSESSED.getTime()) : new Date(ASSESSED.getTime() + 60_000)
    },
  }
}

// Each boundary is driven in its OWN harness with exactly ONE seeded event, so
// neither the three-finding budget nor the label deduplication in the finding
// derivation can hide a positive case, and every case asserts the observed
// count as well as the surfaced key. The pairs differ by ONE millisecond on
// either side of a bound, so each positive case is its own negative control.
const clockBoundaries: Array<{
  name: string
  eventOffsetMs: number
  expiresOffsetMs: number
  eligible: boolean
  why: string
}> = [
  { name: 'event exactly at the 24-hour lower bound', eventOffsetMs: -DAY, expiresOffsetMs: DAY,
    eligible: true, why: 'the event floor is inclusive' },
  { name: 'event one millisecond before the lower bound', eventOffsetMs: -DAY - 1, expiresOffsetMs: DAY,
    eligible: false, why: 'one millisecond earlier is outside the window' },
  { name: 'expiry exactly equal to the assessment time', eventOffsetMs: -500, expiresOffsetMs: 0,
    eligible: false, why: 'the expiry bound is strict' },
  { name: 'expiry one millisecond after the assessment time', eventOffsetMs: -500, expiresOffsetMs: 1,
    eligible: true, why: 'one millisecond later is still eligible' },
]

for (const boundary of clockBoundaries) {
  test(`one captured assessment time resolves the boundary: ${boundary.name}`, async () => {
    const auditId = `boundary-${boundary.eventOffsetMs}-${boundary.expiresOffsetMs}`
    const seed = criticalEvent({
      microsoftAuditId: auditId,
      eventDateTime: new Date(ASSESSED.getTime() + boundary.eventOffsetMs),
      expiresAt: new Date(ASSESSED.getTime() + boundary.expiresOffsetMs),
    })
    const clock = countingClock()
    const h = harness({ seeds: [seed] })
    const result = await h.service.listForIdentity(identity, { now: clock.now })

    // One read of the clock, and the window is bound to exactly that value.
    assert.equal(clock.state.calls, 1, 'the clock is read exactly once per request')
    assert.equal(h.reads.length, 1)
    assert.deepEqual(h.reads[0]!.params[1], new Date(ASSESSED.getTime() - DAY),
      'the inclusive event floor is the captured time minus 24 hours')
    assert.deepEqual(h.reads[0]!.params[2], new Date(ASSESSED.getTime()),
      'the strict expiry bound is the captured time itself')
    // The bound VALUES alone do not establish inclusivity or strictness: the
    // outcome below is produced by this file's storage fake, so inverting the
    // production operators would not move it. Bind the operators in the issued
    // statement itself. Execution of those operators against PostgreSQL stays
    // with the registered physical witness.
    assert.match(h.reads[0]!.sql, /event_date_time >= \$2/,
      'the event floor is INCLUSIVE in the statement the service issued')
    assert.match(h.reads[0]!.sql, /expires_at > \$3/,
      'the expiry bound is STRICT in the statement the service issued')
    assert.equal(h.reads[0]!.sql.includes('event_date_time > $2'), false,
      'a strict floor would exclude an event stored exactly at the bound')
    assert.equal(h.reads[0]!.sql.includes('expires_at >= $3'), false,
      'an inclusive expiry bound would admit an event that expired exactly now')

    // The boundary outcome, asserted positively on both sides.
    const tenant = result.tenants[0]!
    assert.equal(tenant.tenantHealth.auditEvidence.observedCount, boundary.eligible ? 1 : 0, boundary.why)
    assert.deepEqual(auditKeys(tenant), boundary.eligible ? [`audit-ca-${auditId}`] : [], boundary.why)
    // Either way the window itself was read completely: an excluded event is a
    // genuinely empty complete read, never an unread one.
    assert.equal(tenant.tenantHealth.auditEvidence.status, 'COMPLETE')
    assert.equal(tenant.tenantHealth.auditEvidence.reason, 'OK')

    // Response and saved timestamps are the same captured value.
    assert.equal(tenant.tenantHealth.evaluatedAt, ASSESSED.toISOString())
    assert.equal(tenant.tenantHealth.auditEvidence.assessedAt, ASSESSED.toISOString())
    assert.equal(h.writes.length, 1)
    assert.equal(h.writes[0].evaluatedAt.toISOString(), ASSESSED.toISOString())
    assert.equal((h.writes[0].payload as any).auditEvidence.assessedAt, ASSESSED.toISOString())
    assert.equal((h.writes[0].payload as any).evaluatedAt, ASSESSED.toISOString())
  })
}

test('the same event flips eligibility across each bound, so the bounds are the cause', async () => {
  // A direct same-fixture comparison: only the millisecond moves. The status is
  // returned alongside the count because an observed count of zero is ALSO what
  // an UNREAD page produces — without the status, a read failure would satisfy
  // every negative case here.
  const run = async (eventOffsetMs: number, expiresOffsetMs: number) => {
    const h = harness({ seeds: [criticalEvent({
      microsoftAuditId: 'flip',
      eventDateTime: new Date(ASSESSED.getTime() + eventOffsetMs),
      expiresAt: new Date(ASSESSED.getTime() + expiresOffsetMs),
    })] })
    const result = await h.service.listForIdentity(identity, { now: countingClock().now })
    const evidence = result.tenants[0]!.tenantHealth.auditEvidence
    return { observedCount: evidence.observedCount, status: evidence.status, reason: evidence.reason }
  }
  const complete = { status: 'COMPLETE', reason: 'OK' }
  assert.deepEqual(await run(-DAY, DAY), { observedCount: 1, ...complete }, 'inclusive at the floor')
  assert.deepEqual(await run(-DAY - 1, DAY), { observedCount: 0, ...complete },
    'excluded one millisecond earlier, by the window and not by a failed read')
  assert.deepEqual(await run(-500, 0), { observedCount: 0, ...complete },
    'excluded when expiry equals the assessment time, by the bound and not by a failed read')
  assert.deepEqual(await run(-500, 1), { observedCount: 1, ...complete },
    'eligible one millisecond after expiry equality')
})

test('the assessment time is not an HTTP-controlled input', async () => {
  const h = harness({ seeds: [] })
  // The controller calls the entrypoint with no internals at all.
  const result = await h.service.listForIdentity(identity)
  const assessed = new Date(result.tenants[0]!.tenantHealth.auditEvidence.assessedAt)
  assert.ok(Number.isFinite(assessed.getTime()))
  assert.equal(h.reads.length, 1)
  assert.deepEqual(h.reads[0]!.params[2], assessed, 'the window uses the internally captured time')
  // `internals` is the only way to supply a clock, and the HTTP controller does
  // not pass it: the route hands over the authenticated identity and nothing
  // from the request body, query or headers.
  const controller = readFileSync(new URL('./tenants.controller.ts', import.meta.url), 'utf8')
  const routeCalls = controller.match(/listForIdentity\([^)]*\)/g) ?? []
  assert.deepEqual(routeCalls, ['listForIdentity(request.auth)'])
})

// ---------------------------------------------------------------------------
// Bounded sequential traversal at fleet scale
// ---------------------------------------------------------------------------

test('a 1,001-tenant traversal makes exactly 63 sequential reads with page-local history work', async () => {
  const fleet = Array.from({ length: 1001 }, (_, index) =>
    tenantRow(uuid('0b44', index + 1), ORG, `tenant-${String(index).padStart(4, '0')}`))
  const h = harness({ tenants: fleet, seeds: [] })
  const result = await list(h)
  assert.equal(result.tenants.length, 1001)
  assert.deepEqual(result.tenants.map(t => t.id), fleet.map(t => t.id), 'order and every outcome preserved')
  assert.equal(h.reads.length, 63)
  assert.equal(h.reads.length, auditEvidencePageCount(1001))
  assert.equal(h.concurrency.peakReads, 1, 'one audit read in flight at a time')
  assert.equal(h.writes.length, 1001)
  // Bounded history work: never the fleet, at most one page's worth.
  assert.ok(h.concurrency.peakHistory <= AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH,
    `history concurrency ${h.concurrency.peakHistory} must stay within one page`)
  assert.ok(h.concurrency.peakHistory < fleet.length,
    'the previous unbounded fan-out over every authorized tenant is gone')
  // Each page is CONSUMED before the next is acquired: the writes between two
  // reads are exactly that page's tenants, in the order requested. This is the
  // behaviour, not a reading of the helper's own metric.
  const segments: string[][] = []
  for (const entry of h.events) {
    if (entry.startsWith('read:')) segments.push([])
    else segments[segments.length - 1]!.push(entry.slice('write:'.length))
  }
  assert.equal(segments.length, 63)
  for (const [page, written] of segments.entries()) {
    const offset = page * AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH
    const expected = fleet.slice(offset, offset + AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH).map(t => t.id)
    assert.deepEqual(written.sort(), [...expected].sort(), `page ${page} is persisted before the next read`)
    assert.deepEqual(h.reads[page]!.pairs, expected.map(id => [ORG, id]), `page ${page} requests its own pairs`)
  }
  assert.equal(segments.at(-1)!.length, 1001 % AUDIT_EVIDENCE_MAX_SCOPES_PER_BATCH)
})

test('a failure part way through a traversal preserves earlier pages and leaves the rest unread', async () => {
  const fleet = Array.from({ length: 40 }, (_, index) =>
    tenantRow(uuid('0b55', index + 1), ORG, `tenant-${String(index).padStart(4, '0')}`))
  const h = harness({
    tenants: fleet, seeds: [],
    override: (_read, index) => index === 1 ? new Error('synthetic page failure') : undefined,
  })
  const result = await list(h)
  assert.equal(result.tenants.length, 40, 'no authorized tenant is lost')
  assert.deepEqual(result.tenants.map(t => t.id), fleet.map(t => t.id))
  const statuses = result.tenants.map(t => t.tenantHealth.auditEvidence.status)
  assert.deepEqual(statuses.slice(0, 16), Array(16).fill('COMPLETE'))
  assert.deepEqual(statuses.slice(16, 32), Array(16).fill('UNREAD'), 'the failed page is unread, not complete')
  assert.deepEqual(statuses.slice(32), Array(8).fill('COMPLETE'), 'later pages still run')
  assert.deepEqual(result.tenants.slice(16, 32).map(t => t.tenantHealth.auditEvidence.reason),
    Array(16).fill('READ_FAILED'))
  assert.equal(h.writes.length, 40)
})

// ---------------------------------------------------------------------------
// History deduplication
// ---------------------------------------------------------------------------

/**
 * The polling clock must not reach the deduplication signature.
 *
 * This drives TWO real service calls a minute apart and keeps the first call's
 * own persisted timestamps, so the second evaluation genuinely carries a
 * different assessment time while every semantic term is identical. The earlier
 * version of this control ran both calls at the same injected time and only
 * backdated the previous row, so the two audit summaries' clocks were equal and
 * a signature that included the clock would have survived it.
 */
const CLOCK_FIXTURES: Array<{
  name: string
  base: Date
  later: Date
  collectors: boolean
  /** True when the two evaluations fall in different UTC hours AND dates. */
  straddlesUtcBuckets: boolean
}> = [
  // No collector state: the other clock-derived fields are null on both sides.
  { name: 'no collector state', base: NOW, later: new Date(NOW.getTime() + 60_000),
    collectors: false, straddlesUtcBuckets: false },
  // All collectors currently successful: now the freshness terms the signature
  // reads ARE computed from the clock on both sides, and they still have to
  // come out equal. Without this fixture the "nothing but the clock differs"
  // comparison would hold only by construction.
  { name: 'all collectors current', base: NOW, later: new Date(NOW.getTime() + 60_000),
    collectors: true, straddlesUtcBuckets: false },
  // A 60-second advance inside one UTC hour cannot discriminate a clock term
  // BUCKETED to the hour or the day: both renderings would compare equal and the
  // row would still be suppressed. Deduplication only applies within 15 minutes,
  // so the gap cannot simply be widened. This pair straddles midnight instead,
  // changing the UTC hour and the UTC date across a 60-second gap.
  { name: 'across a UTC hour and date boundary',
    base: new Date('2026-11-25T23:59:30.000Z'), later: new Date('2026-11-26T00:00:30.000Z'),
    collectors: false, straddlesUtcBuckets: true },
]

for (const fixture of CLOCK_FIXTURES) {
 test(`an advanced assessment clock with identical semantic evidence writes no history row (${fixture.name})`, async () => {
  const BASE = fixture.base
  const LATER = fixture.later
  // Seeds are relative to this fixture's own captured value, never to a
  // file-level constant: that mismatch is exactly what made the superseded
  // control assert nothing.
  const quietSeed = [criticalEvent({
    microsoftAuditId: 'stable-finding',
    eventDateTime: new Date(BASE.getTime() - 1000),
    expiresAt: new Date(BASE.getTime() + DAY),
  })]
  const collectorStates: SyncStateRow[] = fixture.collectors
    ? TENANT_HEALTH_RESOURCE_REGISTRY.map(resource => ({
        resourceType: resource.resourceType, status: 'SUCCEEDED',
        lastAttemptAt: BASE, lastSuccessfulAt: BASE,
        lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
      }))
    : []
  const previous = new Map<string, any>()
  const tenant = { ...tenantRow(QUIET), syncStates: collectorStates }
  const first = harness({ tenants: [tenant], seeds: quietSeed, previous })
  const initial = (await first.service.listForIdentity(identity, { now: () => new Date(BASE.getTime()) })).tenants[0]!
  assert.equal(first.writes.length, 1)
  const saved = first.writes[0]
  // The stored row keeps exactly what the first real call produced; nothing is
  // backdated, so the gap below comes from the clock actually moving.
  assert.equal(saved.evaluatedAt.toISOString(), BASE.toISOString())
  assert.equal((saved.payload as any).auditEvidence.assessedAt, BASE.toISOString())
  assert.equal((saved.payload as any).evaluatedAt, BASE.toISOString())
  previous.set(QUIET, {
    overallStatus: saved.overallStatus,
    payload: JSON.parse(JSON.stringify(saved.payload)),
    healthModelVersion: saved.healthModelVersion,
    evaluatedAt: saved.evaluatedAt,
  })

  // Second real call, one minute later: inside the 15-minute window.
  const unchanged = harness({ tenants: [tenant], seeds: quietSeed, previous })
  const polled = (await unchanged.service.listForIdentity(identity, { now: () => new Date(LATER.getTime()) })).tenants[0]!

  // The assessment clock really advanced, in the response and in both the
  // health envelope and the audit summary.
  assert.notEqual(polled.tenantHealth.auditEvidence.assessedAt, initial.tenantHealth.auditEvidence.assessedAt)
  assert.equal(initial.tenantHealth.auditEvidence.assessedAt, BASE.toISOString())
  assert.equal(polled.tenantHealth.auditEvidence.assessedAt, LATER.toISOString())
  // How COARSE a clock term this fixture can discriminate, stated rather than
  // assumed. The first two fixtures share a UTC hour and date, so they detect
  // only a term finer than the 60-second gap; the third detects an hour- or
  // day-bucketed term as well.
  const utcHour = (iso: string) => iso.slice(0, 13)
  const utcDate = (iso: string) => iso.slice(0, 10)
  const before = initial.tenantHealth.auditEvidence.assessedAt
  const after = polled.tenantHealth.auditEvidence.assessedAt
  if (fixture.straddlesUtcBuckets) {
    assert.notEqual(utcHour(after), utcHour(before), 'the two evaluations are in different UTC hours')
    assert.notEqual(utcDate(after), utcDate(before), 'and in different UTC dates')
  } else {
    assert.equal(utcHour(after), utcHour(before))
    assert.equal(utcDate(after), utcDate(before))
  }
  assert.notEqual(polled.tenantHealth.evaluatedAt, initial.tenantHealth.evaluatedAt)
  assert.equal(polled.tenantHealth.evaluatedAt, LATER.toISOString())
  assert.deepEqual(unchanged.reads[0]!.params[2], LATER, 'the later value really bound the window too')
  assert.equal(
    new Date(polled.tenantHealth.evaluatedAt).getTime() - saved.evaluatedAt.getTime(),
    60_000, 'the two evaluations are a minute apart, well inside the dedupe window')

  // Every semantic term is equal: status, findings, audit coverage, model
  // version, freshness and the derived sections the signature is built from.
  assert.equal(polled.tenantHealth.overallStatus, initial.tenantHealth.overallStatus)
  assert.deepEqual(auditKeys(polled), auditKeys(initial))
  assert.deepEqual(polled.tenantHealth.attention, initial.tenantHealth.attention)
  assert.equal(polled.tenantHealth.auditEvidence.status, initial.tenantHealth.auditEvidence.status)
  assert.equal(polled.tenantHealth.auditEvidence.reason, initial.tenantHealth.auditEvidence.reason)
  assert.equal(polled.tenantHealth.auditEvidence.windowComplete, initial.tenantHealth.auditEvidence.windowComplete)
  assert.equal(polled.tenantHealth.healthModelVersion, initial.tenantHealth.healthModelVersion)
  assert.deepEqual(polled.syncFreshness, initial.syncFreshness)
  assert.deepEqual(polled.tenantHealth.data, initial.tenantHealth.data)
  assert.deepEqual(polled.tenantHealth.security, initial.tenantHealth.security)
  // The ONLY difference between the two evaluations is the clock.
  const withoutClock = (value: any) => {
    const copy = JSON.parse(JSON.stringify(value))
    delete copy.evaluatedAt
    delete copy.auditEvidence.assessedAt
    return copy
  }
  assert.deepEqual(withoutClock(polled.tenantHealth), withoutClock(initial.tenantHealth),
    'nothing but the assessment clock differs')
  // The terms the deduplication signature ACTUALLY consumes, compared directly.
  // `tenantHealth.data.freshnessStatus` is a DIFFERENT derivation — tenant-health
  // computes it over the health resource registry, while the signature reads
  // `syncFreshness.services` from the service registry — so asserting the former
  // would not establish anything about the latter.
  const signatureFreshnessTerms = (row: typeof initial) =>
    Object.values(row.syncFreshness.services).map(service => ({
      service: service.service, status: service.status,
      freshness: service.freshnessStatus,
      failures: service.partialFailures.map(failure => failure.collector),
    }))
  assert.deepEqual(signatureFreshnessTerms(polled), signatureFreshnessTerms(initial),
    'every freshness term the signature reads is equal across the minute')

  if (fixture.collectors) {
    // Measured THROUGH THE SERVICE, not from a direct call to the freshness
    // helper: the service also passes the readiness exclusions, which changes
    // the answer. With all 21 health-registry collectors successful at the
    // captured time, FIVE of the six service terms come from the clock-dependent
    // branch of deriveTenantSyncFreshness — two CURRENT and three STALE, the
    // STALE ones because those services also expect collectors this fixture
    // seeds no state for, which is an absent-state effect and not a clock one.
    // The sixth, SIGN_IN_LOGS, is pinned UNKNOWN because this fixture carries no
    // license evidence, so its source is excluded before the clock is consulted.
    const terms = signatureFreshnessTerms(initial)
    assert.equal(terms.length, 6)
    const clockDerived = terms.filter(term => ['CURRENT', 'AGING', 'STALE'].includes(term.freshness))
    assert.equal(clockDerived.length, 5, 'five of the six terms are computed from the clock')
    assert.equal(terms.filter(term => term.freshness === 'CURRENT').length, 2)
    assert.equal(terms.filter(term => term.freshness === 'STALE').length, 3)
    assert.deepEqual(terms.filter(term => term.freshness === 'UNKNOWN').map(term => term.service),
      ['SIGN_IN_LOGS'], 'exactly one term is pinned, and it is the unlicensed sign-in source')
    assert.equal(initial.tenantHealth.data.status, 'COMPLETE')
    assert.equal(polled.tenantHealth.data.status, 'COMPLETE')
    // CRITICAL, not HEALTHY: the seeded conditional-access removal is a real
    // critical finding. What matters here is that the whole model ran over
    // clock-classified collectors and reached the SAME verdict a minute later.
    assert.equal(initial.tenantHealth.overallStatus, 'CRITICAL')
    assert.equal(polled.tenantHealth.overallStatus, 'CRITICAL')
    assert.deepEqual(polled.tenantHealth.resourceHealth, initial.tenantHealth.resourceHealth)
  }

  // Therefore no row is written. Adding the clock to the signature at full
  // precision makes exactly this assertion fail; an external negative control
  // run records that, for two different ways of adding it, and records that the
  // superseded version of this control did NOT fail. The coarseness this
  // fixture can detect is bounded above by the gap asserted on the UTC buckets
  // above, which is why the straddling fixture exists.
  assert.equal(unchanged.writes.length, 0, 'an advanced clock alone does not force a row per poll')
  // The suppression comes from the deduplication return, not from a swallowed
  // exception: persistTenantHealthSnapshot wraps its whole body in try/catch and
  // logs a warning on failure, so an empty warning log rules that out.
  assert.deepEqual(unchanged.warnings, [], 'nothing was caught and swallowed inside the writer')
  // And it is not an absent previous row or a different early return either: a
  // changed finding at the same clock still writes.
  const changedFinding = harness({
    tenants: [tenant], previous,
    seeds: [criticalEvent({
      microsoftAuditId: 'a-moved-finding',
      eventDateTime: new Date(BASE.getTime() - 1000),
      expiresAt: new Date(BASE.getTime() + DAY),
    })],
  })
  await changedFinding.service.listForIdentity(identity, { now: () => new Date(LATER.getTime()) })
  assert.equal(changedFinding.writes.length, 1,
    'the same previous row and the same clock still writes when the evidence moves')
  assert.deepEqual(changedFinding.warnings, [])
 })
}

test('history deduplication keeps completeness and finding changes', async () => {
  const quietSeed = [criticalEvent({ microsoftAuditId: 'stable-finding' })]
  const previous = new Map<string, any>()
  const first = harness({ seeds: quietSeed, previous })
  const initial = (await list(first)).tenants[0]!
  assert.equal(first.writes.length, 1)
  const saved = first.writes[0]
  const asPrevious = (data: any, offsetMs = -60_000) => ({
    overallStatus: data.overallStatus,
    payload: JSON.parse(JSON.stringify(data.payload)),
    healthModelVersion: data.healthModelVersion,
    evaluatedAt: new Date(NOW.getTime() + offsetMs),
  })
  previous.set(QUIET, asPrevious(saved))

  // Completeness alone changing is retained, and the change is ISOLATED.
  //
  // The superseded version of this case withheld the ADVERSE event's own
  // payload, which emptied its target resources, deleted the finding and flipped
  // the overall status — so the row was written for those reasons and the
  // completeness term was never what carried it. Here the adverse event stays
  // delivered and a SECOND, non-adverse event goes over the tenant payload
  // budget, which makes the tenant's window UNREAD without touching anything
  // that was observed.
  const inert = event({
    microsoftAuditId: 'inert-group-change',
    activityDisplayName: 'Update group', category: 'GroupManagement',
    eventDateTime: new Date(NOW.getTime() - 2000),
  })
  const pairSeeds = [quietSeed[0]!, inert]
  const pairBaseline = harness({ seeds: pairSeeds })
  const baselineTenant = (await list(pairBaseline)).tenants[0]!
  assert.equal(baselineTenant.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.equal(baselineTenant.tenantHealth.auditEvidence.observedCount, 2)
  assert.deepEqual(auditKeys(baselineTenant), ['audit-ca-stable-finding'],
    'the second event contributes no finding, so the finding set can stay fixed')
  const pairPrevious = new Map<string, any>([[QUIET, {
    overallStatus: pairBaseline.writes[0].overallStatus,
    payload: JSON.parse(JSON.stringify(pairBaseline.writes[0].payload)),
    healthModelVersion: pairBaseline.writes[0].healthModelVersion,
    evaluatedAt: pairBaseline.writes[0].evaluatedAt,
  }]])
  const completenessChanged = harness({
    seeds: [quietSeed[0]!, { ...inert, overBudget: true }], previous: pairPrevious,
  })
  const withheld = (await list(completenessChanged)).tenants[0]!
  assert.equal(withheld.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(withheld.tenantHealth.auditEvidence.reason, 'PAYLOAD_BYTES_WITHHELD')
  // Nothing else moved: the same finding at the same severity, the same overall
  // status, and the same freshness terms the signature reads.
  assert.deepEqual(auditKeys(withheld), auditKeys(baselineTenant))
  // The findings are identical. The attention LISTS now differ by exactly the
  // audit-coverage limitation, which the incomplete read is supposed to add.
  const withoutLimitation = (row: typeof withheld) =>
    row.tenantHealth.attention.filter(item => item.key !== 'evidence-audit-window')
  assert.deepEqual(withoutLimitation(withheld), withoutLimitation(baselineTenant))
  assert.deepEqual(baselineTenant.tenantHealth.attention.map(item => item.key)
    .filter(key => key === 'evidence-audit-window'), [], 'a complete read emits none')
  assert.deepEqual(withheld.tenantHealth.attention.map(item => item.key)
    .filter(key => key === 'evidence-audit-window'), ['evidence-audit-window'], 'an incomplete read emits exactly one')
  assert.equal(withheld.tenantHealth.overallStatus, baselineTenant.tenantHealth.overallStatus)
  assert.equal(withheld.tenantHealth.security.criticalFindings,
    baselineTenant.tenantHealth.security.criticalFindings)
  assert.deepEqual(withheld.syncFreshness, baselineTenant.syncFreshness)
  assert.equal(withheld.tenantHealth.healthModelVersion, baselineTenant.tenantHealth.healthModelVersion)
  assert.equal(completenessChanged.writes.length, 1,
    'a changed audit completeness ALONE is never suppressed')
  assert.deepEqual(completenessChanged.warnings, [])

  // A different observed finding at the same overall status and freshness is
  // retained: the identity of what was seen is part of the signature.
  const differentFinding = harness({
    seeds: [criticalEvent({ microsoftAuditId: 'a-different-finding' })], previous,
  })
  const changed = (await list(differentFinding)).tenants[0]!
  assert.equal(changed.tenantHealth.overallStatus, initial.tenantHealth.overallStatus)
  assert.deepEqual(auditKeys(changed), ['audit-ca-a-different-finding'])
  assert.equal(differentFinding.writes.length, 1, 'a changed finding identity is never suppressed')

  // A realistic legacy row — an older model version, no audit metadata and no
  // attention array — is always superseded. This case deliberately moves THREE
  // signature terms at once, so it shows only that such a row never suppresses
  // the first evaluation under the new model; the ISOLATED claim that absent
  // audit metadata alone is not a complete read is proved separately by
  // 'a saved row whose audit metadata is absent is never read as a complete
  // window'.
  const legacyPayload = JSON.parse(JSON.stringify(saved.payload))
  delete legacyPayload.auditEvidence
  delete legacyPayload.attention
  previous.set(QUIET, { overallStatus: saved.overallStatus, payload: legacyPayload,
    healthModelVersion: 2, evaluatedAt: new Date(NOW.getTime() - 60_000) })
  const legacy = harness({ seeds: quietSeed, previous })
  await list(legacy)
  assert.equal(legacy.writes.length, 1, 'a legacy row is always superseded by the new model')
  assert.equal(legacy.writes[0].healthModelVersion, TENANT_HEALTH_MODEL_VERSION)

  // A model-version change alone is retained even with identical labels.
  const samePayloadNewVersion = JSON.parse(JSON.stringify(saved.payload))
  samePayloadNewVersion.healthModelVersion = TENANT_HEALTH_MODEL_VERSION - 1
  previous.set(QUIET, { overallStatus: saved.overallStatus, payload: samePayloadNewVersion,
    healthModelVersion: TENANT_HEALTH_MODEL_VERSION - 1, evaluatedAt: new Date(NOW.getTime() - 60_000) })
  const versioned = harness({ seeds: quietSeed, previous })
  await list(versioned)
  assert.equal(versioned.writes.length, 1, 'a model-version change is not suppressed by unchanged labels')
})

test('audit completeness alone, with every other term identical, is retained in history', async () => {
  // A tenant with NO events and no findings: the only thing that differs
  // between the two evaluations is whether the window was read. Overall status,
  // freshness, findings and the model version are byte-identical, so this
  // isolates the audit term of the deduplication signature.
  const previous = new Map<string, any>()
  const complete = harness({ seeds: [], previous })
  const clean = (await list(complete)).tenants[0]!
  assert.equal(complete.writes.length, 1)
  const saved = complete.writes[0]
  assert.equal(clean.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.deepEqual(auditKeys(clean), [])
  previous.set(QUIET, {
    overallStatus: saved.overallStatus,
    payload: JSON.parse(JSON.stringify(saved.payload)),
    healthModelVersion: saved.healthModelVersion,
    evaluatedAt: new Date(NOW.getTime() - 60_000),
  })
  const failed = harness({ seeds: [], previous, override: () => new Error('synthetic') })
  const unread = (await list(failed)).tenants[0]!
  assert.equal(unread.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(unread.tenantHealth.overallStatus, clean.tenantHealth.overallStatus,
    'the overall status is unchanged, so only completeness can carry this row')
  assert.deepEqual(auditKeys(unread), [], 'the finding set is unchanged too')
  assert.deepEqual(unread.tenantHealth.data, clean.tenantHealth.data)
  assert.equal(failed.writes.length, 1, 'a completeness-only change is never suppressed')
})

test('a saved row whose audit metadata is absent is never read as a complete window', async () => {
  // The legacy payload differs from the current evaluation ONLY by lacking the
  // audit summary: same status, same findings, same freshness, and the same
  // model version, so absence itself has to carry the row.
  const previous = new Map<string, any>()
  const seeded = harness({ seeds: [], previous })
  await list(seeded)
  const saved = seeded.writes[0]
  const legacyPayload = JSON.parse(JSON.stringify(saved.payload))
  delete legacyPayload.auditEvidence
  previous.set(QUIET, {
    overallStatus: saved.overallStatus,
    payload: legacyPayload,
    healthModelVersion: saved.healthModelVersion,
    evaluatedAt: new Date(NOW.getTime() - 60_000),
  })
  const current = harness({ seeds: [], previous })
  await list(current)
  assert.equal(current.writes.length, 1,
    'missing audit metadata is not equivalent to a complete read')
})

test('an isolated service-freshness transition inside the dedupe window retains a history row', async () => {
  // The converse of the unchanged-poll controls above: when the only thing that
  // moves between two polls is a service freshness term, the row must be kept.
  //
  // SHAREPOINT_SETTINGS is chosen deliberately, against the registries rather
  // than by name. It is OPTIONAL in TENANT_HEALTH_RESOURCE_REGISTRY, so crossing
  // its freshness boundary adds no attention item and cannot move the finding
  // term; and SERVICE_COLLECTOR_REGISTRY puts it in SHAREPOINT_ONEDRIVE, whose
  // three collectors this fixture all seeds, so that service reads CURRENT
  // rather than being pinned STALE by a collector with no state at all.
  // SECURE_SCORES would NOT work here: the service registry owns it under
  // ENTRA_ID, which this fixture already reports STALE for exactly that
  // absent-collector reason, so aging it would change no term.
  const DAILY_CURRENT_MS = 24 * 60 * 60 * 1000
  const BASE = NOW
  const LATER = new Date(BASE.getTime() + 60_000)
  const AGING_COLLECTOR = 'SHAREPOINT_SETTINGS'
  // One millisecond inside the current window at BASE, so 60 seconds later it
  // is outside it — and still well inside the 26-hour aging bound, which keeps
  // its own classification SUCCESS and its resourceHealth row identical.
  const states: SyncStateRow[] = TENANT_HEALTH_RESOURCE_REGISTRY.map(resource => ({
    resourceType: resource.resourceType, status: 'SUCCEEDED',
    lastAttemptAt: BASE,
    lastSuccessfulAt: resource.resourceType === AGING_COLLECTOR
      ? new Date(BASE.getTime() - (DAILY_CURRENT_MS - 1))
      : BASE,
    lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
  }))
  const seeds = [criticalEvent({
    microsoftAuditId: 'freshness-holds-status',
    eventDateTime: new Date(BASE.getTime() - 1000),
    expiresAt: new Date(BASE.getTime() + DAY),
  })]
  const tenant = { ...tenantRow(QUIET), syncStates: states }
  const previous = new Map<string, any>()

  const first = harness({ tenants: [tenant], seeds, previous })
  const initial = (await first.service.listForIdentity(identity, { now: () => new Date(BASE.getTime()) })).tenants[0]!
  assert.equal(first.writes.length, 1)
  const saved = first.writes[0]
  // The stored row keeps exactly what the first real call produced.
  assert.equal(saved.evaluatedAt.toISOString(), BASE.toISOString())
  assert.equal((saved.payload as any).evaluatedAt, BASE.toISOString())
  assert.equal((saved.payload as any).auditEvidence.assessedAt, BASE.toISOString())
  previous.set(QUIET, {
    overallStatus: saved.overallStatus,
    payload: JSON.parse(JSON.stringify(saved.payload)),
    healthModelVersion: saved.healthModelVersion,
    evaluatedAt: saved.evaluatedAt,
  })

  const second = harness({ tenants: [tenant], seeds, previous })
  const polled = (await second.service.listForIdentity(identity, { now: () => new Date(LATER.getTime()) })).tenants[0]!
  assert.equal(
    new Date(polled.tenantHealth.evaluatedAt).getTime() - saved.evaluatedAt.getTime(),
    60_000, 'the two evaluations are a minute apart, inside the 15-minute dedupe window')

  // Every OTHER term the signature reads is unchanged.
  assert.equal(polled.tenantHealth.overallStatus, initial.tenantHealth.overallStatus)
  assert.equal(polled.tenantHealth.overallStatus, 'CRITICAL',
    'the observed critical finding holds the overall status constant across the transition')
  assert.equal(polled.tenantHealth.healthModelVersion, initial.tenantHealth.healthModelVersion)
  assert.equal(polled.tenantHealth.auditEvidence.status, initial.tenantHealth.auditEvidence.status)
  assert.equal(polled.tenantHealth.auditEvidence.reason, initial.tenantHealth.auditEvidence.reason)
  assert.equal(polled.tenantHealth.auditEvidence.windowComplete, initial.tenantHealth.auditEvidence.windowComplete)
  assert.deepEqual(auditKeys(polled), auditKeys(initial))
  assert.deepEqual(
    polled.tenantHealth.attention.map(item => [item.key, item.severity]),
    initial.tenantHealth.attention.map(item => [item.key, item.severity]),
    'no finding identity or severity moved, so the finding term of the signature is fixed')

  // The ONE term that changed, named exactly.
  const sharePoint = (row: typeof initial) => row.syncFreshness.services.sharePointOneDrive
  assert.equal(sharePoint(initial).service, 'SHAREPOINT_ONEDRIVE')
  assert.equal(sharePoint(initial).freshnessStatus, 'CURRENT')
  assert.equal(sharePoint(polled).freshnessStatus, 'AGING')
  assert.equal(sharePoint(polled).status, sharePoint(initial).status,
    'the service status is unchanged; only its freshness crossed the bound')
  const otherServices = (row: typeof initial) => Object.values(row.syncFreshness.services)
    .filter(service => service.service !== 'SHAREPOINT_ONEDRIVE')
    .map(service => ({
      service: service.service, status: service.status, freshness: service.freshnessStatus,
      failures: service.partialFailures.map(failure => failure.collector),
    }))
  assert.deepEqual(otherServices(polled), otherServices(initial),
    'exactly one of the six service terms changed')
  // The aging collector's own health row is identical, which is why no finding
  // and no status could have carried this write.
  const row = (value: typeof initial) =>
    value.tenantHealth.resourceHealth.find(item => item.resourceType === AGING_COLLECTOR)
  assert.equal(row(initial)?.classification, 'SUCCESS')
  assert.deepEqual(row(polled), row(initial))

  // Therefore the row is retained, and the saved payload carries the change.
  assert.equal(second.writes.length, 1,
    'a service-freshness transition alone retains a history row')
  assert.deepEqual(second.warnings, [], 'nothing was caught and swallowed inside the writer')
  const savedPayload = second.writes[0].payload as any
  assert.equal(savedPayload.syncFreshness.services.sharePointOneDrive.freshnessStatus, 'AGING')
  assert.equal(savedPayload.evaluatedAt, LATER.toISOString())
  assert.equal(second.writes[0].evaluatedAt.toISOString(), LATER.toISOString())
})

test('a persistence failure fails neither the list nor the tenants after it', async () => {
  const fleet = Array.from({ length: 3 }, (_, index) =>
    tenantRow(uuid('0b66', index + 1), ORG, `tenant-${index}`))
  const h = harness({
    tenants: fleet, seeds: [],
    onCreate: (data) => {
      if (data.customerTenantId === fleet[0]!.id) {
        throw new Error('synthetic persistence failure carrying secret://value')
      }
    },
  })
  const result = await list(h)
  assert.deepEqual(result.tenants.map(t => t.id), fleet.map(t => t.id), 'the list stays available')
  assert.deepEqual(h.writes.map(w => w.customerTenantId), fleet.slice(1).map(t => t.id),
    'later tenants are still persisted')
  assert.equal(h.warnings.length, 1)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('secret://value'), false)
  assert.equal(serialized.includes('synthetic persistence failure'), false)
})

test('the saved payload carries the audit-coverage limitation, and unchanged coverage still deduplicates', async () => {
  // Reuses the qualified harness and the qualified unchanged-poll shape; the new
  // assertions are the limitation in the ACTUAL persisted payload and the
  // dedupe behaviour while that limitation is present.
  const previous = new Map<string, any>()
  const unreadStore = { override: () => new Error('synthetic read failure') }
  const first = harness({ seeds: [], previous, ...unreadStore })
  const initial = (await first.service.listForIdentity(identity, { now: () => new Date(NOW.getTime()) })).tenants[0]!
  assert.equal(initial.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.equal(first.writes.length, 1)
  const saved = first.writes[0]
  const savedPayload = saved.payload as any

  // The saved payload carries BOTH the coverage summary and the limitation.
  assert.equal(savedPayload.auditEvidence.status, 'UNREAD')
  assert.equal(savedPayload.auditEvidence.reason, 'READ_FAILED')
  assert.equal(savedPayload.auditEvidence.windowComplete, false)
  const savedLimitations = (savedPayload.attention as Array<{ key: string; provenance: unknown }>)
    .filter(item => item.key === 'evidence-audit-window')
  assert.equal(savedLimitations.length, 1, 'exactly one limitation is persisted')
  assert.deepEqual(savedLimitations[0]!.provenance,
    { version: 1, origin: 'EVIDENCE_LIMITATION', kind: 'INCOMPLETE_AUDIT_EVIDENCE', remediationOwner: 'UNDETERMINED' })

  previous.set(QUIET, {
    overallStatus: saved.overallStatus,
    payload: JSON.parse(JSON.stringify(savedPayload)),
    healthModelVersion: saved.healthModelVersion,
    evaluatedAt: saved.evaluatedAt,
  })

  // Same coverage and findings a minute later: no redundant row.
  const LATER = new Date(NOW.getTime() + 60_000)
  const unchanged = harness({ seeds: [], previous, ...unreadStore })
  const polled = (await unchanged.service.listForIdentity(identity, { now: () => new Date(LATER.getTime()) })).tenants[0]!
  assert.equal(polled.tenantHealth.auditEvidence.status, 'UNREAD')
  assert.deepEqual(
    polled.tenantHealth.attention.map(item => [item.key, item.severity]),
    initial.tenantHealth.attention.map(item => [item.key, item.severity]),
    'the limitation identity is stable across the clock')
  assert.equal(unchanged.writes.length, 0, 'unchanged coverage with the limitation present still deduplicates')
  assert.deepEqual(unchanged.warnings, [])

  // A coverage transition back to complete is retained, and drops the item.
  const recovered = harness({ seeds: [], previous })
  const complete = (await recovered.service.listForIdentity(identity, { now: () => new Date(LATER.getTime()) })).tenants[0]!
  assert.equal(complete.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.deepEqual(complete.tenantHealth.attention.filter(item => item.key === 'evidence-audit-window'), [])
  assert.equal(recovered.writes.length, 1, 'a coverage transition is never suppressed')
  assert.deepEqual((recovered.writes[0].payload as any).attention
    .filter((item: { key: string }) => item.key === 'evidence-audit-window'), [])
})

test('the saved payload adds only the bounded audit summary to the existing projection', async () => {
  const h = harness({ seeds: [criticalEvent({ microsoftAuditId: 'saved-shape' })] })
  const tenant = (await list(h)).tenants[0]!
  const payload = h.writes[0].payload
  assert.deepEqual(payload.auditEvidence, tenant.tenantHealth.auditEvidence)
  assert.deepEqual(Object.keys(payload.auditEvidence).sort(),
    ['assessedAt', 'observedCount', 'reason', 'status', 'windowComplete', 'withheldPayloads'])
  assert.equal(h.writes[0].healthModelVersion, TENANT_HEALTH_MODEL_VERSION)
  // Every field the previous saved projection carried is still carried.
  for (const field of ['healthModelVersion', 'overallStatus', 'connection', 'data', 'security',
    'operations', 'resourceHealth', 'evaluatedAt', 'legacyHealthStatus', 'healthScore', 'mfaCoverage',
    'riskyIdentityCount', 'microsoftRiskSummary', 'attention', 'syncFreshness']) {
    assert.ok(field in payload, `the saved payload must preserve ${field}`)
  }
})
