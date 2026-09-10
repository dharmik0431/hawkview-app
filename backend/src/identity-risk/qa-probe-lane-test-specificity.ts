// QA probe: does risk-reader-lane-contention.test.ts test 2 pass because the
// read SUCCEEDED, or merely because it THREW? Replicates that test exactly and
// reports which. Not a test; a diagnostic.
import { runInSyncMemoryLane } from '../tenants/tenant-sync.service.js'
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'

async function holdSyncLane() {
  let release!: () => void
  let held!: () => void
  const holding = new Promise<void>(resolve => { held = resolve })
  const finished = new Promise<void>(resolve => { release = resolve })
  const lane = runInSyncMemoryLane(async () => { held(); await finished })
  await holding
  return { release, settled: lane }
}

process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT = 'test'
const provider = { configured: true, allowsScope: () => true } as any
const reader = new RiskAssessmentReader(provider)
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', customerTenantId: '22222222-2222-4222-8222-222222222222' }
const run = { id: '33333333-3333-4333-8333-333333333333', pseudonymKeyVersionId: '44444444-4444-4444-8444-444444444444', completedAt: new Date() }

const { release, settled } = await holdSyncLane()
let outcome: string
let detail = ''
try {
  const assessment = await reader.read(scope, run, new Date(), false)
  outcome = 'RETURNED'
  detail = `rules[0].reasonCode=${assessment?.rules?.[0]?.reasonCode} capability=${assessment?.meta?.capability}`
} catch (error) {
  outcome = 'THREW'
  detail = `${(error as Error).constructor.name}: ${(error as Error).message.slice(0, 160)}`
}
release(); await settled

const assertionValue = outcome === 'THREW' ? undefined : 'see detail'
console.log(JSON.stringify({
  QA_PROBE: {
    outcome,
    detail,
    // This mirrors the assertion under review: assessment?.rules[0]?.reasonCode
    valueTheAssertionCompares: outcome === 'THREW' ? 'undefined (because .catch(() => null))' : detail,
    assertionPasses: assertionValue !== 'SOURCE_UNAVAILABLE',
    verdict: outcome === 'THREW'
      ? 'VACUOUS: the assertion passes because the read threw, not because it succeeded'
      : 'SPECIFIC: the read returned a real DTO and the assertion compared a real value',
  },
}, null, 2))
