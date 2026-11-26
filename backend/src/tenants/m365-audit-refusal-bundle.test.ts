import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'

/**
 * A COMPOSED witness: it runs the real `buildBundle` over a scoped stored
 * sync-state row and asserts the M365 detail arrives in the response, that
 * other resources' projections are unaffected, and that no additional query was
 * needed to get there.
 *
 * Every model is answered empty except the one scoped `syncState.findMany` the
 * bundle already performs, so anything the bundle had to look up separately
 * would come back empty and the detail could not appear.
 *
 * CLOCK: `options.now` governs only the bundle's expiry clock. The M365 audit
 * projection is evaluated against a separate, uninjectable `new Date()`, and
 * buildBundle reads the real clock in several other places too. So every test
 * here freezes Date at EVALUATED_AT before building, and the fixtures below are
 * fixed instants around it. Without that freeze these assertions would depend
 * on the real calendar: the qualifying refusal's boundary is 2026-11-27T00:00Z,
 * and a run after it would see the detail as expired and fail while production
 * behaviour was correct. `options.now` is still passed, because it is the only
 * clock a caller can inject and it covers that seam.
 */
const tenant = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  microsoftTenantId: '33333333-3333-3333-3333-333333333333',
  displayName: 'Composed bundle tenant',
  primaryDomain: 'composed.example',
  status: 'ACTIVE',
  connection: {
    lastVerifiedAt: new Date('2026-11-26T11:00:00.000Z'),
    consentedAt: new Date('2026-11-01T00:00:00.000Z'),
    onboardingCompletedAt: new Date('2026-11-01T00:00:00.000Z'),
    exchangeReadOnlyEnabledAt: null,
  },
}
const ATTEMPT_AT = new Date('2026-11-26T12:00:00.000Z')
const EVALUATED_AT = new Date('2026-11-26T12:00:10.000Z')
const BOUNDARY = new Date('2026-11-27T00:00:00.000Z')
const TOKEN = 'composed-attempt-token'

const auditRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sync-state-m365',
  organizationId: tenant.organizationId,
  customerTenantId: tenant.id,
  resourceType: 'M365_AUDIT',
  status: 'RUNNING',
  lastAttemptAt: ATTEMPT_AT,
  lastSuccessfulAt: null,
  lastErrorCode: 'm365-audit-backlog',
  lastErrorMessage: 'backlog',
  consecutiveFailures: 0,
  m365AuditAttempt: {
    v: 1, attemptToken: TOKEN, attemptAt: ATTEMPT_AT.toISOString(),
    refusal: {
      attemptToken: TOKEN, path: 'discovery', constraint: 'monthly_tenant_records',
      observedAt: '2026-11-26T12:00:05.000Z', retryNotBefore: BOUNDARY.toISOString(),
    },
  },
  ...overrides,
})

/** A sign-ins row so another resource's projection can be checked unchanged. */
const signInRow = () => ({
  id: 'sync-state-sign-ins',
  organizationId: tenant.organizationId,
  customerTenantId: tenant.id,
  resourceType: 'SIGN_INS',
  status: 'SUCCEEDED',
  lastAttemptAt: ATTEMPT_AT,
  lastSuccessfulAt: ATTEMPT_AT,
  lastErrorCode: null,
  lastErrorMessage: null,
  consecutiveFailures: 0,
  m365AuditAttempt: null,
})

/**
 * One frozen clock per test, however many services that test builds. Enabling
 * the same context's timers twice is treated as a hazard in this repository, so
 * the guard is a WeakSet keyed on the context, as in the sibling service suite.
 */
const frozen = new WeakSet<object>()
function freezeClock(context: TestContext) {
  if (frozen.has(context)) return
  context.mock.timers.enable({ apis: ['Date'], now: EVALUATED_AT.getTime() })
  frozen.add(context)
}

function bundleService(context: TestContext, syncStates: unknown[]) {
  // Frozen BEFORE the bundle is built, so every actual Date consumer on the
  // composed path -- not only the injected expiry clock -- sees EVALUATED_AT.
  freezeClock(context)
  const modelQueries: string[] = []
  const emptyModel = (name: string) => new Proxy({}, {
    get(_target, operation: string) {
      return async (...args: unknown[]) => {
        modelQueries.push(`${name}.${operation}`)
        if (name === 'syncState' && operation === 'findMany') return syncStates
        switch (operation) {
          case 'findMany': case 'groupBy': return []
          case 'findUnique': case 'findFirst': case 'findUniqueOrThrow': return null
          case 'count': return 0
          case 'aggregate': return { _sum: {}, _count: 0, _max: {}, _min: {} }
          case 'updateMany': case 'deleteMany': case 'createMany': return { count: 0 }
          default: return args.length ? {} : {}
        }
      }
    },
  })
  const prisma: any = new Proxy({}, {
    get(_target, key: string) {
      if (key === '$transaction') {
        return async (work: any) => Array.isArray(work) ? Promise.all(work) : work(prisma)
      }
      if (key === '$queryRawUnsafe' || key === '$executeRawUnsafe') return async () => []
      if (key === 'then') return undefined
      return emptyModel(key)
    },
  })
  const forbidden = new Proxy({}, { get: () => () => { throw new Error('unexpected dependency') } })
  const service = new TenantSyncService(
    prisma, forbidden as never, forbidden as never, forbidden as never, forbidden as never, forbidden as never,
  )
  return {
    modelQueries,
    build: () => (service as unknown as {
      buildBundle: (t: unknown, o: unknown) => Promise<any>
    }).buildBundle(tenant, { now: () => EVALUATED_AT }),
  }
}

test('composed: the real buildBundle surfaces the M365 detail with no extra query', async (context) => {
  const fake = bundleService(context, [auditRow(), signInRow()])
  const bundle = await fake.build()

  const audit = bundle?.bundle?.sync?.m365Audit
  assert.ok(audit, 'the bundle exposes an m365Audit section')
  assert.equal(audit.outcomeProjection.recordedOutcome.kind, 'DEFERRED_WORK_RECORDED')
  assert.equal(audit.outcomeProjection.reasonCode, 'm365-audit-backlog')
  assert.deepEqual(audit.outcomeProjection.observedBudgetRefusal, {
    path: 'discovery',
    constraint: 'monthly_tenant_records',
    observedAt: '2026-11-26T12:00:05.000Z',
    retryNotBefore: BOUNDARY.toISOString(),
  }, 'the validated detail reached the composed response')

  // Exactly one scoped sync-state read, and no lookup of the envelope itself.
  const syncStateReads = fake.modelQueries.filter((q) => q.startsWith('syncState.'))
  assert.deepEqual(syncStateReads, ['syncState.findMany'],
    'the bundle performs the one scoped sync-state query it always did')
  assert.equal(fake.modelQueries.some((q) => /m365AuditAttempt|fairShare|refusal/i.test(q)), false,
    'and no new model or table was consulted')
})

test('composed: another resource projection is unaffected and carries no detail', async (context) => {
  const fake = bundleService(context, [auditRow(), signInRow()])
  const bundle = await fake.build()
  const text = JSON.stringify(bundle)
  // Exactly one observedBudgetRefusal anywhere in the response.
  assert.equal(text.split('observedBudgetRefusal').length - 1, 1,
    'the optional field appears only on the M365 audit projection')
  assert.match(text, /"m365-audit-backlog"/)
})

test('composed: a non-qualifying row yields the released response shape', async (context) => {
  // A later success: the same envelope must not be surfaced.
  const fake = bundleService(context, [
    auditRow({ status: 'SUCCEEDED', lastSuccessfulAt: EVALUATED_AT, lastErrorCode: null }),
    signInRow(),
  ])
  const bundle = await fake.build()
  const text = JSON.stringify(bundle)
  assert.equal(text.includes('observedBudgetRefusal'), false,
    'no detail after a success, and no field added to the response')
  const audit = bundle?.bundle?.sync?.m365Audit
  assert.equal(audit.outcomeProjection.recordedOutcome.kind, 'SUCCEEDED')
})

test('composed: a legacy null envelope yields the released response shape', async (context) => {
  const fake = bundleService(context, [auditRow({ m365AuditAttempt: null }), signInRow()])
  const bundle = await fake.build()
  assert.equal(JSON.stringify(bundle).includes('observedBudgetRefusal'), false)
  const audit = bundle?.bundle?.sync?.m365Audit
  assert.equal(audit.outcomeProjection.reasonCode, 'm365-audit-backlog',
    'the ordinary deferred reason is untouched')
})
