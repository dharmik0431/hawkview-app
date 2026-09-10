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

// 4 ordinary interactive successes -> assessed. 8 non-interactive -> out of scope.
const row = (n: number, interactive: boolean) => ({
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, ingestedAt: new Date(),
  raw: { id: `evt-${n}`, createdDateTime: at(n), userId: USER, userPrincipalName: 'alice@contoso.com',
    appId: APP, ipAddress: '203.0.113.9', isInteractive: interactive, status: { errorCode: interactive ? 0 : 53004 } },
})
const rows = [...Array.from({ length: 4 }, (_, i) => row(i, true)),
              ...Array.from({ length: 8 }, (_, i) => row(100 + i, false))]

const silent: Detector<NormalizedEvent> = { id: 'silent', monotonic: true,
  run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: [] }) }

const batch = await normalizeSignInBatch({ scope, source: 'GRAPH_SIGN_INS', rows,
  directory: [{ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
    microsoftUserId: USER, userPrincipalName: 'alice@contoso.com', userType: 'Member' }],
  reference: async () => 'subject-ref', collectionScope: 'GRAPH_INTERACTIVE_ONLY' })

const a = assessTenant({ streams: [{ stream: 'sign-ins', batch, scope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }, detectors: [silent] }],
  budget: { maxEvents: 5000 } })

const coverage = a.streams[0]!.assessment.coverage
console.log(JSON.stringify({
  QA_MIXED_DECISION_LAYER: {
    counts: { rows: batch.counts.rows, applies: batch.counts.applies,
      doesNotApply: batch.counts.doesNotApplyByReason, notYetCited: batch.counts.notYetCitedByReason },
    count: a.count,
    claimPermitted: a.claim.permitted,
    // The question: can a consumer holding the COUNT see the discarded evidence?
    reachableFromCountScope: Object.keys(a.count.scope),
    exclusionsOnCountScope: 'doesNotApply' in (a.count.scope as object),
    exclusionsOnStreamCoverage: coverage.doesNotApply,
    verdict: a.count.accuracy === 'EXACT' && a.count.value === 0
      ? ('doesNotApply' in (a.count.scope as object)
          ? 'EXACT 0 and the exclusions travel with the count'
          : 'EXACT 0, and the exclusions are NOT on count.scope — reachable only via streams[].assessment.coverage')
      : `count is ${a.count.accuracy}, not an exact zero`,
  },
}, null, 2))
