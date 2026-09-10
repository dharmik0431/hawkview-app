// QA probe: the revised lane test asserts reasonCode === 'KEY_UNAVAILABLE' on
// the resolved branch as proof the read "entered its own work". But
// KEY_UNAVAILABLE is also produced by the PRE-LANE guard at
// risk-assessment-reader.service.ts:43, which returns without ever entering the
// lane. If so, that branch cannot distinguish "ran inside the lane" from
// "short-circuited before it", and a regression that never reaches the lane
// would still satisfy it.
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'

process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', customerTenantId: '22222222-2222-4222-8222-222222222222' }
const run = { id: '33333333-3333-4333-8333-333333333333', pseudonymKeyVersionId: '44444444-4444-4444-8444-444444444444', completedAt: new Date() }

// Simulates a regression that fails the pre-lane guard: the lane body never runs.
const shortCircuit = new RiskAssessmentReader({
  configured: false,
  allowsScope: () => true,
  pin: () => { throw new Error('lane body must not be reached in this probe') },
} as any)

const assessment = await shortCircuit.read(scope, run, new Date(), false)
const reasonCode = assessment?.rules?.[0]?.reasonCode

console.log(JSON.stringify({
  QA_PROBE_LANE_BOUNDARY: {
    scenario: 'pre-lane guard fails (provider.configured=false); lane body never entered',
    outcome: 'RESOLVED',
    reasonCode,
    // This mirrors the revised test's resolved-branch assertion.
    revisedTestResolvedBranchWouldPass: reasonCode === 'KEY_UNAVAILABLE',
    verdict: reasonCode === 'KEY_UNAVAILABLE'
      ? 'RESIDUAL GAP: KEY_UNAVAILABLE is reachable WITHOUT entering the lane, so the resolved branch does not prove the lane body ran'
      : 'SPECIFIC: pre-lane short-circuit produces a different reason, so the assertion does discriminate',
  },
}, null, 2))
