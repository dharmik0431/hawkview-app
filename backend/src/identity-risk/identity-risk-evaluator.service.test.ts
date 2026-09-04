import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
  type IdentityRiskEvaluationRequest,
  type IdentityRiskSourcePayload,
  type IdentityRiskSourceEnvelope,
  type IdentitySignalDetector,
} from './identity-risk.contract.js'
import type { IdentitySignalCandidate as ApprovedIdentitySignalCandidate } from './identity-signal-contract.js'
import {
  IdentityRiskEvaluationScheduler,
  IdentityRiskEvaluatorService,
  type IdentityRiskPlatformClock,
} from './identity-risk-evaluator.service.js'
import type { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { IdentityRiskService } from './identity-risk.service.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const evaluationAt = new Date('2026-09-02T12:00:00.000Z')
const windowStart = new Date('2026-09-02T10:00:00.000Z')
const windowEnd = new Date('2026-09-02T12:00:00.000Z')

function opaqueReference(kind: string, label: string) {
  return `hvr1_${kind}_${createHash('sha256').update(label).digest('hex')}`
}

const platformSubjectId = opaqueReference('subject', 'user-1')

function sourcePayload(
  attributes: readonly Readonly<{ name: 'enabled'; value: boolean }>[] = [],
  reference = 'source-record-1',
): IdentityRiskSourcePayload {
  const enabled = attributes.find((attribute) => attribute.name === 'enabled')?.value
  const candidate = {
    ruleId: 'HV-ID-CHG-005.v1',
    subject: { type: 'USER', opaqueId: platformSubjectId },
    evidenceReferences: [opaqueReference('evidence', reference)],
    evidence: [{ observedAt: evaluationAt.toISOString(), maxAgeHours: 2 }],
    evidenceState: 'COMPLETE',
    change: 'SECURITY_DEFAULTS',
    before: true,
    after: enabled === undefined ? false : !enabled,
    succeeded: true,
  } satisfies ApprovedIdentitySignalCandidate
  return {
    schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
    recordReference: opaqueReference('evidence', reference),
    subjectReference: platformSubjectId,
    candidate,
  }
}

function request(
  detector: IdentitySignalDetector,
  loadSources: IdentityRiskEvaluationRequest['loadSources'] = async () => ({
    context: {
      organizationId,
      customerTenantId: tenantId,
      evaluationAt,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION,
      catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    },
    sourceEnvelopes: [],
    orderedSourceWatermarks: ['directory-0001'],
    earliestSourceExpiry: new Date('2026-10-01T00:00:00.000Z'),
    capability: 'FULL' as const,
  }),
): IdentityRiskEvaluationRequest {
  return {
    organizationId,
    customerTenantId: tenantId,
    engineVersion: IDENTITY_RISK_ENGINE_VERSION,
    catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    windowStart,
    windowEnd,
    evaluationAt,
    loadSources,
    detectors: [detector],
  }
}

function safety(
  state: {
    evaluationHardDisabled?: boolean
    alertDeliveryDisabled?: boolean
    hardDisableEpisodeId?: string | null
    hardDisableScopeType?: 'GLOBAL' | 'TENANT' | null
  } = {},
) {
  const calls = {
    blocked: 0,
    blockedAt: [] as Date[],
    states: 0,
    rejected: [] as string[],
    rejectedAt: [] as Date[],
    activated: [] as Array<Record<string, unknown>>,
  }
  const service = {
    stateForTenant: async () => {
      calls.states += 1
      return {
        evaluationHardDisabled: state.evaluationHardDisabled ?? false,
        alertDeliveryDisabled: state.alertDeliveryDisabled ?? false,
        hardDisableEpisodeId: state.hardDisableEpisodeId ?? null,
        hardDisableScopeType: state.hardDisableScopeType ?? null,
      }
    },
    recordHardStopBlocked: async (input: { now: Date }) => {
      calls.blocked += 1
      calls.blockedAt.push(input.now)
    },
    recordDetectorRejection: async (input: { reasonCode: string; now: Date }) => {
      calls.rejected.push(input.reasonCode)
      calls.rejectedAt.push(input.now)
    },
    activate: async (input: Record<string, unknown>) => {
      calls.activated.push(input)
    },
  } as unknown as IdentityRiskSafetyService
  return { service, calls }
}

function persistence(activeControls: Array<Record<string, unknown>> = []) {
  const calls = {
    runCreates: 0,
    runCreateData: [] as Array<Record<string, unknown>>,
    coverage: [] as Array<Record<string, unknown>>,
    matches: [] as Array<Record<string, unknown>>,
    findings: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    runFailureUpdates: [] as Array<Record<string, unknown>>,
    transactions: 0,
  }
  const transaction = {
    $executeRawUnsafe: async () => [{ pg_advisory_xact_lock: '' }],
    identityRiskOperationalControl: {
      findMany: async () => activeControls,
    },
    identityRiskRuleCoverage: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        calls.coverage.push(create)
        return create
      },
    },
    identityRiskMatchedResult: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        calls.matches.push(create)
        return { id: `matched-${calls.matches.length}`, ...create }
      },
    },
    identityRiskFinding: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        calls.findings.push(create)
        return create
      },
    },
    identityRiskEvaluationRun: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.runCreates += 1
        calls.runCreateData.push(data)
        return { id: '33333333-3333-4333-8333-333333333333' }
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.runUpdates.push(data)
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.runFailureUpdates.push(data)
        return { count: 1 }
      },
    },
    $transaction: async (callback: (value: typeof transaction) => unknown) => {
      calls.transactions += 1
      return callback(transaction)
    },
  } as unknown as PrismaService
  return { prisma, calls }
}

const noMatchDetector: IdentitySignalDetector = {
  ruleId: 'HV-ID-CHG-001.v1',
  evaluate: () => [{
    ruleId: 'HV-ID-CHG-001.v1',
    outcome: 'NOT_MATCHED',
    coverage: 'FULL',
    reasonCodes: ['NO_MATCH'],
    subjectType: 'USER',
    subjectId: platformSubjectId,
  }],
}

test('scheduler wires the complete approved evaluator detector set at its explicit boundary', async () => {
  const captured: { request?: IdentityRiskEvaluationRequest } = {}
  const evaluator = {
    evaluate: async (value: IdentityRiskEvaluationRequest) => {
      captured.request = value
      return { status: 'OFF' as const, runKey: null, alertDeliveryDisabled: true }
    },
  } as unknown as IdentityRiskEvaluatorService
  const original = request(noMatchDetector)
  const { detectors: _detectors, ...platformRequest } = original
  const result = await new IdentityRiskEvaluationScheduler(evaluator).runTenant({
    ...platformRequest,
    approvedEvaluator: { readiness: 'NOT_READY' },
  })
  assert.equal(result.status, 'OFF')
  assert.equal(captured.request?.detectors.length, 22)
  assert.ok(captured.request?.detectors.some(
    (detector) => detector.ruleId === 'HV-ID-CHG-005.v1',
  ))
})

test('scheduler runs the actual approved evaluator through platform persistence', async (context) => {
  // The evaluator already uses this fixture clock; the downstream read API
  // uses Date. Keep both in the same time domain so the fixture cannot age
  // into STALE merely because CI runs more than 36 hours after September 2.
  context.mock.timers.enable({ apis: ['Date'], now: evaluationAt })
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const payload = sourcePayload([{ name: 'enabled', value: true }], 'approved-e2e')
    const original = request(noMatchDetector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [immutableSource(payload)],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    }))
    const { detectors: _detectors, ...platformRequest } = original
    const store = persistence()
    const evaluator = new IdentityRiskEvaluatorService(
      store.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    )
    const result = await new IdentityRiskEvaluationScheduler(evaluator).runTenant({
      ...platformRequest,
      approvedEvaluator: {
        readiness: 'READY',
        featureFlags: { 'HV-ID-CHG-005.v1': true },
      },
    })
    assert.equal(result.status, 'COMPLETED')
    assert.equal(store.calls.coverage.length, 22)
    assert.equal(store.calls.matches.length, 1)
    assert.equal(store.calls.matches[0]?.ruleId, 'HV-ID-CHG-005.v1')
    assert.equal(store.calls.matches[0]?.subjectId, platformSubjectId)
    assert.deepEqual(
      store.calls.matches[0]?.evidence,
      payload.candidate.evidenceReferences,
    )
    assert.equal(store.calls.findings.length, 1)

    const api = new IdentityRiskService({
      user: {
        findUnique: async () => ({
          disabledAt: null,
          memberships: [{ organizationId, role: 'MSP_OWNER' }],
        }),
      },
      customerTenant: {
        findFirst: async () => ({ id: tenantId, organizationId }),
      },
      identityRiskOperationalControl: { findMany: async () => [] },
      identityRiskEvaluationRun: {
        findFirst: async () => ({
          id: '33333333-3333-4333-8333-333333333333',
          engineVersion: IDENTITY_RISK_ENGINE_VERSION,
          catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
          capability: 'FULL',
          completedAt: evaluationAt,
          alertDeliveryDisabled: true,
        }),
      },
      identityRiskFinding: {
        findMany: async () => store.calls.findings.map((findingRow, index) => ({
          id: `finding-${index + 1}`,
          state: 'OPEN',
          ...findingRow,
        })),
      },
    } as unknown as PrismaService)
    const page = await api.findings(
      { subject: 'approved-evaluator-test', email: 'owner@example.test' },
      tenantId,
    )
    assert.equal(page.status, 'AVAILABLE')
    assert.equal(page.findings.length, 1)
    assert.equal(page.findings[0]?.affectedIdentity.id, platformSubjectId)
    assert.equal(page.findings[0]?.ruleIds[0], 'HV-ID-CHG-005.v1')
    assert.equal(JSON.stringify(page).includes('candidateReference'), false)

    // Exercise the real read-path boundary without widening production
    // freshness or masking stale evidence: exactly 36 hours is current;
    // one millisecond later the same persisted evaluation is stale.
    const freshnessBoundary = evaluationAt.getTime() + 36 * 60 * 60 * 1_000
    context.mock.timers.setTime(freshnessBoundary)
    const boundary = await api.findings(
      { subject: 'approved-evaluator-test', email: 'owner@example.test' },
      tenantId,
    )
    assert.equal(boundary.status, 'AVAILABLE')
    assert.equal(boundary.freshness, 'CURRENT')
    context.mock.timers.setTime(freshnessBoundary + 1)
    const stale = await api.findings(
      { subject: 'approved-evaluator-test', email: 'owner@example.test' },
      tenantId,
    )
    assert.equal(stale.status, 'STALE')
    assert.equal(stale.freshness, 'STALE')
    assert.equal(stale.evaluatedAt, evaluationAt.toISOString())
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('scheduler consolidates distinct approved candidates for one subject without false conflict', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const matchedPayload = sourcePayload(
      [{ name: 'enabled', value: true }],
      'approved-matched-candidate',
    )
    const notMatchedPayload = sourcePayload(
      [{ name: 'enabled', value: false }],
      'approved-not-matched-candidate',
    )
    const original = request(noMatchDetector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [
        immutableSource(matchedPayload, { canonicalEventId: 'candidate-match' }),
        immutableSource(notMatchedPayload, { canonicalEventId: 'candidate-no-match' }),
      ],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    }))
    const { detectors: _detectors, ...platformRequest } = original
    const store = persistence()
    const observedSafety = safety()
    const evaluator = new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    )
    const result = await new IdentityRiskEvaluationScheduler(evaluator).runTenant({
      ...platformRequest,
      approvedEvaluator: {
        readiness: 'READY',
        featureFlags: { 'HV-ID-CHG-005.v1': true },
      },
    })
    assert.equal(result.status, 'COMPLETED')
    const coverage = store.calls.coverage.find(
      (row) => row.ruleId === 'HV-ID-CHG-005.v1',
    )
    assert.equal(coverage?.eligibleCount, 2)
    assert.equal(coverage?.matchedCount, 1)
    assert.equal(coverage?.notMatchedCount, 1)
    assert.equal(store.calls.matches.length, 1)
    assert.deepEqual(observedSafety.calls.rejected, [])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

function immutableSource(
  payload: IdentityRiskSourcePayload,
  overrides: Partial<IdentityRiskSourceEnvelope> = {},
): IdentityRiskSourceEnvelope {
  return {
    kind: 'IMMUTABLE_EVENT',
    sourceType: 'DIRECTORY_AUDIT',
    canonicalEventId: 'event-0001',
    authoritativeEventTime: evaluationAt,
    sourceEventVersion: 'v1',
    payload,
    ...overrides,
  } as IdentityRiskSourceEnvelope
}

function snapshotSource(
  observationId: string,
  observedAt: Date,
  payload: IdentityRiskSourcePayload,
): IdentityRiskSourceEnvelope {
  return {
    kind: 'AUTHORITATIVE_SNAPSHOT',
    resourceType: 'USERS',
    objectId: 'object-0001',
    authoritativeObservationId: observationId,
    observedAt,
    projectorSchemaVersion: 'users-v1',
    sourceWatermark: 'directory-0001',
    payload,
  }
}

test('mode is default OFF and only exact lowercase shadow evaluates', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  let sourceReads = 0
  try {
    delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    const first = persistence()
    const firstSafety = safety()
    const evaluator = new IdentityRiskEvaluatorService(first.prisma, firstSafety.service)
    const result = await evaluator.evaluate(request(noMatchDetector, async () => {
      sourceReads += 1
      throw new Error('must not run')
    }))
    assert.equal(result.status, 'OFF')
    process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'SHADOW'
    const second = await evaluator.evaluate(request(noMatchDetector, async () => {
      sourceReads += 1
      throw new Error('must not run')
    }))
    assert.equal(second.status, 'OFF')
    assert.equal(sourceReads, 0)
    assert.equal(first.calls.runCreates, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('hard disable precedes source reads and all risk persistence', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let sourceReads = 0
  try {
    const store = persistence()
    const stop = safety({
      evaluationHardDisabled: true,
      hardDisableEpisodeId: '44444444-4444-4444-8444-444444444444',
      hardDisableScopeType: 'GLOBAL',
    })
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      stop.service,
    ).evaluate(request(noMatchDetector, async () => {
      sourceReads += 1
      throw new Error('must not run')
    }))
    assert.equal(result.status, 'HARD_DISABLED')
    assert.equal(sourceReads, 0)
    assert.equal(store.calls.runCreates, 0)
    assert.equal(store.calls.transactions, 0)
    assert.equal(stop.calls.blocked, 1)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('alert delivery disable still evaluates and persists one matched result', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const evidenceReference = opaqueReference('evidence', 'matched-evidence')
    const store = persistence([{
      controlType: 'ALERT_DELIVERY_DISABLED',
      episodeId: 'mute-episode',
      scopeType: 'TENANT',
    }])
    const mute = safety({ alertDeliveryDisabled: true })
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => [{
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'MATCHED',
        coverage: 'FULL',
        reasonCodes: ['RULE_MATCHED'],
        subjectType: 'USER',
        subjectId: platformSubjectId,
        evidenceReferences: [evidenceReference],
        sourceLabels: ['Microsoft Entra directory audit'],
        severity: 'HIGH',
        confidence: 'HIGH',
        observedAt: evaluationAt,
      }],
    }
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      mute.service,
    ).evaluate(request(detector))
    assert.equal(result.status, 'COMPLETED')
    assert.equal(result.alertDeliveryDisabled, true)
    assert.equal(store.calls.matches.length, 1)
    assert.deepEqual(store.calls.matches[0]?.evidence, [evidenceReference])
    assert.equal(store.calls.findings.length, 1)
    assert.equal(store.calls.coverage.length, 1)
    assert.equal(store.calls.runUpdates[0]?.alertDeliveryDisabled, true)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('same completed run is replayed without detectors or persistence', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let detectorCalls = 0
  try {
    const transaction = {
      $executeRawUnsafe: async () => [],
      identityRiskOperationalControl: { findMany: async () => [] },
      identityRiskEvaluationRun: {
        findUnique: async () => ({
          id: 'existing',
          status: 'COMPLETED',
          leaseExpiresAt: null,
          sourceContentHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        }),
      },
    }
    const prisma = {
      $transaction: async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
    } as unknown as PrismaService
    const detector = {
      ...noMatchDetector,
      evaluate: () => { detectorCalls += 1; return [] },
    }
    const result = await new IdentityRiskEvaluatorService(
      prisma,
      safety().service,
    ).evaluate(request(detector))
    assert.equal(result.status, 'REPLAYED')
    assert.equal(detectorCalls, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('watermark order is canonical and duplicates are rejected', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let storedRun: null | {
    id: string
    runKey: string
    status: string
    leaseExpiresAt: Date | null
    sourceContentHash: string
  } = null
  let createCalls = 0
  let detectorCalls = 0
  let transactionCalls = 0
  const runKeys: string[] = []
  const transaction = {
    $executeRawUnsafe: async () => [],
    identityRiskOperationalControl: { findMany: async () => [] },
    identityRiskRuleCoverage: { upsert: async () => ({}) },
    identityRiskMatchedResult: { upsert: async () => ({ id: 'unexpected' }) },
    identityRiskFinding: { upsert: async () => ({}) },
    identityRiskEvaluationRun: {
      findUnique: async () => storedRun,
      create: async ({ data }: { data: {
        runKey: string
        sourceContentHash: string
        leaseExpiresAt: Date
      } }) => {
        createCalls += 1
        runKeys.push(data.runKey)
        storedRun = {
          id: '33333333-3333-4333-8333-333333333333',
          runKey: data.runKey,
          status: 'RUNNING',
          leaseExpiresAt: data.leaseExpiresAt,
          sourceContentHash: data.sourceContentHash,
        }
        return { id: storedRun.id }
      },
      updateMany: async ({ data }: { data: { status?: string } }) => {
        if (storedRun && data.status) storedRun.status = data.status
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: {
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback: (value: typeof transaction) => unknown) => {
      transactionCalls += 1
      return callback(transaction)
    },
  } as unknown as PrismaService
  const detector: IdentitySignalDetector = {
    ...noMatchDetector,
    evaluate: () => {
      detectorCalls += 1
      return noMatchDetector.evaluate({} as never)
    },
  }
  const load = (orderedSourceWatermarks: readonly string[]) => async () => ({
    context: {
      organizationId,
      customerTenantId: tenantId,
      evaluationAt,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION,
      catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    },
    sourceEnvelopes: [],
    orderedSourceWatermarks,
    earliestSourceExpiry: null,
    capability: 'FULL' as const,
  })
  try {
    const evaluator = new IdentityRiskEvaluatorService(prisma, safety().service)
    const first = await evaluator.evaluate(request(detector, load(['source-b', 'source-a'])))
    const second = await evaluator.evaluate(request(detector, load(['source-a', 'source-b'])))
    assert.equal(first.status, 'COMPLETED')
    assert.equal(second.status, 'REPLAYED')
    assert.equal(createCalls, 1)
    assert.equal(runKeys.length, 1)
    assert.equal(detectorCalls, 1)
    assert.equal(transactionCalls, 3)

    await assert.rejects(
      () => evaluator.evaluate(request(detector, load(['source-a', 'source-a']))),
      /source contract is invalid/,
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('canonical source identities dedupe exact events and hard-stop same-watermark content conflicts', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let storedRun: {
    id: string
    runKey: string
    sourceContentHash: string
    status: string
    leaseExpiresAt: Date | null
  } | null = null
  let detectorCalls = 0
  let projectedRows = 0
  const calls = { coverage: 0, matches: 0, findings: 0 }
  const transaction = {
    $executeRawUnsafe: async () => [],
    identityRiskOperationalControl: { findMany: async () => [] },
    identityRiskEvaluationRun: {
      findUnique: async () => storedRun,
      create: async ({ data }: { data: {
        runKey: string
        sourceContentHash: string
        leaseExpiresAt: Date
      } }) => {
        storedRun = {
          id: '33333333-3333-4333-8333-333333333333',
          runKey: data.runKey,
          sourceContentHash: data.sourceContentHash,
          status: 'RUNNING',
          leaseExpiresAt: data.leaseExpiresAt,
        }
        return { id: storedRun.id }
      },
      updateMany: async ({ data }: { data: { status?: string } }) => {
        if (storedRun && data.status) storedRun.status = data.status
        return { count: 1 }
      },
    },
    identityRiskRuleCoverage: {
      upsert: async () => { calls.coverage += 1; return {} },
    },
    identityRiskMatchedResult: {
      upsert: async () => { calls.matches += 1; return { id: 'matched' } },
    },
    identityRiskFinding: {
      upsert: async () => { calls.findings += 1; return {} },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
  } as unknown as PrismaService
  const observedSafety = safety()
  const detector: IdentitySignalDetector = {
    ...noMatchDetector,
    evaluate: (context) => {
      detectorCalls += 1
      projectedRows = context.sources.DIRECTORY_AUDIT?.length ?? 0
      return noMatchDetector.evaluate(context)
    },
  }
  const load = (payload: IdentityRiskSourcePayload, duplicate = false) =>
    async () => {
      const envelope = immutableSource(payload)
      return {
        context: {
          organizationId,
          customerTenantId: tenantId,
          evaluationAt,
          engineVersion: IDENTITY_RISK_ENGINE_VERSION,
          catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
        },
        sourceEnvelopes: duplicate ? [envelope, envelope] : [envelope],
        orderedSourceWatermarks: ['directory-0001'],
        earliestSourceExpiry: null,
        capability: 'FULL' as const,
      }
    }
  try {
    const evaluator = new IdentityRiskEvaluatorService(
      prisma,
      observedSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    )
    const first = await evaluator.evaluate(request(
      detector,
      load(sourcePayload([{ name: 'enabled', value: true }]), true),
    ))
    const conflict = await evaluator.evaluate(request(
      detector,
      load(sourcePayload([{ name: 'enabled', value: false }])),
    ))
    assert.equal(first.status, 'COMPLETED')
    assert.equal(projectedRows, 1)
    assert.equal(conflict.status, 'HARD_DISABLED')
    assert.equal(conflict.runKey, null)
    assert.equal(detectorCalls, 1)
    assert.equal(calls.coverage, 1)
    assert.equal(calls.matches, 0)
    assert.equal(calls.findings, 0)
    assert.equal(observedSafety.calls.activated.length, 1)
    assert.equal(
      observedSafety.calls.activated[0]?.reasonCode,
      'SOURCE_INTEGRITY_CONFLICT',
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('immutable event time and source version are part of the canonical identity', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const store = persistence()
    const observedSafety = safety()
    const first = immutableSource(
      sourcePayload([{ name: 'enabled', value: true }], 'immutable-v1'),
    )
    const sameVersionDifferentTime = immutableSource(
      sourcePayload([{ name: 'enabled', value: false }], 'immutable-later-time'),
      {
        authoritativeEventTime: new Date(evaluationAt.getTime() - 1_000),
      },
    )
    const sameTimeDifferentVersion = immutableSource(
      sourcePayload([{ name: 'enabled', value: false }], 'immutable-v2'),
      {
        sourceEventVersion: 'v2',
      },
    )
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [first, sameVersionDifferentTime, sameTimeDifferentVersion],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    })))
    assert.equal(result.status, 'COMPLETED')
    assert.equal(store.calls.runCreates, 1)
    assert.equal(store.calls.transactions, 2)
    assert.equal(observedSafety.calls.activated.length, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('same immutable identity with conflicting content hard-stops before claim', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const store = persistence()
    const observedSafety = safety()
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [
        immutableSource(
          sourcePayload([{ name: 'enabled', value: true }], 'conflict-a'),
        ),
        immutableSource(
          sourcePayload([{ name: 'enabled', value: false }], 'conflict-b'),
        ),
      ],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    })))
    assert.equal(result.status, 'HARD_DISABLED')
    assert.equal(store.calls.runCreates, 0)
    assert.equal(store.calls.transactions, 0)
    assert.equal(
      observedSafety.calls.activated[0]?.reasonCode,
      'SOURCE_INTEGRITY_CONFLICT',
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('secret-bearing and unapproved source payloads hard-stop before detector execution', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let detectorCalls = 0
  try {
    const store = persistence()
    const observedSafety = safety()
    const detector = {
      ...noMatchDetector,
      evaluate: () => {
        detectorCalls += 1
        return noMatchDetector.evaluate({} as never)
      },
    }
    const unsafePayload = {
      ...sourcePayload(),
      access_token: ['ARRAYSECRET1'],
    } as never
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(detector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [immutableSource(unsafePayload)],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    })))
    assert.equal(result.status, 'HARD_DISABLED')
    assert.equal(detectorCalls, 0)
    assert.equal(store.calls.runCreates, 0)
    assert.equal(store.calls.matches.length, 0)
    assert.equal(store.calls.findings.length, 0)
    assert.equal(observedSafety.calls.activated[0]?.reasonCode, 'SECRET_EXPOSURE')
    assert.ok(!JSON.stringify(observedSafety.calls).includes('ARRAYSECRET1'))
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('hostile and Microsoft risk source aliases fail closed without prototype pollution', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    for (const sourceType of [
      '__PROTO__',
      'CONSTRUCTOR',
      'RISKY_USERS',
      'IDENTITY_RISK_USERS',
      'USER_RISK_STATE',
      'MSFT_RISK',
      'MICROSOFT_ENTRA_RISK_DETECTIONS',
      'AAD_IDENTITY_PROTECTION',
      'ENTRA_ID_PROTECTION',
      'UNRECOGNIZED_BUT_WELL_FORMED',
    ]) {
      const store = persistence()
      const observedSafety = safety()
      const result = await new IdentityRiskEvaluatorService(
        store.prisma,
        observedSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request(noMatchDetector, async () => ({
        context: {
          organizationId,
          customerTenantId: tenantId,
          evaluationAt,
          engineVersion: IDENTITY_RISK_ENGINE_VERSION,
          catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
        },
        sourceEnvelopes: [immutableSource(sourcePayload(), { sourceType })],
        orderedSourceWatermarks: ['directory-0001'],
        earliestSourceExpiry: null,
        capability: 'FULL',
      })))
      assert.equal(result.status, 'HARD_DISABLED', sourceType)
      assert.equal(store.calls.runCreates, 0, sourceType)
      assert.equal(observedSafety.calls.activated[0]?.reasonCode, 'SECRET_EXPOSURE')
    }
    assert.equal(
      (Object.prototype as unknown as Record<string, unknown>).polluted,
      undefined,
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('wrong-kind candidate references are rejected before detector execution', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const base = sourcePayload()
    const unsafeCandidates = [
      {
        ...base.candidate,
        subject: { type: 'USER', opaqueId: opaqueReference('evidence', 'wrong-user') },
      },
      {
        ...base.candidate,
        subject: { type: 'APPLICATION', opaqueId: opaqueReference('mailbox', 'wrong-app') },
      },
      {
        ...base.candidate,
        evidenceReferences: [opaqueReference('subject', 'wrong-evidence')],
      },
    ]
    for (const candidate of unsafeCandidates) {
      let detectorCalls = 0
      const detector: IdentitySignalDetector = {
        ...noMatchDetector,
        evaluate: (projected) => {
          detectorCalls += 1
          return noMatchDetector.evaluate(projected)
        },
      }
      const store = persistence()
      const observedSafety = safety()
      const result = await new IdentityRiskEvaluatorService(
        store.prisma,
        observedSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request(detector, async () => ({
        context: {
          organizationId,
          customerTenantId: tenantId,
          evaluationAt,
          engineVersion: IDENTITY_RISK_ENGINE_VERSION,
          catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
        },
        sourceEnvelopes: [immutableSource({
          ...base,
          subjectReference: (candidate.subject as { opaqueId: string }).opaqueId,
          candidate,
        } as never)],
        orderedSourceWatermarks: ['directory-0001'],
        earliestSourceExpiry: null,
        capability: 'FULL',
      })))
      assert.equal(result.status, 'HARD_DISABLED')
      assert.equal(detectorCalls, 0)
      assert.equal(store.calls.runCreates, 0)
      assert.equal(observedSafety.calls.activated[0]?.reasonCode, 'SECRET_EXPOSURE')
    }
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('closed source catalog accepts application credential metadata without keyword filtering', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const applicationId = opaqueReference('application', 'approved-app')
    const payload = {
      schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
      recordReference: opaqueReference('observation', 'approved-app-snapshot'),
      subjectReference: applicationId,
      candidate: {
        ruleId: 'HV-ID-APP-002.v1',
        subject: { type: 'APPLICATION', opaqueId: applicationId },
        evidenceReferences: [opaqueReference('evidence', 'approved-app-evidence')],
        evidence: [{ observedAt: evaluationAt.toISOString(), maxAgeHours: 2 }],
        evidenceState: 'COMPLETE',
        applicationPermissionIds: [],
        credentialMetadataChanged: true,
        authoritativeComparable: true,
        succeeded: true,
      },
    } satisfies IdentityRiskSourcePayload
    let projectedRows = 0
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: (projected) => {
        projectedRows = projected.sources.APPLICATIONS?.length ?? 0
        return noMatchDetector.evaluate(projected)
      },
    }
    const store = persistence()
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(detector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [{
        ...snapshotSource('approved-app-observation', evaluationAt, payload),
        resourceType: 'APPLICATIONS',
      }],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    })))
    assert.equal(result.status, 'COMPLETED')
    assert.equal(projectedRows, 1)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('source type and per-type record limits are enforced independently', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const load = (sourceEnvelopes: IdentityRiskSourceEnvelope[]) => async () => ({
    context: {
      organizationId,
      customerTenantId: tenantId,
      evaluationAt,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION,
      catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    },
    sourceEnvelopes,
    orderedSourceWatermarks: ['directory-0001'],
    earliestSourceExpiry: null,
    capability: 'FULL' as const,
  })
  try {
    const tooManyTypes = Array.from({ length: 33 }, (_, index) =>
      immutableSource(
        sourcePayload([], `type-${index}`),
        {
          sourceType: `SOURCE_${String(index).padStart(2, '0')}`,
          canonicalEventId: `event-${index}`,
        },
      ),
    )
    const typeStore = persistence()
    const typeResult = await new IdentityRiskEvaluatorService(
      typeStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector, load(tooManyTypes)))
    assert.equal(typeResult.status, 'HARD_DISABLED')
    assert.equal(typeStore.calls.runCreates, 0)

    const tooManyRecords = Array.from({ length: 50_001 }, (_, index) =>
      immutableSource(
        sourcePayload([], `record-${index}`),
        { canonicalEventId: `event-${index}` },
      ),
    )
    const recordStore = persistence()
    const recordResult = await new IdentityRiskEvaluatorService(
      recordStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector, load(tooManyRecords)))
    assert.equal(recordResult.status, 'HARD_DISABLED')
    assert.equal(recordStore.calls.runCreates, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('later authoritative snapshot observations may carry changed content', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let projected: readonly IdentityRiskSourcePayload[] = []
  try {
    const detector: IdentitySignalDetector = {
      ...noMatchDetector,
      evaluate: (context) => {
        projected = context.sources.USERS ?? []
        return noMatchDetector.evaluate(context)
      },
    }
    const store = persistence()
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(detector, async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [
        snapshotSource(
          'observation-0001',
          new Date(evaluationAt.getTime() - 60_000),
          sourcePayload([{ name: 'enabled', value: false }], 'snapshot-1'),
        ),
        snapshotSource(
          'observation-0002',
          evaluationAt,
          sourcePayload([{ name: 'enabled', value: true }], 'snapshot-2'),
        ),
      ],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL',
    })))
    assert.equal(result.status, 'COMPLETED')
    assert.deepEqual(projected, [
      sourcePayload([{ name: 'enabled', value: false }], 'snapshot-1'),
      sourcePayload([{ name: 'enabled', value: true }], 'snapshot-2'),
    ])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('hard-disable transitions are rechecked after loading, at claim, and atomically before persistence', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const hardControl = {
    controlType: 'EVALUATION_HARD_DISABLED',
    episodeId: 'hard-stop-episode',
    scopeType: 'TENANT',
  }
  try {
    const afterLoadStore = persistence()
    let stateReads = 0
    const afterLoadSafety = safety()
    ;(afterLoadSafety.service as unknown as {
      stateForTenant: () => Promise<Record<string, unknown>>
    }).stateForTenant = async () => ({
      evaluationHardDisabled: ++stateReads >= 2,
      alertDeliveryDisabled: false,
      hardDisableEpisodeId: 'hard-stop-episode',
      hardDisableScopeType: 'TENANT',
    })
    const afterLoad = await new IdentityRiskEvaluatorService(
      afterLoadStore.prisma,
      afterLoadSafety.service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector))
    assert.equal(afterLoad.status, 'HARD_DISABLED')
    assert.equal(afterLoadStore.calls.runCreates, 0)

    const atClaimStore = persistence([hardControl])
    const atClaim = await new IdentityRiskEvaluatorService(
      atClaimStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector))
    assert.equal(atClaim.status, 'HARD_DISABLED')
    assert.equal(atClaimStore.calls.runCreates, 0)

    const controls: Array<Record<string, unknown>> = []
    const beforePersistStore = persistence(controls)
    const detector: IdentitySignalDetector = {
      ...noMatchDetector,
      evaluate: (context) => {
        controls.push(hardControl)
        return noMatchDetector.evaluate(context)
      },
    }
    const beforePersist = await new IdentityRiskEvaluatorService(
      beforePersistStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(detector))
    assert.equal(beforePersist.status, 'HARD_DISABLED')
    assert.equal(beforePersistStore.calls.coverage.length, 0)
    assert.equal(beforePersistStore.calls.matches.length, 0)
    assert.equal(beforePersistStore.calls.findings.length, 0)
    assert.equal(beforePersistStore.calls.runUpdates[0]?.status, 'FAILED')
    assert.equal(
      beforePersistStore.calls.runUpdates[0]?.failureCode,
      'EVALUATION_HARD_DISABLED',
    )

    const muteControls: Array<Record<string, unknown>> = []
    const muteStore = persistence(muteControls)
    const muteDetector: IdentitySignalDetector = {
      ...noMatchDetector,
      evaluate: (context) => {
        muteControls.push({
          controlType: 'ALERT_DELIVERY_DISABLED',
          episodeId: 'mute-episode',
          scopeType: 'TENANT',
        })
        return noMatchDetector.evaluate(context)
      },
    }
    const muted = await new IdentityRiskEvaluatorService(
      muteStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(muteDetector))
    assert.equal(muted.status, 'COMPLETED')
    assert.equal(muted.alertDeliveryDisabled, true)
    assert.equal(muteStore.calls.runUpdates[0]?.alertDeliveryDisabled, true)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('exact duplicate matched outputs count and persist once while conflicts fail closed', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const matched = {
    ruleId: 'HV-ID-CHG-001.v1',
    outcome: 'MATCHED' as const,
    coverage: 'FULL' as const,
    reasonCodes: ['RULE_MATCHED'],
    subjectType: 'USER' as const,
    subjectId: platformSubjectId,
    candidateReference: opaqueReference('contribution', 'same-candidate'),
    severity: 'HIGH' as const,
    confidence: 'HIGH' as const,
    observedAt: evaluationAt,
  }
  try {
    const duplicateStore = persistence()
    await new IdentityRiskEvaluatorService(
      duplicateStore.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request({
      ruleId: matched.ruleId,
      evaluate: () => [matched, matched],
    }))
    assert.equal(duplicateStore.calls.matches.length, 1)
    assert.equal(duplicateStore.calls.findings.length, 1)
    assert.equal(duplicateStore.calls.coverage[0]?.matchedCount, 1)

    const conflictStore = persistence()
    const observedSafety = safety()
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        conflictStore.prisma,
        observedSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request({
        ruleId: matched.ruleId,
        evaluate: () => [matched, { ...matched, severity: 'MEDIUM' }],
      })),
      /evaluation failed/,
    )
    assert.equal(conflictStore.calls.coverage.length, 0)
    assert.equal(conflictStore.calls.matches.length, 0)
    assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_CONFLICT'])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('all detector outcomes dedupe before counters and conflicting duplicates fail closed', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const result = (
    outcome: 'NOT_MATCHED' | 'SUPPRESSED' | 'NOT_EVALUATED',
    label: string,
    reasonCode: string,
  ) => Object.freeze({
    ruleId: 'HV-ID-CHG-001.v1',
    outcome,
    coverage: outcome === 'NOT_EVALUATED' ? 'PARTIAL' as const : 'FULL' as const,
    reasonCodes: Object.freeze([reasonCode]),
    subjectType: 'USER' as const,
    subjectId: opaqueReference('subject', label),
  })
  try {
    const notMatched = result('NOT_MATCHED', 'not-matched', 'NO_MATCH')
    const suppressed = result('SUPPRESSED', 'suppressed', 'APPROVED_SHARED_CONTEXT')
    const notEvaluated = result('NOT_EVALUATED', 'not-evaluated', 'EVIDENCE_PARTIAL')
    const store = persistence()
    await new IdentityRiskEvaluatorService(
      store.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request({
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => [
        notMatched,
        notMatched,
        suppressed,
        suppressed,
        notEvaluated,
        notEvaluated,
      ],
    }))
    assert.equal(store.calls.coverage[0]?.eligibleCount, 2)
    assert.equal(store.calls.coverage[0]?.notMatchedCount, 1)
    assert.equal(store.calls.coverage[0]?.suppressedCount, 1)
    assert.equal(store.calls.coverage[0]?.notEvaluatedCount, 1)

    const conflictStore = persistence()
    const observedSafety = safety()
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        conflictStore.prisma,
        observedSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request({
        ruleId: 'HV-ID-CHG-001.v1',
        evaluate: () => [
          notMatched,
          { ...notMatched, coverage: 'PARTIAL', reasonCodes: ['EVIDENCE_PARTIAL'] },
        ],
      })),
      /evaluation failed/,
    )
    assert.equal(conflictStore.calls.coverage.length, 0)
    assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_CONFLICT'])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('platform clock rejects future evaluation before safety, source, or risk writes', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const platformNow = new Date('2026-09-02T12:00:00.000Z')
  const clock = { now: () => platformNow } as IdentityRiskPlatformClock
  try {
    const acceptedAt = new Date(
      platformNow.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
    )
    const acceptedStore = persistence()
    const acceptedSafety = safety()
    let detectorEvaluationAt: Date | null = null
    const acceptedLoader = async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt: acceptedAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL' as const,
    })
    const boundaryDetector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: (context) => {
        detectorEvaluationAt = context.evaluationAt
        return [{
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'MATCHED',
        coverage: 'FULL',
        reasonCodes: ['RULE_MATCHED'],
        subjectType: 'USER',
        subjectId: opaqueReference('subject', 'boundary'),
        severity: 'HIGH',
        confidence: 'HIGH',
        observedAt: acceptedAt,
        }]
      },
    }
    const accepted = await new IdentityRiskEvaluatorService(
      acceptedStore.prisma,
      acceptedSafety.service,
      clock,
    ).evaluate({
      ...request(boundaryDetector, acceptedLoader),
      windowStart: platformNow,
      windowEnd: acceptedAt,
      evaluationAt: acceptedAt,
    })
    assert.equal(accepted.status, 'COMPLETED')
    assert.deepEqual(detectorEvaluationAt, platformNow)
    assert.equal(acceptedStore.calls.matches.length, 1)
    assert.deepEqual(acceptedStore.calls.runCreateData[0]?.createdAt, platformNow)
    assert.deepEqual(
      acceptedStore.calls.runCreateData[0]?.leaseExpiresAt,
      acceptedAt,
    )
    assert.deepEqual(
      acceptedStore.calls.runCreateData[0]?.expiresAt,
      new Date(platformNow.getTime() + 7 * 24 * 60 * 60 * 1_000),
    )
    assert.deepEqual(acceptedStore.calls.coverage[0]?.createdAt, platformNow)
    assert.deepEqual(acceptedStore.calls.matches[0]?.createdAt, platformNow)
    assert.deepEqual(acceptedStore.calls.findings[0]?.createdAt, platformNow)
    assert.deepEqual(acceptedStore.calls.findings[0]?.updatedAt, platformNow)
    assert.deepEqual(acceptedStore.calls.runUpdates[0]?.completedAt, platformNow)

    const futureObservedStore = persistence()
    const futureObservedSafety = safety()
    const futureObservedDetector: IdentitySignalDetector = {
      ...boundaryDetector,
      evaluate: () => [{
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'MATCHED',
        coverage: 'FULL',
        reasonCodes: ['RULE_MATCHED'],
        subjectType: 'USER',
        subjectId: opaqueReference('subject', 'too-future'),
        severity: 'HIGH',
        confidence: 'HIGH',
        observedAt: new Date(
          acceptedAt.getTime() + IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
        ),
      }],
    }
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        futureObservedStore.prisma,
        futureObservedSafety.service,
        clock,
      ).evaluate({
        ...request(futureObservedDetector, acceptedLoader),
        windowStart: platformNow,
        windowEnd: acceptedAt,
        evaluationAt: acceptedAt,
      }),
      /evaluation failed/,
    )
    assert.equal(futureObservedStore.calls.matches.length, 0)
    assert.equal(futureObservedStore.calls.findings.length, 0)
    assert.equal(futureObservedStore.calls.coverage.length, 0)
    assert.equal(futureObservedStore.calls.transactions, 1)
    assert.equal(futureObservedStore.calls.runFailureUpdates[0]?.status, 'FAILED')
    assert.deepEqual(futureObservedSafety.calls.rejected, ['FUTURE_TIMESTAMP'])
    assert.deepEqual(futureObservedSafety.calls.rejectedAt, [platformNow])

    const hardStop = safety({
      evaluationHardDisabled: true,
      hardDisableEpisodeId: '44444444-4444-4444-8444-444444444444',
      hardDisableScopeType: 'TENANT',
    })
    await new IdentityRiskEvaluatorService(
      persistence().prisma,
      hardStop.service,
      clock,
    ).evaluate({
      ...request(noMatchDetector, acceptedLoader),
      windowStart: platformNow,
      windowEnd: acceptedAt,
      evaluationAt: acceptedAt,
    })
    assert.deepEqual(hardStop.calls.blockedAt, [platformNow])

    const scopeFailure = safety()
    await new IdentityRiskEvaluatorService(
      persistence().prisma,
      scopeFailure.service,
      clock,
    ).evaluate({
      ...request(noMatchDetector, async () => ({
        ...(await acceptedLoader()),
        context: {
          ...(await acceptedLoader()).context,
          organizationId: '99999999-9999-4999-8999-999999999999',
        },
      })),
      windowStart: platformNow,
      windowEnd: acceptedAt,
      evaluationAt: acceptedAt,
    })
    assert.deepEqual(scopeFailure.calls.activated[0]?.now, platformNow)

    let sourceReads = 0
    const rejectedStore = persistence()
    const rejectedSafety = safety()
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        rejectedStore.prisma,
        rejectedSafety.service,
        clock,
      ).evaluate({
        ...request(noMatchDetector, async () => {
          sourceReads += 1
          throw new Error('must not run')
        }),
        evaluationAt: new Date(acceptedAt.getTime() + 1),
      }),
      /evaluation request is invalid/,
    )
    assert.equal(rejectedSafety.calls.states, 0)
    assert.equal(sourceReads, 0)
    assert.equal(rejectedStore.calls.runCreates, 0)
    assert.equal(rejectedStore.calls.transactions, 0)

    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        rejectedStore.prisma,
        rejectedSafety.service,
        clock,
      ).evaluate({
        ...request(noMatchDetector, async () => {
          sourceReads += 1
          throw new Error('must not run')
        }),
        windowStart: platformNow,
        windowEnd: new Date(acceptedAt.getTime() + 1),
        evaluationAt: acceptedAt,
      }),
      /evaluation request is invalid/,
    )
    assert.equal(rejectedSafety.calls.states, 0)
    assert.equal(sourceReads, 0)
    assert.equal(rejectedStore.calls.runCreates, 0)

    delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        rejectedStore.prisma,
        rejectedSafety.service,
        clock,
      ).evaluate({
        ...request(noMatchDetector, async () => {
          sourceReads += 1
          throw new Error('must not run')
        }),
        evaluationAt: new Date(acceptedAt.getTime() + 1),
      }),
      /evaluation request is invalid/,
    )
    assert.equal(sourceReads, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('active lease makes a concurrent duplicate return in progress', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const transaction = {
      $executeRawUnsafe: async () => [],
      identityRiskOperationalControl: { findMany: async () => [] },
      identityRiskEvaluationRun: {
        findUnique: async () => ({
          id: 'existing',
          status: 'RUNNING',
          leaseExpiresAt: new Date(evaluationAt.getTime() + 60_000),
          sourceContentHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        }),
      },
    }
    const prisma = {
      $transaction: async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
    } as unknown as PrismaService
    const result = await new IdentityRiskEvaluatorService(
      prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(noMatchDetector))
    assert.equal(result.status, 'IN_PROGRESS')
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('failed run retry reclaims one lease and completes through idempotent upserts', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let leaseClaims = 0
  const calls = {
    coverage: 0,
    runCompletions: 0,
  }
  const transaction = {
    $executeRawUnsafe: async () => [],
    identityRiskOperationalControl: { findMany: async () => [] },
    identityRiskRuleCoverage: {
      upsert: async () => {
        calls.coverage += 1
        return {}
      },
    },
    identityRiskMatchedResult: { upsert: async () => ({ id: 'unexpected' }) },
    identityRiskFinding: { upsert: async () => ({}) },
    identityRiskEvaluationRun: {
      findUnique: async () => ({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'FAILED',
        leaseExpiresAt: null,
        sourceContentHash:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
      updateMany: async ({ data }: { data: { status?: string } }) => {
        if (data.status === 'RUNNING') leaseClaims += 1
        if (data.status === 'COMPLETED') calls.runCompletions += 1
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
  } as unknown as PrismaService
  try {
    const result = await new IdentityRiskEvaluatorService(
      prisma,
      safety().service,
    ).evaluate(request(noMatchDetector))
    assert.equal(result.status, 'COMPLETED')
    assert.equal(leaseClaims, 1)
    assert.equal(calls.coverage, 1)
    assert.equal(calls.runCompletions, 1)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('malformed detector output fails the run with one safe event and no completion artifacts', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const store = persistence()
    const observedSafety = safety()
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => [{
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'MATCHED',
        coverage: 'FULL',
        reasonCodes: ['RULE_MATCHED'],
        subjectType: 'USER',
        subjectId: platformSubjectId,
        severity: 'HIGH',
        confidence: 'HIGH',
        observedAt: evaluationAt,
        explanation: 'detector-controlled text is forbidden',
      } as never],
    }
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        store.prisma,
        observedSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request(detector)),
      /evaluation failed/,
    )
    assert.equal(store.calls.matches.length, 0)
    assert.equal(store.calls.findings.length, 0)
    assert.equal(store.calls.coverage.length, 0)
    assert.equal(store.calls.transactions, 1)
    assert.equal(store.calls.runFailureUpdates[0]?.status, 'FAILED')
    assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_INVALID'])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('raw or secret-shaped detector subjects never reach persistence', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    for (const subjectId of ['ARRAYSECRET1', 'person@example.com', 'opaque-user-1']) {
      const store = persistence()
      const observedSafety = safety()
      const detector: IdentitySignalDetector = {
        ruleId: 'HV-ID-CHG-001.v1',
        evaluate: () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          outcome: 'MATCHED',
          coverage: 'FULL',
          reasonCodes: ['RULE_MATCHED'],
          subjectType: 'USER',
          subjectId,
          severity: 'HIGH',
          confidence: 'HIGH',
          observedAt: evaluationAt,
        }],
      }
      await assert.rejects(
        () => new IdentityRiskEvaluatorService(
          store.prisma,
          observedSafety.service,
          { now: () => evaluationAt } as IdentityRiskPlatformClock,
        ).evaluate(request(detector)),
        /evaluation failed/,
      )
      assert.equal(store.calls.matches.length, 0, subjectId)
      assert.equal(store.calls.findings.length, 0, subjectId)
      assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_INVALID'])
      assert.ok(!JSON.stringify(store.calls).includes(subjectId))
    }
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('wrong-kind detector subject and evidence references never reach persistence', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const invalidResults = [
      {
        subjectType: 'USER',
        subjectId: opaqueReference('evidence', 'wrong-user-kind'),
        evidenceReferences: [opaqueReference('evidence', 'valid-evidence')],
      },
      {
        subjectType: 'APPLICATION',
        subjectId: opaqueReference('mailbox', 'wrong-application-kind'),
        evidenceReferences: [opaqueReference('evidence', 'valid-app-evidence')],
      },
      {
        subjectType: 'USER',
        subjectId: platformSubjectId,
        evidenceReferences: [opaqueReference('subject', 'wrong-evidence-kind')],
      },
    ]
    for (const invalid of invalidResults) {
      const store = persistence()
      const observedSafety = safety()
      await assert.rejects(
        () => new IdentityRiskEvaluatorService(
          store.prisma,
          observedSafety.service,
          { now: () => evaluationAt } as IdentityRiskPlatformClock,
        ).evaluate(request({
          ruleId: 'HV-ID-CHG-001.v1',
          evaluate: () => [{
            ruleId: 'HV-ID-CHG-001.v1',
            outcome: 'MATCHED',
            coverage: 'FULL',
            reasonCodes: ['RULE_MATCHED'],
            ...invalid,
            severity: 'HIGH',
            confidence: 'HIGH',
            observedAt: evaluationAt,
          } as never],
        })),
        /evaluation failed/,
      )
      assert.equal(store.calls.matches.length, 0)
      assert.equal(store.calls.findings.length, 0)
      assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_INVALID'])
    }
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('future timestamps beyond five minutes fail while the trusted exact boundary matches', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const atBoundary = persistence()
    const boundaryResult = {
      ruleId: 'HV-ID-CHG-001.v1',
      outcome: 'MATCHED' as const,
      coverage: 'FULL' as const,
      reasonCodes: ['RULE_MATCHED'],
      subjectType: 'USER' as const,
      subjectId: platformSubjectId,
      severity: 'HIGH' as const,
      confidence: 'HIGH' as const,
      observedAt: new Date(evaluationAt.getTime() + 5 * 60 * 1_000),
    }
    const detectorAtBoundary: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => [boundaryResult],
    }
    await new IdentityRiskEvaluatorService(
      atBoundary.prisma,
      safety().service,
      { now: () => evaluationAt } as IdentityRiskPlatformClock,
    ).evaluate(request(detectorAtBoundary))
    assert.equal(atBoundary.calls.matches.length, 1)

    const tooFuture = persistence()
    const futureSafety = safety()
    const detectorTooFuture: IdentitySignalDetector = {
      ...detectorAtBoundary,
      evaluate: () => [{
        ...boundaryResult,
        observedAt: new Date(evaluationAt.getTime() + 5 * 60 * 1_000 + 1),
      }],
    }
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(
        tooFuture.prisma,
        futureSafety.service,
        { now: () => evaluationAt } as IdentityRiskPlatformClock,
      ).evaluate(request(detectorTooFuture)),
      /evaluation failed/,
    )
    assert.equal(tooFuture.calls.matches.length, 0)
    assert.equal(tooFuture.calls.coverage.length, 0)
    assert.equal(tooFuture.calls.transactions, 1)
    assert.equal(tooFuture.calls.runFailureUpdates[0]?.status, 'FAILED')
    assert.deepEqual(futureSafety.calls.rejected, ['FUTURE_TIMESTAMP'])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('50,000 non-matches persist one run and one coverage row, never subject rows', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const store = persistence()
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => Array.from({ length: 50_000 }, (_, index) => ({
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'NOT_MATCHED' as const,
        coverage: 'FULL' as const,
        reasonCodes: ['NO_MATCH'],
        subjectType: 'USER' as const,
        subjectId: `hvr1_subject_${index.toString(16).padStart(64, '0')}`,
      })),
    }
    await new IdentityRiskEvaluatorService(
      store.prisma,
      safety().service,
    ).evaluate(request(detector))
    assert.equal(store.calls.runCreates, 1)
    assert.equal(store.calls.coverage.length, 1)
    assert.equal(store.calls.coverage[0]?.notMatchedCount, 50_000)
    assert.equal(store.calls.matches.length, 0)
    assert.equal(store.calls.findings.length, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('source scope mismatch hard-stops without run or detector writes', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const store = persistence()
    const observedSafety = safety()
    const mismatchedLoader = async () => ({
      context: {
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        customerTenantId: tenantId,
        evaluationAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      },
      sourceEnvelopes: [],
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL' as const,
    })
    const result = await new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
    ).evaluate(request(noMatchDetector, mismatchedLoader))
    assert.equal(result.status, 'HARD_DISABLED')
    assert.equal(observedSafety.calls.activated.length, 1)
    assert.deepEqual(observedSafety.calls.activated[0]?.scope, { type: 'GLOBAL' })
    assert.equal(store.calls.runCreates, 0)
    assert.equal(store.calls.transactions, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('empty detector sets and malformed source containers are rejected before run writes', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const empty = persistence()
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(empty.prisma, safety().service).evaluate({
        ...request(noMatchDetector),
        detectors: [],
      }),
      /evaluation request is invalid/,
    )
    assert.equal(empty.calls.runCreates, 0)

    const malformed = persistence()
    const inheritedContext = Object.assign(Object.create({ inherited: true }), {
      organizationId,
      customerTenantId: tenantId,
      evaluationAt,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION,
      catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
    })
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(malformed.prisma, safety().service).evaluate(
        request(noMatchDetector, async () => ({
          context: inheritedContext as never,
          sourceEnvelopes: [],
          orderedSourceWatermarks: ['directory-0001'],
          earliestSourceExpiry: null,
          capability: 'FULL',
        })),
      ),
      /source contract is invalid/,
    )
    assert.equal(malformed.calls.runCreates, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})
