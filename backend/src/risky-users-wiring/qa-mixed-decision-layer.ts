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

// 4 ordinary interactive successes -> assessed. 8 carrying 50140 (InterruptedKMSI)
// -> excluded as KEEP_ME_SIGNED_IN, on a cited provider statement.
//
// This fixture used to carry 53004. That code is NOT_OBSERVED and now classifies
// as RISK, so every row applied, nothing was excluded, and the probe went inert --
// caught by the inputCanFail guard rather than by me. provider-facts.ts names
// 53004 as one of two past mistakes in this workstream: a sound reading of
// Microsoft's documentation for an event nobody has ever seen. A probe built on
// a code the provider does not emit tests the documentation, not the product.
//
// Non-interactive rows do NOT work here either -- that reason exists in the
// vocabulary but nothing assigns it, so such a window contains no exclusions.
const row = (n: number, assessed: boolean) => ({
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, ingestedAt: new Date(),
  raw: { id: `evt-${n}`, createdDateTime: at(n), userId: USER, userPrincipalName: 'alice@contoso.com',
    appId: APP, ipAddress: '203.0.113.9', isInteractive: true, status: { errorCode: assessed ? 0 : 50140 } },
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
// DEEP sum. The shallow version this replaces summed only top-level numbers, so
// it read 0 from `setAside` -- which is an ARRAY of {vocabulary, reason, count}
// records -- and reported BARE ZERO against a layer that was in fact disclosing
// all eight exclusions. A probe that cannot see the disclosure reports its own
// blindness as a product defect, which is the worst thing a probe can do.
const totalOn = (r: unknown): number =>
  typeof r === 'number' ? r
  : Array.isArray(r) ? r.reduce<number>((x, y) => x + totalOn(y), 0)
  : r !== null && typeof r === 'object'
    ? Object.values(r as Record<string, unknown>).reduce<number>((x, y) => x + totalOn(y), 0)
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
