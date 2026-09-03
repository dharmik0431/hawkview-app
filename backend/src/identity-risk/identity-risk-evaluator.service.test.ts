import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_CATALOG_VERSION,
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
  type IdentityRiskEvaluationRequest,
  type IdentitySignalDetector,
} from './identity-risk.contract.js'
import {
  IdentityRiskEvaluatorService,
  type IdentityRiskPlatformClock,
} from './identity-risk-evaluator.service.js'
import type { IdentityRiskSafetyService } from './identity-risk-safety.service.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const evaluationAt = new Date('2026-09-02T12:00:00.000Z')
const windowStart = new Date('2026-09-02T10:00:00.000Z')
const windowEnd = new Date('2026-09-02T12:00:00.000Z')

function request(
  detector: IdentitySignalDetector,
  loadSources: IdentityRiskEvaluationRequest['loadSources'] = async () => ({
    context: {
      organizationId,
      customerTenantId: tenantId,
      evaluationAt,
      engineVersion: IDENTITY_RISK_ENGINE_VERSION,
      catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
      sources: {},
    },
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
    states: 0,
    rejected: [] as string[],
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
    recordHardStopBlocked: async () => { calls.blocked += 1 },
    recordDetectorRejection: async (input: { reasonCode: string }) => {
      calls.rejected.push(input.reasonCode)
    },
    activate: async (input: Record<string, unknown>) => {
      calls.activated.push(input)
    },
  } as unknown as IdentityRiskSafetyService
  return { service, calls }
}

function persistence() {
  const calls = {
    runCreates: 0,
    coverage: [] as Array<Record<string, unknown>>,
    matches: [] as Array<Record<string, unknown>>,
    findings: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    transactions: 0,
  }
  const transaction = {
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
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.runUpdates.push(data)
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: {
      create: async () => {
        calls.runCreates += 1
        return { id: '33333333-3333-4333-8333-333333333333' }
      },
      updateMany: async () => ({ count: 1 }),
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
  }],
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
    const store = persistence()
    const mute = safety({ alertDeliveryDisabled: true })
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => [{
        ruleId: 'HV-ID-CHG-001.v1',
        outcome: 'MATCHED',
        coverage: 'FULL',
        subjectType: 'USER',
        subjectId: 'opaque-user-1',
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
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' })
    const prisma = {
      identityRiskEvaluationRun: {
        create: async () => { throw conflict },
        findUnique: async () => ({ id: 'existing', status: 'COMPLETED', leaseExpiresAt: null }),
      },
      $transaction: async () => { throw new Error('unexpected transaction') },
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
  const conflict = Object.assign(new Error('unique'), { code: 'P2002' })
  let completed = false
  let createCalls = 0
  let detectorCalls = 0
  let transactionCalls = 0
  const runKeys: string[] = []
  const transaction = {
    identityRiskRuleCoverage: { upsert: async () => ({}) },
    identityRiskMatchedResult: { upsert: async () => ({ id: 'unexpected' }) },
    identityRiskFinding: { upsert: async () => ({}) },
    identityRiskEvaluationRun: {
      updateMany: async () => {
        completed = true
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: {
      create: async ({ data }: { data: { runKey: string } }) => {
        createCalls += 1
        runKeys.push(data.runKey)
        if (createCalls > 1) throw conflict
        return { id: '33333333-3333-4333-8333-333333333333' }
      },
      findUnique: async () => ({
        id: '33333333-3333-4333-8333-333333333333',
        status: completed ? 'COMPLETED' : 'RUNNING',
        leaseExpiresAt: null,
      }),
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
      sources: {},
    },
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
    assert.equal(runKeys[0], runKeys[1])
    assert.equal(detectorCalls, 1)
    assert.equal(transactionCalls, 1)

    await assert.rejects(
      () => evaluator.evaluate(request(detector, load(['source-a', 'source-a']))),
      /source contract is invalid/,
    )
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
    const acceptedLoader = async () => ({
      context: {
        organizationId,
        customerTenantId: tenantId,
        evaluationAt: acceptedAt,
        engineVersion: IDENTITY_RISK_ENGINE_VERSION,
        catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
        sources: {},
      },
      orderedSourceWatermarks: ['directory-0001'],
      earliestSourceExpiry: null,
      capability: 'FULL' as const,
    })
    const accepted = await new IdentityRiskEvaluatorService(
      acceptedStore.prisma,
      acceptedSafety.service,
      clock,
    ).evaluate({
      ...request(noMatchDetector, acceptedLoader),
      windowStart: platformNow,
      windowEnd: acceptedAt,
      evaluationAt: acceptedAt,
    })
    assert.equal(accepted.status, 'COMPLETED')

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
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' })
    const prisma = {
      identityRiskEvaluationRun: {
        create: async () => { throw conflict },
        findUnique: async () => ({
          id: 'existing',
          status: 'RUNNING',
          leaseExpiresAt: new Date(evaluationAt.getTime() + 60_000),
        }),
      },
    } as unknown as PrismaService
    const result = await new IdentityRiskEvaluatorService(
      prisma,
      safety().service,
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
  const conflict = Object.assign(new Error('unique'), { code: 'P2002' })
  let leaseClaims = 0
  const calls = {
    coverage: 0,
    runCompletions: 0,
  }
  const transaction = {
    identityRiskRuleCoverage: {
      upsert: async () => {
        calls.coverage += 1
        return {}
      },
    },
    identityRiskMatchedResult: { upsert: async () => ({ id: 'unexpected' }) },
    identityRiskFinding: { upsert: async () => ({}) },
    identityRiskEvaluationRun: {
      updateMany: async () => {
        calls.runCompletions += 1
        return { count: 1 }
      },
    },
  }
  const prisma = {
    identityRiskEvaluationRun: {
      create: async () => { throw conflict },
      findUnique: async () => ({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'FAILED',
        leaseExpiresAt: null,
      }),
      updateMany: async () => {
        leaseClaims += 1
        return { count: 1 }
      },
    },
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

test('malformed detector output becomes bounded NOT_EVALUATED with no finding', async () => {
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
        subjectType: 'USER',
        subjectId: 'opaque-user-1',
        severity: 'HIGH',
        confidence: 'HIGH',
        observedAt: evaluationAt,
        explanation: 'detector-controlled text is forbidden',
      } as never],
    }
    await new IdentityRiskEvaluatorService(
      store.prisma,
      observedSafety.service,
    ).evaluate(request(detector))
    assert.equal(store.calls.matches.length, 0)
    assert.equal(store.calls.findings.length, 0)
    assert.equal(store.calls.coverage[0]?.notEvaluatedCount, 1)
    assert.deepEqual(observedSafety.calls.rejected, ['DETECTOR_OUTPUT_INVALID'])
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('future timestamps beyond five minutes abstain while the exact boundary matches', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  try {
    const atBoundary = persistence()
    const boundaryResult = {
      ruleId: 'HV-ID-CHG-001.v1',
      outcome: 'MATCHED' as const,
      coverage: 'FULL' as const,
      subjectType: 'USER' as const,
      subjectId: 'opaque-user-1',
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
    await new IdentityRiskEvaluatorService(
      tooFuture.prisma,
      futureSafety.service,
    ).evaluate(request(detectorTooFuture))
    assert.equal(tooFuture.calls.matches.length, 0)
    assert.equal(tooFuture.calls.coverage[0]?.notEvaluatedCount, 1)
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
    const result = Object.freeze({
      ruleId: 'HV-ID-CHG-001.v1',
      outcome: 'NOT_MATCHED' as const,
      coverage: 'FULL' as const,
    })
    const detector: IdentitySignalDetector = {
      ruleId: 'HV-ID-CHG-001.v1',
      evaluate: () => new Array(50_000).fill(result),
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
        sources: {},
      },
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
    const inheritedSources = Object.create({ inherited: [] }) as Record<string, unknown>
    await assert.rejects(
      () => new IdentityRiskEvaluatorService(malformed.prisma, safety().service).evaluate(
        request(noMatchDetector, async () => ({
          context: {
            organizationId,
            customerTenantId: tenantId,
            evaluationAt,
            engineVersion: IDENTITY_RISK_ENGINE_VERSION,
            catalogVersion: IDENTITY_RISK_CATALOG_VERSION,
            sources: inheritedSources as never,
          },
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
