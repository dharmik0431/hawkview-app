import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES,
  AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES,
  AUDIT_EVIDENCE_SENTINEL_ROWS,
  AUDIT_EVIDENCE_TENANT_CAP,
} from './tenant-health-audit-evidence.js'
import { TenantsService } from './tenants.service.js'

/**
 * Tenant-list audit evidence: saved-expiry boundary, event window, exact
 * scoping, presentation and the saved snapshot — now read through the
 * tenant-scoped reader instead of the former workspace-wide `take: 500`.
 *
 * The storage fake below behaves like an ADAPTER: it honours the bound
 * parameters the service forwards and returns the projection's columns. It is
 * not a second implementation of the statement's semantics as evidence that the
 * statement is correct — actual SQL ranking, byte accounting and driver row
 * shapes are the registered physical witness's job
 * (`tenant-health-audit-evidence.database-integration.test.ts`). What is under
 * test here is the service wiring: which pairs are requested, with which bound
 * values, and how each outcome reaches the response and the saved snapshot.
 */

const NOW = new Date('2026-10-12T01:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const date = (offset: number) => new Date(NOW.getTime() + offset)
const identity = { subject: 'list-owner' } as never
const consent = {
  getRequiredPermissions: () => [],
  getAccessContract: () => ({ connectionRequiredPermissions: [], capabilities: [] }),
}

// The reader validates that every scope is a pair of UUIDs before it touches
// storage: authorization rests on the exact pair, so a short label is refused.
const uuid = (slot: number, kind: 'org' | 'tenant') =>
  `${kind === 'org' ? '0a' : '0b'}000000-0000-4000-8000-${String(slot).padStart(12, '0')}`
const ORG_A = uuid(1, 'org')
const ORG_B = uuid(2, 'org')
const ORG_FOREIGN = uuid(3, 'org')
const TENANT_A = uuid(1, 'tenant')
const TENANT_B = uuid(2, 'tenant')
const TENANT_FOREIGN = uuid(3, 'tenant')
const TENANT_UNSELECTED = uuid(4, 'tenant')

// Defensive stored states, not production observations. With correctly ordered
// event <= ingestion and six-month ingestion expiry, an expired row cannot be
// in the recent24h window. These deliberately pin the independent saved field.
function audit(
  id: string, expiry: number, event = -1000,
  tenant = TENANT_A, org = ORG_A,
) {
  return {
    customerTenantId: tenant, organizationId: org, microsoftAuditId: id,
    eventDateTime: date(event), expiresAt: date(expiry), ingestedAt: date(-2000),
    activityDisplayName: 'Update authentication method', category: 'UserManagement',
    operationType: 'Update', result: 'success',
    initiatedBy: { user: { userPrincipalName: '[REDACTED]' } },
    targetResources: [{ type: 'authenticationMethod', displayName: id }],
  }
}
type Audit = ReturnType<typeof audit>

function tenantRow(id: string, org = ORG_A, name = id) {
  return {
    id, microsoftTenantId: `microsoft-${id}`, displayName: name, primaryDomain: null,
    status: 'ACTIVE', organization: { id: org, name: org, slug: org },
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      consentedPermissions: [], lastVerifiedAt: NOW, lastErrorCode: null },
    tenantLicenses: [], syncStates: [], entraSnapshots: [],
    collectionFieldStates: [], m365ActivitySubscriptions: [],
  }
}

type AuditRead = { sql: string; params: unknown[]; pairs: Array<[string, string]> }

/** The five fixed leading parameters, then one `(org, tenant)` pair per scope. */
function decodeRead(sql: string, params: unknown[]): AuditRead {
  const pairs: Array<[string, string]> = []
  for (let index = 5; index < params.length; index += 2) {
    pairs.push([String(params[index]), String(params[index + 1])])
  }
  return { sql, params, pairs }
}

type StoreBehaviour = {
  /** Replace the adapter's whole result for a read, by read index. */
  override?: (read: AuditRead, index: number) => unknown[] | Error | undefined
}

function fixture(
  rows: Audit[],
  options: {
    account?: string
    tenants?: ReturnType<typeof tenantRow>[]
    organizations?: string[]
  } & StoreBehaviour = {},
) {
  const writes: any[] = []
  const previous = new Map<string, any>()
  const reads: AuditRead[] = []
  const events: string[] = []
  const tenants = options.tenants ?? [tenantRow(TENANT_A, ORG_A, 'a')]
  const prisma: any = {
    user: { findUnique: async ({ where, select }: any) => {
      assert.equal(where.authProviderUserId, 'list-owner')
      assert.deepEqual(select.memberships.where, { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
      return options.account === 'missing' ? null : {
        disabledAt: options.account === 'disabled' ? NOW : null,
        memberships: options.account === 'nonmember' ? [] :
          (options.organizations ?? [ORG_A]).map(organizationId => ({ organizationId })),
      }
    } },
    customerTenant: { findMany: async ({ where, orderBy }: any) => {
      assert.deepEqual(orderBy, [{ displayName: 'asc' }, { microsoftTenantId: 'asc' }])
      return tenants.filter(t => where.organizationId.in.includes(t.organization.id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    } },
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const read = decodeRead(sql, params)
      const index = reads.length
      reads.push(read)
      events.push(`read:${index}`)
      const replacement = options.override?.(read, index)
      if (replacement instanceof Error) throw replacement
      if (replacement) return replacement
      return adapterRows(read, rows)
    },
    tenantHealthSnapshot: {
      findFirst: async ({ where }: any) => previous.get(where.customerTenantId) ?? null,
      create: async ({ data }: any) => {
        events.push(`write:${data.customerTenantId}`)
        writes.push(data)
        return data
      },
    },
  }
  const service = new TenantsService(prisma, consent as never, {} as never)
  ;(service as any).logger = { debug() {}, warn() {} }
  return { service, writes, previous, reads, events, rows }
}

/**
 * Adapter behaviour for the bound statement: exact-pair match, the inclusive
 * event floor, the strict expiry bound, the per-tenant deterministic order, the
 * sentinel row and the projected byte flags. Payload bytes are measured as the
 * serialized JSON's UTF-8 length, which is a proxy: PostgreSQL's own
 * `octet_length(jsonb::text)` is what the physical witness establishes.
 */
function adapterRows(read: AuditRead, rows: Audit[]) {
  const [fieldBytes, eventFloor, asOf, sentinelRows, tenantBytes] = read.params as
    [number, Date, Date, number, number]
  const requested = new Set(read.pairs.map(([org, tenant]) => `${org}\u0000${tenant}`))
  const matching = rows.filter(row =>
    requested.has(`${row.organizationId}\u0000${row.customerTenantId}`) &&
    row.eventDateTime >= eventFloor &&
    row.expiresAt > asOf)
  const byTenant = new Map<string, Audit[]>()
  for (const row of matching) {
    const bucket = byTenant.get(row.customerTenantId) ?? []
    bucket.push(row)
    byTenant.set(row.customerTenantId, bucket)
  }
  const projected: any[] = []
  for (const [, bucket] of byTenant) {
    bucket.sort((left, right) =>
      right.eventDateTime.getTime() - left.eventDateTime.getTime() ||
      right.microsoftAuditId.localeCompare(left.microsoftAuditId))
    let running = 0
    bucket.slice(0, sentinelRows).forEach((row, offset) => {
      const initiatedText = row.initiatedBy === null ? null : JSON.stringify(row.initiatedBy)
      const targetText = row.targetResources === null ? null : JSON.stringify(row.targetResources)
      const initiatedBytes = Buffer.byteLength(initiatedText ?? '', 'utf8')
      const targetBytes = Buffer.byteLength(targetText ?? '', 'utf8')
      running += Math.min(initiatedBytes, fieldBytes) + Math.min(targetBytes, fieldBytes)
      const oversize = initiatedBytes > fieldBytes || targetBytes > fieldBytes
      const overBudget = running > tenantBytes
      projected.push({
        organization_id: row.organizationId,
        customer_tenant_id: row.customerTenantId,
        microsoft_audit_id: row.microsoftAuditId,
        event_date_time: row.eventDateTime,
        activity_display_name: row.activityDisplayName,
        category: row.category,
        operation_type: row.operationType,
        result: row.result,
        // int8 as the decimal string a node-postgres-shaped store renders.
        row_position: String(offset + 1),
        field_oversize: oversize,
        over_payload_budget: overBudget,
        initiated_by_withheld: initiatedBytes > fieldBytes || overBudget,
        target_resources_withheld: targetBytes > fieldBytes || overBudget,
        initiated_by_text: initiatedBytes > fieldBytes || overBudget ? null : initiatedText,
        target_resources_text: targetBytes > fieldBytes || overBudget ? null : targetText,
      })
    })
  }
  return projected
}

const auditKeys = (value: { attention: { key: string }[] }) =>
  value.attention.filter(a => a.key.startsWith('audit-')).map(a => a.key)
const read = (f: ReturnType<typeof fixture>) => f.service.listForIdentity(identity, { now: () => NOW })

test('tenant list expiry: strict boundary, event window, presentation and snapshot payload', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network prohibited') })
  const f = fixture([audit('expired', -1, -100), audit('equal', 0, -200), audit('eligible', 1, -300),
    audit('outside-window', 1, -DAY - 1), audit('window-boundary', 1, -DAY)])
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-eligible', 'audit-auth-window-boundary'])
  assert.equal(f.writes.length, 1)
  assert.deepEqual(auditKeys(f.writes[0].payload), auditKeys(result.tenants[0]!))
  const finding = result.tenants[0]!.attention.find(a => a.key === 'audit-auth-eligible')!
  assert.equal(finding.severity, 'high')
  assert.equal(finding.detectedAt, date(-300).toISOString())
  assert.match(finding.why, /\[REDACTED\]/)
  assert.match(finding.actionUrl, new RegExp(`^/what-changed\\?tenantId=${TENANT_A}&from=`))
  assert.equal('expiresAt' in finding, false)
  assert.equal('raw' in finding, false)
  // One read, for exactly this tenant's pair, with the five fixed bound values.
  assert.equal(f.reads.length, 1)
  assert.deepEqual(f.reads[0]!.pairs, [[ORG_A, TENANT_A]])
  assert.equal(f.reads[0]!.params[0], AUDIT_EVIDENCE_MAX_PAYLOAD_FIELD_BYTES)
  assert.deepEqual(f.reads[0]!.params[1], new Date(NOW.getTime() - DAY))
  assert.deepEqual(f.reads[0]!.params[2], NOW)
  assert.equal(f.reads[0]!.params[3], AUDIT_EVIDENCE_SENTINEL_ROWS)
  assert.equal(f.reads[0]!.params[4], AUDIT_EVIDENCE_MAX_TENANT_PAYLOAD_BYTES)
  assert.equal(f.reads[0]!.params.length, 7, 'five fixed values plus one pair; nothing else is bound')
  // No value is interpolated into the statement text.
  for (const value of [TENANT_A, ORG_A, 'eligible', '[REDACTED]', String(AUDIT_EVIDENCE_TENANT_CAP)]) {
    assert.equal(f.reads[0]!.sql.includes(value), false, `${value} must be bound, not interpolated`)
  }
  // The window was read and nothing was withheld, so this is a complete read.
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.reason, 'OK')
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.windowComplete, true)
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.observedCount, 2)
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.assessedAt, NOW.toISOString())
})

test('tenant list expiry: expired rows cannot crowd eligible attention out of the tenant window', async () => {
  const rows = [...Array.from({ length: 501 }, (_, i) => audit(`expired-${i}`, -1, -i)),
    audit('equal', 0, -600), audit('eligible-newer', 1, -700), audit('eligible-older', 2, -800)]
  const f = fixture(rows)
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-eligible-newer', 'audit-auth-eligible-older'])
  assert.deepEqual(auditKeys(f.writes[0].payload), auditKeys(result.tenants[0]!))
  // Expiry is applied before ranking, so the cap was never reached.
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.status, 'COMPLETE')
})

test('tenant list expiry: the cap is now per tenant, so a noisy tenant cannot starve a quiet one', async () => {
  // 501 eligible events for the noisy tenant: the sentinel establishes CAPPED.
  const rows = Array.from({ length: AUDIT_EVIDENCE_SENTINEL_ROWS },
    (_, i) => audit(`noisy-${String(i).padStart(4, '0')}`, 1, -i))
  // One older event for the quiet tenant. Under the previous shared `take: 500`
  // this row was never read at all.
  rows.push({ ...audit('quiet-critical', 1, -600, TENANT_B, ORG_A),
    activityDisplayName: 'Disable conditional access policy', category: 'Policy',
    targetResources: [{ type: 'conditionalAccessPolicy', displayName: 'Require MFA' }] })
  const f = fixture(rows, { tenants: [tenantRow(TENANT_A, ORG_A, 'a'), tenantRow(TENANT_B, ORG_A, 'b')] })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => t.id), [TENANT_A, TENANT_B])
  const noisy = result.tenants[0]!, quiet = result.tenants[1]!
  // The quiet tenant's older adverse finding survives, in the response and in
  // the saved snapshot, and it is a critical finding rather than a hint.
  assert.deepEqual(auditKeys(quiet), ['audit-ca-quiet-critical'])
  assert.equal(quiet.tenantHealth.security.criticalFindings, 1)
  assert.equal(quiet.tenantHealth.overallStatus, 'CRITICAL')
  assert.equal(quiet.tenantHealth.auditEvidence.status, 'COMPLETE')
  const savedQuiet = f.writes.find(w => w.customerTenantId === TENANT_B)!
  assert.deepEqual(auditKeys(savedQuiet.payload), ['audit-ca-quiet-critical'])
  assert.equal(savedQuiet.payload.auditEvidence.status, 'COMPLETE')
  // The noisy tenant reports its own window as capped, keeps at most the cap in
  // observations, and cannot read healthy on unknown coverage.
  assert.equal(noisy.tenantHealth.auditEvidence.status, 'CAPPED')
  assert.equal(noisy.tenantHealth.auditEvidence.reason, 'TENANT_EVENT_CAP_REACHED')
  assert.equal(noisy.tenantHealth.auditEvidence.windowComplete, false)
  assert.equal(noisy.tenantHealth.auditEvidence.observedCount, AUDIT_EVIDENCE_TENANT_CAP)
  assert.notEqual(noisy.tenantHealth.security.status, 'HEALTHY')
  assert.notEqual(noisy.tenantHealth.overallStatus, 'HEALTHY')
  // Both tenants fit one bounded page, so one read covers them.
  assert.equal(f.reads.length, 1)
  assert.deepEqual(f.reads[0]!.pairs, [[ORG_A, TENANT_A], [ORG_A, TENANT_B]])
  // Negative control reproducing the OLD behaviour, and the boundary of what a
  // storage fake can establish. A store that applies its own shared window —
  // the newest 500 rows across both tenants, renumbered — drops the quiet
  // tenant's older row, and the quiet tenant then reads as a genuinely
  // COMPLETE EMPTY window. That false clean read is the original defect, and it
  // is NOT detectable from the returned rows: it is the caller-owned limit the
  // reader documents, which is why the per-tenant cap has to live in the
  // statement and why the registered physical witness, not this fake, is what
  // establishes that it does.
  const shared = fixture(rows, {
    tenants: [tenantRow(TENANT_A, ORG_A, 'a'), tenantRow(TENANT_B, ORG_A, 'b')],
    override: (readRequest) => adapterRows(readRequest, rows)
      .sort((left: any, right: any) => right.event_date_time.getTime() - left.event_date_time.getTime())
      .slice(0, AUDIT_EVIDENCE_TENANT_CAP)
      .map((row: any, offset: number) => ({ ...row, row_position: String(offset + 1) })),
  })
  const starved = await read(shared)
  assert.deepEqual(auditKeys(starved.tenants[1]!), [], 'the shared window loses the quiet finding')
  assert.equal(starved.tenants[1]!.tenantHealth.auditEvidence.status, 'COMPLETE')
  assert.equal(starved.tenants[1]!.tenantHealth.auditEvidence.observedCount, 0)
  // And the same control shows what this slice DOES fix: with the real
  // per-tenant statement the quiet finding above survived, whereas a shared cap
  // silently returns a clean tenant. The two results differ for identical
  // stored rows.
  assert.notDeepEqual(auditKeys(starved.tenants[1]!), auditKeys(quiet))
  assert.equal(starved.tenants[1]!.tenantHealth.security.criticalFindings, 0)
  assert.equal(quiet.tenantHealth.security.criticalFindings, 1)
})

test('tenant list expiry: label dedup and the max3 audit finding budget remain', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => audit(`first-${i}`, 1, -i))
  // An exact duplicate label still picks the newer evidence, not another item.
  rows[1] = { ...rows[1]!, targetResources: rows[0]!.targetResources }
  const f = fixture(rows)
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-first-0', 'audit-auth-first-2', 'audit-auth-first-3'])
})

test('tenant list expiry: multiple authorized organizations and foreign/unselected isolation', async () => {
  const f = fixture([audit('a', 1), audit('b', 1, -1000, TENANT_B, ORG_B),
    audit('foreign', 1, 0, TENANT_FOREIGN, ORG_FOREIGN), audit('unselected', 1, 0, TENANT_UNSELECTED)], {
    organizations: [ORG_A, ORG_B],
    tenants: [tenantRow(TENANT_B, ORG_B, 'b'), tenantRow(TENANT_A, ORG_A, 'a'),
      tenantRow(TENANT_FOREIGN, ORG_FOREIGN, 'foreign')],
  })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => [t.id, auditKeys(t)]), [
    [TENANT_A, ['audit-auth-a']], [TENANT_B, ['audit-auth-b']],
  ])
  assert.deepEqual(f.writes.map(w => [w.organizationId, w.customerTenantId]),
    [[ORG_A, TENANT_A], [ORG_B, TENANT_B]])
  // Each tenant is paired with its OWN selected organization. The cross-product
  // pairs the previous workspace-wide read would have admitted are absent, and
  // the unauthorized organization is never named.
  assert.deepEqual(f.reads[0]!.pairs, [[ORG_A, TENANT_A], [ORG_B, TENANT_B]])
  for (const forbidden of [[ORG_A, TENANT_B], [ORG_B, TENANT_A], [ORG_FOREIGN, TENANT_FOREIGN],
    [ORG_A, TENANT_UNSELECTED]] as Array<[string, string]>) {
    assert.equal(f.reads[0]!.pairs.some(([org, tenant]) => org === forbidden[0] && tenant === forbidden[1]),
      false, `${forbidden.join('/')} must never be requested`)
  }
})

test('tenant list expiry: event window and expiry share one query clock', async () => {
  const f = fixture([audit('shared', 1, -DAY)])
  let calls = 0
  const result = await f.service.listForIdentity(identity, { now: () => date(calls++ * 2) })
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-shared'])
  assert.equal(calls, 1, 'the assessment clock is captured exactly once per request')
  assert.deepEqual(f.reads[0]!.params[1], new Date(NOW.getTime() - DAY))
  assert.deepEqual(f.reads[0]!.params[2], NOW)
  // The same captured value reaches readiness, freshness, health and the saved
  // summary, so no later acquisition can shift the window mid-request.
  assert.equal(result.tenants[0]!.tenantHealth.evaluatedAt, NOW.toISOString())
  assert.equal(result.tenants[0]!.tenantHealth.auditEvidence.assessedAt, NOW.toISOString())
  assert.equal(f.writes[0].evaluatedAt.toISOString(), NOW.toISOString())
})

test('tenant list expiry: normal caller uses platform time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([audit('equal', 0), audit('eligible', 1)])
  assert.deepEqual(auditKeys((await f.service.listForIdentity(identity)).tenants[0]!), ['audit-auth-eligible'])
})

for (const account of ['missing', 'disabled', 'nonmember']) {
  test(`tenant list expiry: ${account} cannot read audit rows or write snapshots`, async () => {
    const f = fixture([audit('eligible', 1)], { account })
    if (account === 'nonmember') assert.deepEqual(await read(f), { tenants: [] })
    else await assert.rejects(read(f), /account setup|disabled/)
    assert.equal(f.reads.length, 0)
    assert.equal(f.writes.length, 0)
  })
}

test('tenant list expiry: existing conditional snapshot decision uses eligible health', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const expired = { ...audit('expired-critical', -1, -100), activityDisplayName: 'Disable conditional access policy' }
  const f = fixture([expired, audit('eligible', 1, -200)])
  const first = (await read(f)).tenants[0]!
  assert.equal(first.tenantHealth.overallStatus, 'ATTENTION')
  const previous = f.writes[0]
  assert.equal(f.writes.length, 1)
  f.previous.set(TENANT_A, { overallStatus: previous.overallStatus, payload: previous.payload,
    evaluatedAt: date(-1), healthModelVersion: previous.healthModelVersion })
  f.writes.length = 0
  await read(f)
  assert.equal(f.writes.length, 0, 'same eligible status/signature within15minutes skips snapshot')
  f.previous.set(TENANT_A, { overallStatus: 'CRITICAL', payload: previous.payload,
    evaluatedAt: date(-1), healthModelVersion: previous.healthModelVersion })
  await read(f)
  assert.equal(f.writes.length, 1, 'different eligible status retains existing create decision')
  assert.equal(f.writes[0].overallStatus, 'ATTENTION')
  assert.deepEqual(auditKeys(f.writes[0].payload), ['audit-auth-eligible'])
})
