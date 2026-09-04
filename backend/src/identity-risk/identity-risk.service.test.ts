import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { beforeEach, afterEach } from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service.js'
import { IdentityRiskService } from './identity-risk.service.js'

const identity = { subject: 'auth-user', email: 'owner@example.com' }
const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'

const pilotKeys = ['HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER', 'HAWKVIEW_IDENTITY_RISK_ENVIRONMENT', 'HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE'] as const
let previousPilot: Array<string | undefined> = []
beforeEach(() => {
  previousPilot = pilotKeys.map((key) => process.env[key])
  process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'wrapped-pilot-v1'
  process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
  process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE = JSON.stringify({ organizationId, customerTenantId: tenantId, expiresAt: new Date(Date.now() + 86400000).toISOString() })
})
afterEach(() => pilotKeys.forEach((key, index) => {
  if (previousPilot[index] === undefined) delete process.env[key]
  else process.env[key] = previousPilot[index]
}))

function opaqueSubject(label: string) {
  return `hvr1_subject_${createHash('sha256').update(label).digest('hex')}`
}

function scoped(overrides: Record<string, unknown> = {}) {
  const models = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [{ timezone: 'UTC' }],
    user: {
      findUnique: async () => ({
        disabledAt: null,
        memberships: [{ organizationId, role: 'MSP_OWNER' }],
      }),
    },
    customerTenant: {
      findFirst: async () => ({ id: tenantId, organizationId }),
    },
    syncState: {
      findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: new Date() }),
    },
    identityRiskOperationalControl: {
      findMany: async () => [],
    },
    ...overrides,
  }
  return { ...models, $transaction: overrides.$transaction ?? (async (callback: (transaction: typeof models) => unknown) => callback(models)) } as unknown as PrismaService
}

function currentRun(now: Date) {
  return {
    id: runId,
    engineVersion: 'hawkview-identity-engine/1',
    catalogVersion: 'hawkview-identity-signals/v1',
    capability: 'FULL',
    completedAt: now,
    alertDeliveryDisabled: true,
  }
}

function finding(index: number, observedAt: Date) {
  return {
    id: `finding-${String(index).padStart(3, '0')}`,
    state: 'OPEN',
    severity: 'HIGH',
    confidence: 'HIGH',
    coverage: 'FULL',
    ruleId: 'HV-ID-CHG-001.v1',
    subjectType: 'USER',
    subjectId: opaqueSubject(`identity-${String(index).padStart(3, '0')}`),
    observedAt,
    explanation: { token: 'must never be projected' },
    matchedResult: { evidence: [] },
  }
}

test('default OFF returns stable empty envelopes without risk-table reads', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousDisplay = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
  delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  let riskReads = 0
  try {
    const prisma = scoped({
      identityRiskEvaluationRun: {
        findFirst: async () => { riskReads += 1; throw new Error('unexpected') },
      },
      tenantEntraSnapshot: {
        findFirst: async () => { riskReads += 1; throw new Error('unexpected') },
      },
    })
    const service = new IdentityRiskService(prisma)
    const summary = await service.summary(identity, tenantId)
    const findings = await service.findings(identity, tenantId)
    const microsoft = await service.microsoftRiskyUsers(identity, tenantId)
    assert.equal(summary.status, 'UNAVAILABLE')
    assert.equal(summary.counts.identitiesNeedingReview.exact, false)
    assert.deepEqual(findings.pageInfo, { hasMore: false, nextCursor: null })
    assert.deepEqual(microsoft.users, [])
    assert.equal(riskReads, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
    if (previousDisplay === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previousDisplay
    }
  }
})

test('cross-organization tenant access is denied before evidence reads', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let evidenceReads = 0
  try {
    const prisma = scoped({
      customerTenant: { findFirst: async () => null },
      identityRiskEvaluationRun: {
        findFirst: async () => { evidenceReads += 1; return null },
      },
    })
    await assert.rejects(
      () => new IdentityRiskService(prisma).findings(identity, tenantId),
      ForbiddenException,
    )
    assert.equal(evidenceReads, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('active hard-disable hides prior HawkView summaries, lists, and details before evidence reads', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let riskReads = 0
  try {
    const prisma = scoped({
      identityRiskOperationalControl: {
        findMany: async () => [{ controlType: 'EVALUATION_HARD_DISABLED' }],
      },
      identityRiskEvaluationRun: {
        findFirst: async () => { riskReads += 1; return null },
      },
      identityRiskFinding: {
        findMany: async () => { riskReads += 1; return [] },
        findFirst: async () => { riskReads += 1; return null },
      },
    })
    const service = new IdentityRiskService(prisma)
    const summary = await service.summary(identity, tenantId)
    const findings = await service.findings(identity, tenantId)
    const detail = await service.findingDetail(identity, tenantId, 'finding-001')
    assert.equal(summary.status, 'UNAVAILABLE')
    assert.equal(findings.status, 'UNAVAILABLE')
    assert.equal(detail.status, 'UNAVAILABLE')
    assert.deepEqual(findings.findings, [])
    assert.equal(detail.finding, null)
    assert.equal(riskReads, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('a hard-disable activated during reads suppresses every HawkView projection', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  const controlModel = () => {
    let reads = 0
    return {
      findMany: async () => ++reads === 1
        ? []
        : [{ controlType: 'EVALUATION_HARD_DISABLED' }],
    }
  }
  const coverage = [{
    ruleId: 'HV-ID-CHG-001.v1',
    matchedCount: 1,
    suppressedCount: 0,
    notMatchedCount: 0,
    notEvaluatedCount: 0,
    matchedCountCapped: false,
    suppressedCountCapped: false,
    notMatchedCountCapped: false,
    notEvaluatedCountCapped: false,
  }]
  try {
    const base = {
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: { findMany: async () => coverage },
      identityRiskFinding: {
        count: async () => 1,
        findMany: async (args: { distinct?: unknown }) =>
          args.distinct ? [{ subjectId: opaqueSubject('identity-001'), subjectType: 'USER' }] : [finding(1, now)],
        findFirst: async () => finding(1, now),
      },
    }
    const summary = await new IdentityRiskService(scoped({
      ...base,
      identityRiskOperationalControl: controlModel(),
    })).summary(identity, tenantId)
    const findings = await new IdentityRiskService(scoped({
      ...base,
      identityRiskOperationalControl: controlModel(),
    })).findings(identity, tenantId)
    const detail = await new IdentityRiskService(scoped({
      ...base,
      identityRiskOperationalControl: controlModel(),
    })).findingDetail(identity, tenantId, 'finding-001')
    assert.equal(summary.status, 'UNAVAILABLE')
    assert.deepEqual(summary.counts.openFindings, {
      value: 0, exact: false, capped: false,
    })
    assert.equal(findings.status, 'UNAVAILABLE')
    assert.deepEqual(findings.findings, [])
    assert.equal(detail.status, 'UNAVAILABLE')
    assert.equal(detail.finding, null)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('current alert mute is reflected across HawkView projections without another evaluation', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousSecret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET =
    'unit-test-only-cursor-secret-at-least-32-bytes'
  const now = new Date()
  try {
    const prisma = scoped({
      identityRiskOperationalControl: {
        findMany: async () => [{ controlType: 'ALERT_DELIVERY_DISABLED' }],
      },
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: {
        findMany: async () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          matchedCount: 1,
          suppressedCount: 0,
          notMatchedCount: 0,
          notEvaluatedCount: 0,
          matchedCountCapped: false,
          suppressedCountCapped: false,
          notMatchedCountCapped: false,
          notEvaluatedCountCapped: false,
        }],
      },
      identityRiskFinding: {
        count: async () => 1,
        findMany: async (args: { distinct?: unknown }) =>
          args.distinct ? [{ subjectId: opaqueSubject('identity-001'), subjectType: 'USER' }] : [finding(1, now)],
        findFirst: async () => finding(1, now),
      },
    })
    const service = new IdentityRiskService(prisma)
    const summary = await service.summary(identity, tenantId)
    const findings = await service.findings(identity, tenantId)
    const detail = await service.findingDetail(identity, tenantId, 'finding-001')
    for (const projection of [summary, findings, detail]) {
      assert.match(projection.limitation ?? '', /delivery is disabled/)
    }
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
    if (previousSecret === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previousSecret
  }
})

test('summary and findings use one completed run and server-owned bounded wording', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousSecret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = 'unit-test-only-cursor-secret-at-least-32-bytes'
  const now = new Date()
  let findingsWhere: unknown
  try {
    const rows = [finding(1, now)]
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: {
        findMany: async () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          matchedCount: 1,
          suppressedCount: 0,
          notMatchedCount: 25,
          notEvaluatedCount: 0,
          matchedCountCapped: false,
          suppressedCountCapped: false,
          notMatchedCountCapped: false,
          notEvaluatedCountCapped: false,
        }],
      },
      identityRiskFinding: {
        count: async () => 1,
        findMany: async (args: { where: unknown; distinct?: unknown }) => {
          if (args.distinct) return [{ subjectId: opaqueSubject('identity-001'), subjectType: 'USER' }]
          findingsWhere = args.where
          return rows
        },
      },
    })
    const service = new IdentityRiskService(prisma)
    const summary = await service.summary(identity, tenantId)
    const page = await service.findings(identity, tenantId)
    assert.equal(summary.engineVersion, 'hawkview-identity-engine/1')
    assert.equal(summary.catalogVersion, 'hawkview-identity-signals/v1')
    assert.equal(summary.evaluatedAt, now.toISOString())
    assert.deepEqual(summary.counts.identitiesNeedingReview, {
      value: 1, exact: true, capped: false,
    })
    assert.equal(page.evaluatedAt, summary.evaluatedAt)
    assert.equal(page.findings[0]?.ruleIds[0], 'HV-ID-CHG-001.v1')
    assert.equal(
      page.findings[0]?.explanation,
      'An authoritative lifecycle event was followed by a privileged access assignment within the versioned rule window.',
    )
    assert.equal(JSON.stringify(page).includes('must never be projected'), false)
    assert.equal(
      (findingsWhere as { organizationId?: unknown }).organizationId,
      organizationId,
    )
    assert.equal(
      (findingsWhere as { customerTenantId?: unknown }).customerTenantId,
      tenantId,
    )
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
    if (previousSecret === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previousSecret
  }
})

test('an unavailable post-sync evaluator run serializes as not evaluated, never available', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  try {
    const prisma = scoped({
      identityRiskEvaluationRun: {
        findFirst: async () => ({ ...currentRun(now), capability: 'UNAVAILABLE' }),
      },
      identityRiskFinding: { findMany: async () => [] },
    })
    const page = await new IdentityRiskService(prisma).findings(identity, tenantId)
    assert.equal(page.status, 'NOT_EVALUATED')
    assert.equal(page.capability, 'UNAVAILABLE')
    assert.equal(page.freshness, 'UNKNOWN')
    assert.equal(page.observedAt, null)
    assert.match(page.limitation ?? '', /source evidence is not available/)
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
  }
})

test('raw or secret-shaped stored subjects fail closed at every HawkView API projection', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  const unsafeFinding = { ...finding(1, now), subjectId: 'ARRAYSECRET1' }
  try {
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: {
        findMany: async () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          matchedCount: 1,
          suppressedCount: 0,
          notMatchedCount: 0,
          notEvaluatedCount: 0,
          matchedCountCapped: false,
          suppressedCountCapped: false,
          notMatchedCountCapped: false,
          notEvaluatedCountCapped: false,
        }],
      },
      identityRiskFinding: {
        count: async () => 1,
        findMany: async (args: { distinct?: unknown }) =>
          args.distinct ? [{ subjectId: 'ARRAYSECRET1', subjectType: 'USER' }] : [unsafeFinding],
        findFirst: async () => unsafeFinding,
      },
    })
    const service = new IdentityRiskService(prisma)
    const summary = await service.summary(identity, tenantId)
    const findings = await service.findings(identity, tenantId)
    const detail = await service.findingDetail(identity, tenantId, unsafeFinding.id)
    assert.equal(summary.status, 'ERROR')
    assert.equal(summary.counts.identitiesNeedingReview.exact, false)
    assert.equal(findings.status, 'ERROR')
    assert.deepEqual(findings.findings, [])
    assert.equal(detail.status, 'ERROR')
    assert.equal(detail.finding, null)
    assert.ok(!JSON.stringify([summary, findings, detail]).includes('ARRAYSECRET1'))
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
  }
})

test('API projections reject wrong-kind subject and evidence references', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  const opaque = (kind: string, label: string) =>
    `hvr1_${kind}_${createHash('sha256').update(label).digest('hex')}`
  try {
    const cases = [
      {
        row: { ...finding(1, now), subjectId: opaque('evidence', 'wrong-user') },
        evidence: [],
        listError: true,
      },
      {
        row: {
          ...finding(2, now),
          subjectType: 'APPLICATION',
          subjectId: opaque('mailbox', 'wrong-application'),
        },
        evidence: [],
        listError: true,
      },
      {
        row: finding(3, now),
        evidence: [opaque('subject', 'wrong-evidence')],
        listError: false,
      },
    ]
    for (const entry of cases) {
      const row = {
        ...entry.row,
        matchedResult: { evidence: entry.evidence },
      }
      const prisma = scoped({
        identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
        identityRiskFinding: {
          findMany: async () => [row],
          findFirst: async () => row,
        },
      })
      const service = new IdentityRiskService(prisma)
      const page = await service.findings(identity, tenantId)
      const detail = await service.findingDetail(identity, tenantId, row.id)
      assert.equal(page.status, entry.listError ? 'ERROR' : 'AVAILABLE')
      assert.equal(page.findings.length, entry.listError ? 0 : 1)
      assert.equal(detail.status, 'ERROR')
      assert.equal(detail.finding, null)
      assert.deepEqual(detail.evidenceReferences, [])
    }
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
  }
})

test('findings use default 50 pagination and disclose a scoped cursor', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousSecret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = 'unit-test-only-cursor-secret-at-least-32-bytes'
  const now = new Date()
  try {
    const rows = Array.from({ length: 51 }, (_, index) =>
      finding(index, new Date(now.getTime() - index * 1_000)),
    )
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskFinding: { findMany: async () => rows },
    })
    const page = await new IdentityRiskService(prisma).findings(identity, tenantId)
    assert.equal(page.findings.length, 50)
    assert.equal(page.pageInfo.hasMore, true)
    assert.match(page.pageInfo.nextCursor ?? '', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.doesNotMatch(page.pageInfo.nextCursor ?? '', new RegExp(tenantId, 'i'))
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
    if (previousSecret === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previousSecret
  }
})

test('a findings cursor is rejected after the latest evaluation run changes', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousSecret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET =
    'unit-test-only-cursor-secret-at-least-32-bytes'
  const now = new Date()
  try {
    const rows = Array.from({ length: 51 }, (_, index) =>
      finding(index, new Date(now.getTime() - index * 1_000)),
    )
    const first = await new IdentityRiskService(scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskFinding: { findMany: async () => rows },
    })).findings(identity, tenantId)
    assert.ok(first.pageInfo.nextCursor)

    let findingReads = 0
    const nextRun = { ...currentRun(now), id: '44444444-4444-4444-8444-444444444444' }
    await assert.rejects(
      () => new IdentityRiskService(scoped({
        identityRiskEvaluationRun: { findFirst: async () => nextRun },
        identityRiskFinding: {
          findMany: async () => { findingReads += 1; return [] },
        },
      })).findings(identity, tenantId, { cursor: first.pageInfo.nextCursor }),
      /Pagination cursor is invalid/,
    )
    assert.equal(findingReads, 0)
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
    if (previousSecret === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previousSecret
  }
})

test('summary labels capped database and unique-subject counts explicitly', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  try {
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: {
        findMany: async () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          matchedCount: 1_000_000,
          suppressedCount: 0,
          notMatchedCount: 1,
          notEvaluatedCount: 0,
          matchedCountCapped: true,
          suppressedCountCapped: false,
          notMatchedCountCapped: false,
          notEvaluatedCountCapped: false,
        }],
      },
      identityRiskFinding: {
        count: async () => 10_001,
        findMany: async () => Array.from(
          { length: 10_001 },
          (_, index) => ({ subjectId: opaqueSubject(`identity-${index}`), subjectType: 'USER' }),
        ),
      },
    })
    const summary = await new IdentityRiskService(prisma).summary(identity, tenantId)
    assert.deepEqual(summary.counts.openFindings, {
      value: 10_000, exact: false, capped: true,
    })
    assert.deepEqual(summary.counts.identitiesNeedingReview, {
      value: 10_000, exact: false, capped: true,
    })
    assert.deepEqual(summary.counts.matchedResults, {
      value: 10_000, exact: false, capped: true,
    })
    assert.deepEqual(summary.counts.suppressedResults, {
      value: 0, exact: true, capped: false,
    })
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('a corrupt capped-zero coverage row fails closed instead of rendering at least zero', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  try {
    const summary = await new IdentityRiskService(scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskRuleCoverage: {
        findMany: async () => [{
          ruleId: 'HV-ID-CHG-001.v1',
          matchedCount: 0,
          suppressedCount: 0,
          notMatchedCount: 0,
          notEvaluatedCount: 0,
          matchedCountCapped: true,
          suppressedCountCapped: false,
          notMatchedCountCapped: false,
          notEvaluatedCountCapped: false,
        }],
      },
      identityRiskFinding: {
        count: async () => 0,
        findMany: async () => [],
      },
    })).summary(identity, tenantId)
    assert.equal(summary.status, 'ERROR')
    assert.deepEqual(summary.counts.matchedResults, {
      value: 0, exact: false, capped: false,
    })
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('Microsoft projection stays separate, bounded, tenant-opaque, and exact', async () => {
  const previousDisplay = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = 'true'
  const now = new Date()
  try {
    const prisma = scoped({
      syncState: {
        findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: now }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({
          observedAt: now,
          payload: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            userDisplayName: 'Example User',
            userPrincipalName: 'user@example.com',
            riskLevel: 'high',
            riskState: 'atRisk',
            riskDetail: 'adminConfirmedUserCompromised',
            riskLastUpdatedDateTime: now.toISOString(),
            rawSecret: 'must not escape',
          }],
        }),
      },
    })
    const page = await new IdentityRiskService(prisma).microsoftRiskyUsers(
      identity,
      tenantId,
    )
    assert.equal(page.channel, 'MICROSOFT_ENTRA_RISKY_USERS')
    assert.equal(page.engineVersion, null)
    assert.equal(page.users.length, 1)
    assert.match(page.users[0]?.id ?? '', /^msru_[a-f0-9]{32}$/)
    assert.deepEqual(Object.keys(page.users[0] ?? {}).sort(), [
      'id', 'identityLabel', 'observedAt', 'riskDetail', 'riskLevel', 'riskState',
    ])
    assert.equal(JSON.stringify(page).includes('rawSecret'), false)
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previousDisplay
    }
  }
})

test('Microsoft results use the same default 50 page and scoped cursor contract', async () => {
  const previousDisplay = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  const previousSecret = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = 'true'
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET =
    'unit-test-only-cursor-secret-at-least-32-bytes'
  const now = new Date()
  try {
    const payload = Array.from({ length: 51 }, (_, index) => ({
      id: `microsoft-risk-${String(index).padStart(3, '0')}`,
      userDisplayName: `Example User ${index}`,
      riskLevel: 'medium',
      riskState: 'atRisk',
      riskDetail: 'none',
      riskLastUpdatedDateTime: new Date(now.getTime() - index * 1_000).toISOString(),
    }))
    const prisma = scoped({
      syncState: {
        findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: now }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({ observedAt: now, payload }),
      },
    })
    const page = await new IdentityRiskService(prisma).microsoftRiskyUsers(
      identity,
      tenantId,
    )
    assert.equal(page.users.length, 50)
    assert.equal(page.pageInfo.hasMore, true)
    assert.match(page.pageInfo.nextCursor ?? '', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.equal(page.evaluatedAt, now.toISOString())
    assert.equal(page.observedAt, now.toISOString())
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previousDisplay
    }
    if (previousSecret === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previousSecret
  }
})

test('only a fresh successful Microsoft collection may report an exact empty result', async () => {
  const previous = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = 'true'
  try {
    const emptyNow = new Date()
    const empty = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({
          status: 'SUCCEEDED',
          lastSuccessfulAt: emptyNow,
        }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({ payload: [], observedAt: emptyNow }),
      },
    }))
    const emptyResult = await empty.microsoftRiskyUsers(identity, tenantId)
    assert.equal(emptyResult.status, 'AVAILABLE')
    assert.equal(emptyResult.capability, 'FULL')
    assert.deepEqual(emptyResult.users, [])
    assert.deepEqual(emptyResult.pageInfo, { hasMore: false, nextCursor: null })

    const future = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({
          status: 'SUCCEEDED',
          lastSuccessfulAt: new Date(Date.now() + 5 * 60 * 1_000 + 5_000),
        }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({
          payload: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            riskLevel: 'none',
            riskState: 'none',
          }],
          observedAt: new Date(Date.now() + 5 * 60 * 1_000 + 5_000),
        }),
      },
    }))
    const futureResult = await future.microsoftRiskyUsers(identity, tenantId)
    assert.equal(futureResult.status, 'ERROR')
    assert.deepEqual(futureResult.users, [])

    const reference = new Date()
    const compounded = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({
          status: 'SUCCEEDED',
          lastSuccessfulAt: new Date(reference.getTime() + 4 * 60 * 1_000),
        }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({
          payload: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            riskLevel: 'none',
            riskState: 'none',
            riskLastUpdatedDateTime: new Date(
              reference.getTime() + 8 * 60 * 1_000,
            ).toISOString(),
          }],
          observedAt: new Date(reference.getTime() + 4 * 60 * 1_000),
        }),
      },
    }))
    const compoundedResult = await compounded.microsoftRiskyUsers(identity, tenantId)
    assert.equal(compoundedResult.status, 'ERROR')
    assert.deepEqual(compoundedResult.users, [])

    const staleAt = new Date(Date.now() - 37 * 60 * 60 * 1_000)
    const stale = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: staleAt }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({ payload: [], observedAt: staleAt }),
      },
    }))
    const staleResult = await stale.microsoftRiskyUsers(identity, tenantId)
    assert.equal(staleResult.status, 'UNAVAILABLE')
    assert.deepEqual(staleResult.users, [])
  } finally {
    if (previous === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previous
    }
  }
})

test('failed Microsoft collection and malformed risk detail fail closed', async () => {
  const previous = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = 'true'
  const now = new Date()
  const payload = [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    riskLevel: 'high',
    riskState: 'atRisk',
    riskLastUpdatedDateTime: now.toISOString(),
  }]
  try {
    const failed = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({ status: 'FAILED', lastSuccessfulAt: now }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({ payload, observedAt: now }),
      },
    }))
    const failedResult = await failed.microsoftRiskyUsers(identity, tenantId)
    assert.equal(failedResult.status, 'ERROR')
    assert.deepEqual(failedResult.users, [])

    const malformed = new IdentityRiskService(scoped({
      syncState: {
        findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: now }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => ({
          observedAt: now,
          payload: [{ ...payload[0], riskDetail: { secret: 'forbidden' } }],
        }),
      },
    }))
    const malformedResult = await malformed.microsoftRiskyUsers(identity, tenantId)
    assert.equal(malformedResult.status, 'ERROR')
    assert.deepEqual(malformedResult.users, [])
  } finally {
    if (previous === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previous
    }
  }
})

test('HawkView evaluation and Microsoft display use independent default-off gates', async () => {
  const previousMode = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  const previousDisplay = process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
  let hawkViewReads = 0
  let microsoftReads = 0
  try {
    process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
    delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    const microsoftOff = new IdentityRiskService(scoped({
      tenantEntraSnapshot: {
        findFirst: async () => {
          microsoftReads += 1
          return null
        },
      },
    }))
    const microsoftOffResult = await microsoftOff.microsoftRiskyUsers(identity, tenantId)
    assert.equal(microsoftOffResult.status, 'UNAVAILABLE')
    assert.equal(microsoftReads, 0)

    delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = 'true'
    const now = new Date()
    const microsoftOn = new IdentityRiskService(scoped({
      identityRiskEvaluationRun: {
        findFirst: async () => {
          hawkViewReads += 1
          return null
        },
      },
      syncState: {
        findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: now }),
      },
      tenantEntraSnapshot: {
        findFirst: async () => {
          microsoftReads += 1
          return { payload: [], observedAt: now }
        },
      },
    }))
    const summary = await microsoftOn.summary(identity, tenantId)
    const microsoftOnResult = await microsoftOn.microsoftRiskyUsers(identity, tenantId)
    assert.equal(summary.status, 'UNAVAILABLE')
    assert.equal(hawkViewReads, 0)
    assert.equal(microsoftOnResult.status, 'AVAILABLE')
    assert.equal(microsoftReads, 1)
  } finally {
    if (previousMode === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previousMode
    if (previousDisplay === undefined) {
      delete process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED
    } else {
      process.env.HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED = previousDisplay
    }
  }
})

test('finding detail requires owner or admin and remains tenant scoped', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  let findingReads = 0
  try {
    const prisma = scoped({
      user: {
        findUnique: async () => ({
          disabledAt: null,
          memberships: [{ organizationId, role: 'MSP_TECHNICIAN' }],
        }),
      },
      identityRiskFinding: {
        findFirst: async () => { findingReads += 1; return null },
      },
    })
    await assert.rejects(
      () => new IdentityRiskService(prisma).findingDetail(identity, tenantId, 'finding-001'),
      ForbiddenException,
    )
    assert.equal(findingReads, 0)
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('owner finding detail is bounded, catalog-owned, and scoped to the same run', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  let where: unknown
  try {
    const evidenceReference = `hvr1_evidence_${'b'.repeat(64)}`
    const row = {
      ...finding(1, now),
      matchedResult: { evidence: [evidenceReference] },
    }
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskFinding: {
        findFirst: async (args: { where: unknown }) => {
          where = args.where
          return row
        },
      },
    })
    const detail = await new IdentityRiskService(prisma).findingDetail(
      identity,
      tenantId,
      row.id,
    )
    assert.equal(detail.finding?.id, row.id)
    assert.deepEqual(detail.evidenceReferences, [evidenceReference])
    assert.equal(JSON.stringify(detail).includes('must never be projected'), false)
    assert.equal((where as { organizationId?: unknown }).organizationId, organizationId)
    assert.equal((where as { customerTenantId?: unknown }).customerTenantId, tenantId)
    assert.equal(
      (where as { matchedResult?: { evaluationRunId?: unknown } }).matchedResult
        ?.evaluationRunId,
      runId,
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('finding detail rejects stored evidence that is raw, secret-shaped, duplicated, or over limit', async () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_MODE
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  const now = new Date()
  const unsafeEvidence = [
    'ARRAYSECRET1',
    `hvr1_evidence_${'c'.repeat(64)}`,
  ]
  try {
    const prisma = scoped({
      identityRiskEvaluationRun: { findFirst: async () => currentRun(now) },
      identityRiskFinding: {
        findFirst: async () => ({
          ...finding(1, now),
          matchedResult: { evidence: unsafeEvidence },
        }),
      },
    })
    const detail = await new IdentityRiskService(prisma).findingDetail(
      identity,
      tenantId,
      'finding-001',
    )
    assert.equal(detail.status, 'ERROR')
    assert.equal(detail.finding, null)
    assert.deepEqual(detail.evidenceReferences, [])
    assert.ok(!JSON.stringify(detail).includes('ARRAYSECRET1'))
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_MODE
    else process.env.HAWKVIEW_IDENTITY_RISK_MODE = previous
  }
})

test('retention pruning is ordered and scoped by both organization and tenant', async () => {
  const calls: Array<{ model: string; where: unknown }> = []
  const deleteModel = (model: string) => ({
    deleteMany: async ({ where }: { where: unknown }) => {
      calls.push({ model, where })
      return { count: 1 }
    },
  })
  const transaction = {
    identityRiskFinding: deleteModel('finding'),
    identityRiskMatchedResult: deleteModel('matched'),
    identityRiskRuleCoverage: deleteModel('coverage'),
    identityRiskEvaluationRun: deleteModel('run'),
  }
  const prisma = {
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
  } as unknown as PrismaService
  const result = await new IdentityRiskService(prisma).pruneExpired(
    organizationId,
    tenantId,
    new Date(),
  )
  assert.deepEqual(result, {
    findings: 1, matchedResults: 1, coverage: 1, runs: 1,
  })
  assert.deepEqual(calls.map((call) => call.model), [
    'finding', 'matched', 'coverage', 'run',
  ])
  for (const call of calls) {
    assert.equal((call.where as { organizationId?: unknown }).organizationId, organizationId)
    assert.equal((call.where as { customerTenantId?: unknown }).customerTenantId, tenantId)
  }
})
