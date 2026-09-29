// Synthetic persistence/controller/adapter composition; database IO and authorization are in-memory doubles.
const fs = require('fs'),
  path = require('path'),
  assert = require('node:assert/strict')
const ts = require('typescript')
const base = path.resolve(__dirname, '..'),
  cache = new Map()
const test = require('node:test')
function load(file) {
  file = path.resolve(base, file)
  if (cache.has(file)) return cache.get(file)
  const out = {}
  cache.set(file, out)
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
  }).outputText
  new Function('require', 'exports', '__dirname', js)(
    (name) => {
      if (name === '@nestjs/common')
        return new Proxy({}, { get: () => () => () => {} })
      if (name.includes('identity-risk.service'))
        return { IdentityRiskService: class {} }
      if (name.includes('prisma.service')) return { PrismaService: class {} }
      if (name.includes('generated/prisma')) return {}
      if (name.includes('identity-disclosure-audit'))
        return { recordIdentityDisclosure: async () => {} }
      if (!name.startsWith('.')) return require(name)
      let p = path.resolve(path.dirname(file), name)
      if (p.endsWith('.js')) p = p.slice(0, -3) + '.ts'
      return load(p)
    },
    out,
    path.dirname(file)
  )
  return out
}
const { readTenantAssessment } = load(
  'backend/src/risky-users-wiring/read-tenant.ts'
)
const { credentialFailureDetector } = load(
  'backend/src/risky-users-wiring/detectors/credential-failure.ts'
)
const { persistRun } = load('backend/src/risky-users-wiring/persist-run.ts')
const { RiskyUsersController } = load(
  'backend/src/risky-users-wiring/risky-users.controller.ts'
)
const { adaptNativeAssessment } = load('lib/identity-risk/native-assessment.ts')
const { nativeRiskyUserCount } = load('lib/identity-risk/native-view.ts')
const { projectFleetRisk } = load('lib/identity-risk/fleet-risk-projection.ts')
const { primaryReasonFor, mapRuleToPresentation } = load('lib/identity-risk/risk-presentation-mapper.ts')
const end = new Date('2026-09-27T12:00:00Z'),
  start = new Date('2026-09-01T00:00:00Z')
const scope = {
  organizationId: 'synthetic-org',
  customerTenantId: 'synthetic-tenant',
}
const user = (i) => ({
  microsoftUserId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`,
  userPrincipalName: `u${i}@synthetic.invalid`,
  userType: 'Member',
  displayName: `Synthetic ${i}`,
})
function graph(u, code, i) {
  return {
    raw: {
      id: `evt-${i}`,
      createdDateTime: '2026-09-27T11:00:00Z',
      userId: u.microsoftUserId,
      userPrincipalName: u.userPrincipalName,
      appId: '22222222-2222-4222-8222-222222222222',
      ipAddress: '203.0.113.9',
      isInteractive: true,
      status: {
        errorCode: code,
        failureReason:
          code === 50053
            ? "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."
            : code === 50126
              ? 'Error validating credentials due to invalid username or password.'
              : '',
      },
    },
    ingestedAt: end,
  }
}
async function run(label, n, opts = {}) {
  const directory = Array.from({ length: Math.max(n, 1) }, (_, i) => user(i))
  let rows = directory.flatMap((u, i) =>
    n === 0
      ? [graph(u, 0, i)]
      : [graph(u, 50053, i * 2), graph(u, 50126, i * 2 + 1)]
  )
  if (opts.rejectionsOnly) rows = directory.flatMap((u, i) => Array.from({ length: 7 }, (_, j) => graph(u, 50126, i * 7 + j)))
  if (opts.empty) rows = []
  if (opts.missingSubject) {
    const bad = graph(user(999), 50053, 999)
    rows.push(bad)
  }
  if (opts.ambiguous) {
    const bad = graph(directory[0], 50053, 998)
    bad.raw.status.failureReason = 'Synthetic unrecognized lockout description'
    rows.push(bad)
  }
  if (opts.badTimestamp) {
    const bad = graph(directory[0], 50053, 997)
    bad.raw.createdDateTime = 'invalid'
    rows.push(bad)
  }
  if (opts.unknown) rows.push(graph(directory[0], 999999, 100000))
  if (opts.success) rows.push(graph(directory[0], 0, 100001))
  if (opts.audit)
    rows = rows.map((r, i) => ({
      ingestedAt: r.ingestedAt,
      raw: {
        hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
        managementActivityRecord: {
          Id: `audit-${i}`,
          CreationTime: '2026-09-27T11:00:00',
          OrganizationId: '33333333-3333-4333-8333-333333333333',
          RecordType: 15,
          Operation:
            r.raw.status.errorCode === 0 ? 'UserLoggedIn' : 'UserLoginFailed',
          UserId: r.raw.userPrincipalName,
          ApplicationId: r.raw.appId,
          ClientIP: '203.0.113.9',
          LogonError:
            r.raw.status.errorCode === 50053
              ? 'IdsLocked'
              : r.raw.status.errorCode === 50126
                ? 'InvalidUserNameOrPassword'
                : undefined,
        },
      },
    }))
  if (opts.auditUnknown)
    rows.push({
      ingestedAt: end,
      raw: {
        hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
        managementActivityRecord: {
          Id: 'audit-unknown',
          CreationTime: '2026-09-27T11:00:00',
          OrganizationId: '33333333-3333-4333-8333-333333333333',
          RecordType: 15,
          Operation: 'UserLoginFailed',
          UserId: directory[0].userPrincipalName,
          ApplicationId: '22222222-2222-4222-8222-222222222222',
          LogonError: 'SyntheticUnknownReason',
        },
      },
    })
  const prisma = {
    customerTenant: {
      findFirst: async () => ({
        microsoftTenantId: '33333333-3333-4333-8333-333333333333',
      }),
    },
    signInLog: { findMany: async () => rows },
    directoryUser: { findMany: async () => directory },
  }
  const result = await readTenantAssessment(prisma, {
    ...scope,
    feedIfNoRows: opts.audit ? 'M365_AUDIT_STS' : 'GRAPH_SIGN_INS',
    collectionScope: {
      GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY',
      M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS',
    },
    syncStatus: { GRAPH_SIGN_INS: 'SUCCESS', M365_AUDIT_STS: 'SUCCESS' },
    detectors: [credentialFailureDetector()],
    windowStart: start,
    windowEnd: end,
    maxEvents: opts.cap ?? 50000,
  })
  let stored
  await persistRun(
    {
      identityRiskEvaluationRun: {
        create: async ({ data }) => {
          stored = data
          return { id: 'synthetic-run' }
        },
      },
    },
    result.assessment,
    {
      ...scope,
      windowStart: start,
      windowEnd: end,
      rowsFetched: rows.length,
      expiresAt: new Date('2099-01-01'),
      completedAt: end,
      sources: [
        {
          source: result.feed.feed,
          status: 'SUCCESS',
          lastSuccessfulCollectionAt: end.toISOString(),
        },
      ],
    }
  )
  // JSON persistence boundary: dates remain DB Date columns, JSON columns undergo JSON serialization.
  stored.evaluationFindings = JSON.parse(
    JSON.stringify(stored.evaluationFindings)
  )
  stored.evaluationCoverage = JSON.parse(
    JSON.stringify(stored.evaluationCoverage)
  )
  prisma.identityRiskEvaluationRun = { findFirst: async () => stored }
  const c = new RiskyUsersController(
    {
      authorizeRiskyUsersRead: async () => ({
        gate: null,
        tenant: {
          id: scope.customerTenantId,
          organizationId: scope.organizationId,
          actorUserId: 'synthetic-actor',
          evidenceDetailAllowed: !!opts.named,
        },
      }),
    },
    prisma
  )
  const dto = JSON.parse(
    JSON.stringify(await c.assessment({ auth: {} }, scope.customerTenantId))
  )
  const adapted = adaptNativeAssessment(dto)
  assert.ok(adapted?.available, label + ' adapted')
  const projected = projectFleetRisk(
    [{ id: scope.customerTenantId }],
    [{ data: dto }],
    [{}],
    end.getTime() + 1000
  )
  if (opts.rejectionsOnly) {
    assert.equal(projected.fleetRows.length, n)
    for (const row of projected.fleetRows) {
      assert.equal(row.reasons[0].signal, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')
      assert.equal(row.reasons[0].evidenceCount, 0)
      assert.equal(row.reasons[0].lastSeen, null)
      assert.equal(primaryReasonFor(row.reasons).signal, 'PASSWORD_REJECTED')
      assert.equal(mapRuleToPresentation(primaryReasonFor(row.reasons)).plainTitle, 'Rejected password attempts observed')
      assert.equal(mapRuleToPresentation(row.reasons[0]).plainTitle, 'No lockout records observed')
    }
  }
  const status = projected.tenantStatuses[0]
  const summary = {
    label,
    n,
    feed: result.feed.feed,
    rawRows: rows.length,
    producerCount: stored.evaluationFindings.count,
    claim: stored.evaluationFindings.claim,
    dtoCoverage: dto.coverage,
    adaptedCoverage: adapted.coverage,
    producerComplete: stored.evaluationFindings.complete,
    producerItems: stored.evaluationFindings.items.length,
    dtoItems: dto.findings.items.length,
    adaptedItems: adapted.findings.length,
    helperCount: nativeRiskyUserCount(adapted),
    status: status.nativeSource,
    rows: projected.fleetRows.length,
    signals: projected.fleetRows.reduce((n, r) => n + r.reasons.length, 0),
    clocks: projected.fleetRows.map((r) => r.evidenceState),
  }
  assert.deepEqual(dto.count, stored.evaluationFindings.count)
  assert.equal(dto.findings.items.length, adapted.findings.length)
  if (opts.expected) assert.equal(status.nativeSource, opts.expected, label)
  return summary
}
test('persisted producer coverage survives controller serialization and frontend count explanations', async () => {
  const results = []
  results.push(await run('graph-rejections-only', 2, { rejectionsOnly: true, expected: 'READY' }))
  results.push(await run('audit-rejections-only', 2, { rejectionsOnly: true, audit: true, expected: 'READY' }))
  for (const n of [0, 1, 2, 6, 25, 101])
    results.push(await run('graph-complete-' + n, n, { expected: 'READY' }))
  results.push(
    await run('graph-mixed-success', 6, { success: true, expected: 'READY' })
  )
  results.push(await run('graph-named', 6, { named: true, expected: 'READY' }))
  results.push(
    await run('graph-empty', 0, { empty: true, expected: 'INCOMPLETE' })
  )
  results.push(
    await run('graph-unknown-positive', 6, {
      unknown: true,
      expected: 'INCOMPLETE',
    })
  )
  results.push(
    await run('graph-capacity', 6, { cap: 2, expected: 'INCOMPLETE' })
  )
  for (const n of [0, 1, 6])
    results.push(await run('audit-' + n, n, { audit: true, expected: 'READY' }))
  for (const variation of ['missingSubject', 'ambiguous', 'badTimestamp'])
    results.push(
      await run('graph-' + variation, 5, {
        [variation]: true,
        expected: 'INCOMPLETE',
      })
    )
  results.push(
    await run('audit-unknown-reason', 5, {
      audit: true,
      auditUnknown: true,
      expected: 'INCOMPLETE',
    })
  )
  for (const [i, n] of [0, 0, 0, 1, 5].entries())
    results.push(
      await run('five-tenant-pattern-' + i, n, {
        unknown: true,
        audit: i < 3,
        expected: 'INCOMPLETE',
      })
    )
  for (const result of results) {
    const actual = result.dtoCoverage.reduce(
      (sum, s) =>
        sum +
        Object.values(s.coverage.unknown).reduce((a, b) => a + b, 0) +
        Object.values(s.coverage.unprocessable).reduce((a, b) => a + b, 0),
      0
    )
    const pending = result.dtoCoverage.reduce(
      (sum, s) =>
        sum + Object.values(s.coverage.notYetCited).reduce((a, b) => a + b, 0),
      0
    )
    assert.equal(
      result.adaptedCoverage.reduce((sum, s) => sum + s.uninterpretedEvents, 0),
      actual,
      result.label
    )
    assert.equal(
      result.adaptedCoverage.reduce((sum, s) => sum + s.notYetCitedEvents, 0),
      pending,
      result.label
    )
    if (actual > 0) {
      assert.equal(
        result.producerCount.accuracy,
        result.producerCount.value > 0 ? 'AT_LEAST' : 'NOT_AVAILABLE'
      )
      assert.equal(result.claim.permitted, false)
      assert.equal(result.status, 'INCOMPLETE')
      if (result.producerCount.value > 0)
        assert.match(result.helperCount.caption, /could not be interpreted/)
      assert.doesNotMatch(
        result.helperCount.caption,
        /Every event this run examined was either assessed or accounted for/
      )
    }
  }
  const positive = results.find((r) => r.label === 'graph-unknown-positive')
  assert.equal(positive.helperCount.value, 6)
  assert.equal(positive.rows, 6)
  assert.equal(positive.signals, 12)
  assert.equal(positive.producerComplete, true)
  assert.equal(positive.helperCount.listCoverage, 'COMPLETE')
  assert.ok(positive.clocks.every((clock) => clock === 'CURRENT'))
  assert.equal(positive.adaptedCoverage[0].uninterpretedEvents, 1)
})
