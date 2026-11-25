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

test('one internal assessment time drives the window, the expiry edge and every derived field', async () => {
  // The event floor is inclusive and the expiry bound is strict, both against
  // the SAME captured value.
  const seeds = [
    criticalEvent({ microsoftAuditId: 'at-window-edge', eventDateTime: new Date(NOW.getTime() - DAY) }),
    criticalEvent({ microsoftAuditId: 'outside-window', eventDateTime: new Date(NOW.getTime() - DAY - 1) }),
    criticalEvent({ microsoftAuditId: 'expiry-equal', eventDateTime: new Date(NOW.getTime() - 500), expiresAt: NOW }),
  ]
  let clockCalls = 0
  const h = harness({ seeds })
  const result = await h.service.listForIdentity(identity, {
    now: () => { clockCalls += 1; return new Date(NOW.getTime() + clockCalls * 60_000) },
  })
  assert.equal(clockCalls, 1, 'the clock is read exactly once per request')
  const expected = new Date(NOW.getTime() + 60_000)
  const tenant = result.tenants[0]!
  assert.deepEqual(h.reads[0]!.params[1], new Date(expected.getTime() - DAY))
  assert.deepEqual(h.reads[0]!.params[2], expected)
  assert.equal(tenant.tenantHealth.evaluatedAt, expected.toISOString())
  assert.equal(tenant.tenantHealth.auditEvidence.assessedAt, expected.toISOString())
  assert.equal(h.writes[0].evaluatedAt.toISOString(), expected.toISOString())
  // Window and expiry edges resolved against that one value.
  const keys = auditKeys(tenant)
  assert.equal(keys.includes('audit-ca-outside-window'), false, 'before the inclusive event floor')
  assert.equal(keys.includes('audit-ca-expiry-equal'), false, 'expiry equal to the assessment time is not eligible')
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

test('history deduplication keeps completeness and finding changes while suppressing unchanged polls', async () => {
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

  // An unchanged evaluation inside the window writes nothing, even though the
  // assessment time advanced.
  previous.set(QUIET, asPrevious(saved))
  const unchanged = harness({ seeds: quietSeed, previous })
  await list(unchanged)
  assert.equal(unchanged.writes.length, 0, 'an unchanged semantic summary does not force a row per poll')

  // Completeness alone changing is retained.
  const completenessChanged = harness({
    seeds: quietSeed, previous,
    override: (read) => project(read, quietSeed).map((row: any) => ({ ...row, over_payload_budget: true,
      initiated_by_withheld: true, target_resources_withheld: true,
      initiated_by_text: null, target_resources_text: null })),
  })
  const withheld = (await list(completenessChanged)).tenants[0]!
  assert.equal(completenessChanged.writes.length, 1, 'a changed audit completeness is never suppressed')
  assert.equal(withheld.tenantHealth.auditEvidence.reason, 'PAYLOAD_BYTES_WITHHELD')

  // A different observed finding at the same overall status and freshness is
  // retained: the identity of what was seen is part of the signature.
  const differentFinding = harness({
    seeds: [criticalEvent({ microsoftAuditId: 'a-different-finding' })], previous,
  })
  const changed = (await list(differentFinding)).tenants[0]!
  assert.equal(changed.tenantHealth.overallStatus, initial.tenantHealth.overallStatus)
  assert.deepEqual(auditKeys(changed), ['audit-ca-a-different-finding'])
  assert.equal(differentFinding.writes.length, 1, 'a changed finding identity is never suppressed')

  // A legacy row with no audit metadata is not a complete read, so the first
  // evaluation under the new model is always retained.
  const legacyPayload = JSON.parse(JSON.stringify(saved.payload))
  delete legacyPayload.auditEvidence
  delete legacyPayload.attention
  previous.set(QUIET, { overallStatus: saved.overallStatus, payload: legacyPayload,
    healthModelVersion: 2, evaluatedAt: new Date(NOW.getTime() - 60_000) })
  const legacy = harness({ seeds: quietSeed, previous })
  await list(legacy)
  assert.equal(legacy.writes.length, 1, 'missing legacy metadata is not treated as a complete audit read')
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
