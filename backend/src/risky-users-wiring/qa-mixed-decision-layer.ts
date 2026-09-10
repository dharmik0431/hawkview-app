// QA: MIXED at the decision layer. Four assessed events, eight out of scope.
// The production defect is a confident zero over a window most of which was
// discarded, with nothing disclosing it. This asks the narrower question the
// layer can answer: does the out-of-scope evidence travel WITH the count?
import { assessTenant } from './assess-tenant.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Detector } from '../evaluation-core/contract.js'

const scope = { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' }
const USER = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, n)).toISOString()

// 4 ordinary interactive successes -> assessed. 8 carrying 53004 -> excluded as
// MICROSOFT_RISK_VERDICT. NOTE: non-interactive rows do NOT work here -- that
// reason exists in the vocabulary but nothing assigns it yet, so a window built
// from them contains no exclusions at all and cannot answer this question.
const row = (n: number, assessed: boolean) => ({
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, ingestedAt: new Date(),
  raw: { id: `evt-${n}`, createdDateTime: at(n), userId: USER, userPrincipalName: 'alice@contoso.com',
    appId: APP, ipAddress: '203.0.113.9', isInteractive: true, status: { errorCode: assessed ? 0 : 53004 } },
})
const rows = [...Array.from({ length: 4 }, (_, i) => row(i, true)),
              ...Array.from({ length: 8 }, (_, i) => row(100 + i, false))]

const silent: Detector<NormalizedEvent> = { id: 'silent', monotonic: true,
  run: applicable => ({ status: 'RAN', assessed: applicable.length, declined: {}, findings: [] }) }

const batch = await normalizeSignInBatch({ scope, source: 'GRAPH_SIGN_INS', rows,
  directory: [{ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    microsoftUserId: USER, userPrincipalName: 'alice@contoso.com', userType: 'Member' }],
  reference: async () => 'subject-ref', collectionScope: 'GRAPH_INTERACTIVE_ONLY' })

const a = assessTenant({
  // rowsFetched is the count from OUTSIDE the batch. Passing rows.length rather
  // than a batch-derived total keeps assertAccountsForEveryRow able to fail: a
  // number the batch computed about itself can never contradict the batch.
  streams: [{ stream: 'sign-ins', collection: 'READ', batch, rowsFetched: rows.length,
    scope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }, detectors: [silent] }],
  budget: { maxEvents: 5000 },
})

const coverage = a.streams[0]!.assessment.coverage
const totalOn = (r: unknown): number => r !== null && typeof r === 'object'
  ? Object.values(r as Record<string, unknown>).filter((v): v is number => typeof v === 'number').reduce((x, y) => x + y, 0)
  : 0
const excludedInWindow = totalOn(coverage.doesNotApply)

// GUARD, added after this probe reported a confident verdict from a window that
// contained no exclusions. A probe must assert its own input was capable of
// failing it, or a green reading means only that nothing was asked.
const inputCanFail = excludedInWindow > 0

// PROPERTY, NOT FIELD NAME. Checking for a named key asserts the mechanism, and
// doing so produced a false negative the moment the field arrived under a
// different name. This asks whether the exclusion total is discoverable from
// the count's own scope at all, whatever it is called.
const reachableFromCountAlone = Object.values(a.count.scope as Record<string, unknown>)
  .some(value => excludedInWindow > 0 && totalOn(value) === excludedInWindow)

const zero = a.count.accuracy === 'EXACT' && a.count.value === 0
console.log(JSON.stringify({
  QA_MIXED_DECISION_LAYER: {
    windowRows: batch.counts.rows,
    applies: batch.counts.applies,
    excludedInWindow,
    count: { accuracy: a.count.accuracy, value: a.count.value },
    claimPermitted: a.claim.permitted,
    inputCanFail,
    countScopeKeys: Object.keys(a.count.scope as object),
    exclusionsReachableFromCountAlone: reachableFromCountAlone,
    verdict: !inputCanFail
      ? 'INCONCLUSIVE: the window contained no exclusions, so this cannot judge disclosure'
      : zero && !reachableFromCountAlone
        ? 'BARE ZERO AT THE DECISION LAYER: exact zero, exclusions not reachable from the count'
        : zero
          ? 'SCOPED ZERO: exact zero, and the exclusions travel with the count'
          : 'not an exact zero; see count',
  },
}, null, 2))
