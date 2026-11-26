import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService, authoritativeSnapshot, type SnapshotCollectionResult } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-haw89', organizationId: 'organization-haw89' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 7n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const STORED_AT = new Date('2026-11-01T00:00:00.000Z')
/** Appears only inside a stored/candidate document, so finding it in a recorded
 *  request proves the document was transmitted. */
const SENTINEL = 'haw89-document-sentinel'

/** A supported document: strings, booleans, null, dense arrays, plain objects,
 *  and deliberately no number anywhere. */
const document = () => [
  { id: 'group-1', displayName: SENTINEL, securityEnabled: true, visibility: null, groupTypes: ['Unified'] },
  { id: 'group-2', displayName: 'Second', securityEnabled: false, visibility: 'Private', groupTypes: [] },
]
/** The same value with every object's keys written in another order, which is
 *  what a jsonb round trip can hand back. */
const reorderedDocument = () => [
  { groupTypes: ['Unified'], visibility: null, securityEnabled: true, displayName: SENTINEL, id: 'group-1' },
  { visibility: 'Private', groupTypes: [], securityEnabled: false, displayName: 'Second', id: 'group-2' },
]

type RecordedCall = { method: string; args: readonly unknown[] }
type StoredRow = { id: string; payload: unknown; observedAt: Date; organizationId: string }
type SaveArgs = readonly unknown[]

const storedRow = (payload: unknown): StoredRow => ({
  id: 'snapshot-row-haw89', payload, observedAt: STORED_AT, organizationId: tenant.organizationId,
})

/** Structural equality independent of the module under test, so the compare and
 *  set model below cannot inherit a defect from the comparator it is checking. */
function independentlyEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right)
    return true
  } catch {
    return false
  }
}

function harness(options: {
  stored?: StoredRow | null
  evidence?: readonly unknown[]
  observationCount?: number
  leaseLost?: boolean
  /** Let the snapshot writes mutate a modelled row, for sequence tests. */
  modelStore?: boolean
} = {}) {
  const calls: RecordedCall[] = []
  let row: StoredRow | null = options.stored === undefined ? storedRow(document()) : options.stored
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }) }
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("current_setting('TimeZone')")) return [{ timezone: 'UTC' }]
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        return options.leaseLost === true ? [] : [{ generation: owner.generation.toString() }]
      }
      return assert.fail(`Unexpected query: ${sql}`)
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      record('$executeRawUnsafe', sql, ...params)
      return 1
    },
    tenantEntraSnapshot: {
      findUnique: async (args: unknown) => { record('tenantEntraSnapshot.findUnique', args); return row },
      upsert: async (args: unknown) => {
        record('tenantEntraSnapshot.upsert', args)
        if (options.modelStore === true) {
          const request = args as { create: { payload: unknown; observedAt: Date }; update: { payload: unknown; observedAt: Date } }
          row = row === null
            ? storedRow(request.create.payload)
            : { ...row, payload: request.update.payload, observedAt: request.update.observedAt }
        }
        return {}
      },
      updateMany: async (args: unknown) => {
        record('tenantEntraSnapshot.updateMany', args)
        if (options.observationCount !== undefined) return { count: options.observationCount }
        if (options.modelStore !== true) return { count: 1 }
        const request = args as { where: { id?: string; organizationId?: string; customerTenantId?: string }; data: { observedAt: Date } }
        const matches = row !== null && request.where.id === row.id &&
          request.where.organizationId === row.organizationId &&
          request.where.customerTenantId === tenant.id
        if (!matches) return { count: 0 }
        row = { ...row!, observedAt: request.data.observedAt }
        return { count: 1 }
      },
    },
    changeEvidenceEvent: {
      createMany: async (args: unknown) => { record('changeEvidenceEvent.createMany', args); return { count: 1 } },
    },
    tenantAuditReconciliationWork: {
      updateMany: async (args: unknown) => { record('tenantAuditReconciliationWork.updateMany', args); return { count: 1 } },
    },
    tenantCollectionFieldState: {
      upsert: async (args: unknown) => { record('tenantCollectionFieldState.upsert', args); return {} },
    },
  }
  let committed = false
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      const outcome = await work(transaction)
      committed = true
      return outcome
    },
  }
  const changeEvidence = {
    buildSnapshotDifferenceEvidence: (input: unknown) => {
      record('buildSnapshotDifferenceEvidence', input)
      return options.evidence ?? []
    },
  }
  const service = new TenantSyncService(
    prisma as never, {} as never, {} as never, {} as never, changeEvidence as never, {} as never,
  )
  const save = (...args: SaveArgs) =>
    (service as unknown as { saveSnapshot: (...a: SaveArgs) => Promise<void> }).saveSnapshot(...args)
  return {
    calls, save,
    committed: () => committed,
    storedPayload: () => row?.payload ?? null,
    storedObservedAt: () => row?.observedAt ?? null,
    rowId: () => row?.id ?? null,
    /** Model another writer deleting and recreating the row mid-transaction. */
    replaceRow: () => { row = row === null ? null : { ...row, id: `${row.id}-successor` } },
    of: (method: string) => calls.filter((call) => call.method === method),
    /** The enrichment compare and set, modelled on its real shape: it matches
     *  only while the stored payload still equals the definition it published. */
    compareAndSet: (expected: unknown, enriched: unknown) => {
      if (row === null || !independentlyEqual(row.payload, expected)) return { count: 0 }
      row = { ...row, payload: enriched }
      return { count: 1 }
    },
  }
}

/** Any structural sign of a document inside a recorded request. */
function documentKeys(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown, where: string, depth: number) => {
    if (depth > 12 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${where}[${index}]`, depth + 1))
      return
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'payload' || key === 'create' || key === 'select' || key === 'include') {
        found.push(`${where}.${key}`)
      }
      walk(child, `${where}.${key}`, depth + 1)
    }
  }
  walk(value, '$', 0)
  return found
}

const supported = (rows: unknown[]): SnapshotCollectionResult => authoritativeSnapshot(rows)

// ---------------------------------------------------------------------------
// Omission witnesses. Each of these fails on the released writer, which always
// supplies `update.payload`, and passes once the unchanged branch exists.
// ---------------------------------------------------------------------------

test('an identical supported document is recorded by observation time alone', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(document()))

  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [], 'no upsert may run on the unchanged path')
  const observations = fake.of('tenantEntraSnapshot.updateMany')
  assert.equal(observations.length, 1)
  const request = observations[0]!.args[0] as { where: Record<string, unknown>; data: Record<string, unknown> }
  assert.deepEqual(Object.keys(request.data), ['observedAt'])
  assert.deepEqual(Object.keys(request.where).sort(),
    ['customerTenantId', 'id', 'organizationId', 'resourceType'])
  assert.equal(request.where.id, 'snapshot-row-haw89')
  assert.equal(request.where.organizationId, tenant.organizationId)
  assert.equal(request.where.customerTenantId, tenant.id)
  assert.equal(request.where.resourceType, 'GROUPS')
  assert.ok(request.data.observedAt instanceof Date)
  assert.ok((request.data.observedAt as Date).getTime() > STORED_AT.getTime(), 'observation time advances')
  // The complete persistence request carries no document, by structure and by
  // content: no payload/create/select/include key, and no byte of the document.
  assert.deepEqual(documentKeys(request), [])
  assert.equal(JSON.stringify(request).includes(SENTINEL), false)
  assert.equal(fake.committed(), true)
})

test('a key-order-only difference is still recorded by observation time alone', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(reorderedDocument()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.equal(fake.of('tenantEntraSnapshot.updateMany').length, 1)
  assert.equal(JSON.stringify(fake.of('tenantEntraSnapshot.updateMany')).includes(SENTINEL), false)
})

test('a resource with no difference catalog is recorded by observation time alone', async () => {
  const fake = harness({ stored: storedRow(document()), evidence: [] })
  await fake.save(tenant, 'DEVICES', supported(document()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.equal(fake.of('tenantEntraSnapshot.updateMany').length, 1)
  assert.deepEqual(fake.of('changeEvidenceEvent.createMany'), [], 'an empty catalog writes no evidence')
})

test('the comparison reads the merged rows, not the incoming rows', async () => {
  const fake = harness({ stored: storedRow(document()) })
  const incoming = [{ id: 'group-1', displayName: 'different' }]
  let mergedWith: readonly unknown[] | null = null
  await fake.save(tenant, 'GROUPS', supported(incoming), undefined, false, undefined,
    (previous: readonly unknown[], incomingRows: readonly unknown[]) => {
      mergedWith = incomingRows
      // A merge that restores the stored baseline leaves nothing to write.
      return previous as unknown[]
    })
  assert.deepEqual(mergedWith, incoming, 'the merge really did see the incoming rows')
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [],
    'merged-identical rows must not be re-sent even though the incoming rows differed')
  assert.equal(fake.of('tenantEntraSnapshot.updateMany').length, 1)
})

test('SECURE_SCORES keeps its current-score completeness and omits an identical document', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'SECURE_SCORES', { rows: document(), completeness: 'current_score_complete' })
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.equal(fake.of('tenantEntraSnapshot.updateMany').length, 1)
})

// ---------------------------------------------------------------------------
// Direction controls. These pass on the released writer too, and they are what
// an always-true or evidence-driven predicate would break.
// ---------------------------------------------------------------------------

test('a changed document is written in full', async () => {
  const fake = harness({ stored: storedRow(document()) })
  const changed = document()
  ;(changed[0] as Record<string, unknown>).displayName = 'renamed'
  await fake.save(tenant, 'GROUPS', supported(changed))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  const upserts = fake.of('tenantEntraSnapshot.upsert')
  assert.equal(upserts.length, 1)
  const request = upserts[0]!.args[0] as { create: { payload: unknown }; update: { payload: unknown } }
  assert.deepEqual(request.update.payload, changed)
  assert.deepEqual(request.create.payload, changed)
})

test('a change the difference catalog does not track is still written in full', async () => {
  // The evidence builder reports nothing, exactly as it does for an untracked
  // field or an uncatalogued resource. Identity must not be read off that.
  const fake = harness({ stored: storedRow(document()), evidence: [] })
  const changed = document()
  ;(changed[1] as Record<string, unknown>).untrackedDetail = 'added'
  await fake.save(tenant, 'DEVICES', supported(changed))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.deepEqual(fake.of('changeEvidenceEvent.createMany'), [])
})

test('array reordering is a change and is written in full', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported([...document()].reverse()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('a numeric value anywhere keeps the full write, which is the declared limit', async () => {
  const withNumber = () => [{ id: 'group-1', displayName: SENTINEL, memberCount: 4 }]
  const fake = harness({ stored: storedRow(withNumber()) })
  await fake.save(tenant, 'GROUPS', supported(withNumber()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [],
    'a number is undecidable here, so nothing may be omitted')
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('null against a missing key keeps the full write', async () => {
  const fake = harness({ stored: storedRow([{ id: 'group-1', visibility: null }]) })
  await fake.save(tenant, 'GROUPS', supported([{ id: 'group-1' }]))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('an unsupported value keeps the full write', async () => {
  const instant = new Date('2026-05-05T00:00:00.000Z')
  const fake = harness({ stored: storedRow([{ id: 'group-1', at: instant }]) })
  await fake.save(tenant, 'GROUPS', supported([{ id: 'group-1', at: instant }]))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('a non-array stored document keeps the full write', async () => {
  const fake = harness({ stored: storedRow({ window: 'object-shaped' }) })
  await fake.save(tenant, 'GROUPS', supported(document()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('a first collection creates the row with its full payload', async () => {
  const fake = harness({ stored: null })
  await fake.save(tenant, 'GROUPS', supported(document()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [], 'an absent row is never observation-only')
  const upserts = fake.of('tenantEntraSnapshot.upsert')
  assert.equal(upserts.length, 1)
  const request = upserts[0]!.args[0] as { create: Record<string, unknown> }
  assert.deepEqual(request.create.payload, document())
  assert.equal(request.create.organizationId, tenant.organizationId)
})

// ---------------------------------------------------------------------------
// Row scope, count and rollback.
// ---------------------------------------------------------------------------

for (const count of [0, 2] as const) {
  test(`an observation matching ${count} rows aborts the transaction instead of resurrecting one`, async () => {
    const fake = harness({ stored: storedRow(document()), observationCount: count, evidence: [{ sourceEventId: 'e' }] })
    let persisted = false
    await assert.rejects(
      () => fake.save(tenant, 'GROUPS', supported(document()), async () => { persisted = true }),
      (error: unknown) => {
        assert.match(String(error), /SNAPSHOT_UNCHANGED_OBSERVATION_NOT_ONE_ROW:GROUPS:/)
        assert.match(String(error), new RegExp(`:${count}$`))
        return true
      },
    )
    // Never a second attempt that could recreate the row it failed to find.
    assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
    // The staged side effects ran, and the transaction did not commit, so a
    // real transaction discards every one of them.
    assert.equal(persisted, true, 'the inventory callback had already run')
    assert.equal(fake.of('changeEvidenceEvent.createMany').length, 1, 'evidence had already been staged')
    assert.equal(fake.of('tenantAuditReconciliationWork.updateMany').length, 0)
    assert.equal(fake.committed(), false, 'the transaction must not commit')
  })
}

// ---------------------------------------------------------------------------
// Preservation of everything around the branch.
// ---------------------------------------------------------------------------

test('the advisory lock, the read and the comparison keep their order', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(document()))
  const order = fake.calls.map((call) => call.method)
  assert.deepEqual(order, [
    '$executeRawUnsafe',
    'tenantEntraSnapshot.findUnique',
    'buildSnapshotDifferenceEvidence',
    'tenantEntraSnapshot.updateMany',
  ])
  const lock = fake.of('$executeRawUnsafe')[0]!
  assert.equal(lock.args[0], 'SELECT pg_advisory_xact_lock(hashtext($1))')
  assert.equal(lock.args[1], `hawkview:snapshot:${tenant.id}:GROUPS`)
})

test('the difference evidence still sees the stored payload and the merged rows', async () => {
  const stored = document()
  const fake = harness({ stored: storedRow(stored) })
  await fake.save(tenant, 'GROUPS', supported(reorderedDocument()))
  const built = fake.of('buildSnapshotDifferenceEvidence')
  assert.equal(built.length, 1)
  const input = built[0]!.args[0] as { previousPayload: unknown; currentPayload: unknown; baselineObservedAt: Date }
  assert.deepEqual(input.previousPayload, stored)
  assert.deepEqual(input.currentPayload, reorderedDocument())
  assert.equal(input.baselineObservedAt.getTime(), STORED_AT.getTime(),
    'the baseline version is still the stored observation time')
})

test('the resource inventory callback still runs before the observation write', async () => {
  const fake = harness({ stored: storedRow(document()) })
  const seen: string[] = []
  await fake.save(tenant, 'GROUPS', supported(document()), async () => { seen.push('callback') })
  assert.deepEqual(seen, ['callback'])
  assert.equal(fake.of('tenantEntraSnapshot.updateMany').length, 1)
})

test('the exact audit revision is acknowledged inside the omitting transaction', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(document()), undefined, false, undefined, undefined, owner, 5n)
  const receipts = fake.of('tenantAuditReconciliationWork.updateMany')
  assert.equal(receipts.length, 1)
  const receipt = receipts[0]!.args[0] as { where: Record<string, unknown>; data: Record<string, unknown> }
  assert.equal(receipt.where.requestedRevision, 5n)
  assert.equal(receipt.where.customerTenantId, tenant.id)
  const observation = fake.of('tenantEntraSnapshot.updateMany')[0]!.args[0] as { data: { observedAt: Date } }
  assert.equal((receipt.data.lastCompletedAt as Date).getTime(), observation.data.observedAt.getTime(),
    'the receipt and the observation share one instant')
  assert.equal(fake.committed(), true)
})

test('mailbox source attestation still runs on the omitting path, after UTC enforcement', async () => {
  // A valid accepted-domains document, so the legacy attestation guard is
  // satisfied on its own terms rather than by relaxing it. Strings and booleans
  // only, so the document is still omission-eligible.
  const domains = () => [
    { domain: 'example.com', isDefault: true, isInitial: false },
    { domain: 'contoso.example', isDefault: false, isInitial: true },
  ]
  const fake = harness({ stored: storedRow(domains()) })
  await fake.save(tenant, 'EXCHANGE_ACCEPTED_DOMAINS', supported(domains()), undefined, true)
  const raw = fake.of('$executeRawUnsafe').map((call) => String(call.args[0]))
  assert.equal(raw[0], "SET LOCAL TIME ZONE 'UTC'", 'UTC enforcement still comes first')
  assert.ok(raw.some((sql) => sql.includes('pg_advisory_xact_lock')))
  const attestations = fake.of('tenantCollectionFieldState.upsert')
  assert.equal(attestations.length, 1)
  const attestation = attestations[0]!.args[0] as { create: Record<string, unknown> }
  assert.equal(attestation.create.state, 'COMPLETE', 'a valid document still attests complete')
  assert.equal(attestation.create.fieldKey, 'identity-risk/v1/EXCHANGE_ACCEPTED_DOMAINS')
  assert.equal(typeof attestation.create.correlationId, 'string')
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 0)
})

test('a cross-organization row is refused before any write', async () => {
  const fake = harness({ stored: { ...storedRow(document()), organizationId: 'organization-other' } })
  await assert.rejects(() => fake.save(tenant, 'GROUPS', supported(document())), /organization mismatch/i)
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.equal(fake.committed(), false)
})

test('a lost visit lease is refused before any write', async () => {
  const fake = harness({ stored: storedRow(document()), leaseLost: true })
  await assert.rejects(
    () => fake.save(tenant, 'GROUPS', supported(document()), undefined, false, undefined, undefined, owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.deepEqual(fake.of('$executeRawUnsafe'), [], 'the lease is checked before the lock')
  assert.equal(fake.committed(), false)
})

test('a partial collection never reaches the transaction', async () => {
  const fake = harness({ stored: storedRow(document()) })
  await assert.rejects(
    () => fake.save(tenant, 'GROUPS', { rows: document(), completeness: 'partial_or_unknown' }),
    /Refusing to advance GROUPS snapshot baseline/,
  )
  assert.deepEqual(fake.calls, [])
  assert.equal(fake.committed(), false)
})

test('the omitting path does not mutate either document', async () => {
  const stored = document()
  const candidate = reorderedDocument()
  const storedBefore = JSON.stringify(stored)
  const candidateBefore = JSON.stringify(candidate)
  const fake = harness({ stored: storedRow(stored) })
  await fake.save(tenant, 'GROUPS', supported(candidate))
  assert.equal(JSON.stringify(stored), storedBefore)
  assert.equal(JSON.stringify(candidate), candidateBefore)
})

// ---------------------------------------------------------------------------
// The GROUPS definition then enrichment sequence, against a modelled row.
// ---------------------------------------------------------------------------

test('an omitted definition leaves the stored payload the enrichment expects', async () => {
  const fake = harness({ stored: storedRow(document()), modelStore: true })
  await fake.save(tenant, 'GROUPS', supported(reorderedDocument()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  // The retained payload is still the stored one, so the enrichment compare and
  // set matches exactly one row -- and it is a real match, not a stub.
  assert.deepEqual(fake.storedPayload(), document())
  const enriched = [...document(), { id: 'relationships', owners: ['user-1'] }]
  assert.deepEqual(fake.compareAndSet(document(), enriched), { count: 1 })
  assert.deepEqual(fake.storedPayload(), enriched)
  // The same compare and set against the wrong expectation genuinely fails.
  assert.deepEqual(fake.compareAndSet(document(), enriched), { count: 0 })
})

test('a definition pass after enrichment rewrites the document and leaves no stale relationships', async () => {
  const enriched = [...document(), { id: 'relationships', owners: ['user-1'] }]
  const fake = harness({ stored: storedRow(enriched), modelStore: true })
  await fake.save(tenant, 'GROUPS', supported(document()))
  // Enriched is not the definition, so the full write runs and restores it.
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.deepEqual(fake.storedPayload(), document())
  assert.deepEqual(fake.compareAndSet(document(), enriched), { count: 1 })
})

test('a row replaced mid-transaction matches nothing, so the id scope is load bearing', async () => {
  const fake = harness({ stored: storedRow(document()), modelStore: true })
  // The inventory callback stands in for a concurrent writer that deleted and
  // recreated this resource's row while this transaction held its own read.
  await assert.rejects(
    () => fake.save(tenant, 'GROUPS', supported(document()), async () => { fake.replaceRow() }),
    /SNAPSHOT_UNCHANGED_OBSERVATION_NOT_ONE_ROW:GROUPS:0/,
  )
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [], 'the successor row is never overwritten')
  assert.equal(fake.rowId(), 'snapshot-row-haw89-successor')
  assert.deepEqual(fake.storedPayload(), document(), 'the successor keeps its own document')
  assert.equal(fake.storedObservedAt()?.getTime(), STORED_AT.getTime(), 'and its own observation time')
  assert.equal(fake.committed(), false)
})

// ---------------------------------------------------------------------------
// Serialization-boundary regressions on the real saveSnapshot path. Before the
// comparator correction each of these took the observation-only branch while
// the document that would have been stored differed, so a real change was
// silently skipped.
// ---------------------------------------------------------------------------

test('a candidate with a hidden toJSON is written in full, not observed', async () => {
  let invoked = 0
  const candidate = document()
  Object.defineProperty(candidate[0]!, 'toJSON', {
    value: () => { invoked += 1; return { id: 'group-1', displayName: 'rewritten' } },
    enumerable: false, configurable: true,
  })
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(candidate))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [],
    'a hidden serialization hook must not be omitted')
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.equal(invoked, 0, 'the writer must not invoke the hook either')
})

test('a stored document carrying a hidden toJSON is written in full', async () => {
  const stored = document()
  Object.defineProperty(stored, 'toJSON', {
    value: () => [{ id: 'elsewhere' }], enumerable: false, configurable: true,
  })
  const fake = harness({ stored: storedRow(stored) })
  await fake.save(tenant, 'GROUPS', supported(document()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('an array subclass candidate is written in full despite passing Array.isArray', async () => {
  class Rows extends Array { toJSON() { return [{ id: 'subclass' }] } }
  const candidate = new Rows()
  for (const row of document()) candidate.push(row)
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(candidate as unknown[]))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
})

test('a proxied candidate is written in full and consults no trap', async () => {
  const traps: string[] = []
  const candidate = new Proxy(document(), {
    get(target, key, receiver) { traps.push(String(key)); return Reflect.get(target, key, receiver) },
    ownKeys(target) { traps.push('ownKeys'); return Reflect.ownKeys(target) },
  })
  const fake = harness({ stored: storedRow(document()) })
  await fake.save(tenant, 'GROUPS', supported(candidate))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.deepEqual(traps, [], 'the comparison must not read through the proxy')
})

test('a proxied stored document is written in full and the collection completes', async () => {
  // A live Proxy passes `Array.isArray`, so it reaches the comparator, which
  // refuses it. The collection still completes: refusing to decide may never
  // turn into a failed sync.
  const fake = harness({ stored: storedRow(new Proxy(document(), {})) })
  await fake.save(tenant, 'GROUPS', supported(document()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.equal(fake.committed(), true)
})

test('a revoked proxied stored document raises upstream of the comparator, not inside it', async () => {
  // This pins a boundary rather than hiding it. `saveSnapshot` reads
  // `Array.isArray(existing?.payload)` at tenant-sync.service.ts:5961 -- a line
  // byte-identical in released main835 and untouched by this candidate -- and
  // that call throws on a revoked Proxy before the comparator is ever reached.
  // The comparator's own never-throws contract is proved directly in
  // snapshot-payload-identity.test.ts; it cannot extend to a value the caller
  // has already inspected. Prisma's JSON decode does not produce proxies, so
  // this is a contract statement, not a reachable production path.
  const revocable = Proxy.revocable(document(), {})
  revocable.revoke()
  const fake = harness({ stored: storedRow(revocable.proxy) })
  await assert.rejects(
    () => fake.save(tenant, 'GROUPS', supported(document())),
    /Cannot perform 'IsArray' on a proxy that has been revoked/,
  )
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [])
  assert.deepEqual(fake.of('tenantEntraSnapshot.upsert'), [])
  assert.equal(fake.committed(), false)
})

test('a document whose key characters exceed the comparison budget is written in full', async () => {
  const keyName = 'k'.repeat(8000)
  const wide = () => Array.from({ length: 60 }, () => {
    const row: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) row[`${keyName}${index}`] = 'v'
    return row
  })
  const fake = harness({ stored: storedRow(wide()) })
  await fake.save(tenant, 'GROUPS', supported(wide()))
  assert.deepEqual(fake.of('tenantEntraSnapshot.updateMany'), [],
    'budget exhaustion keeps the existing write')
  assert.equal(fake.of('tenantEntraSnapshot.upsert').length, 1)
  assert.equal(fake.committed(), true, 'and never fails the collection')
})
