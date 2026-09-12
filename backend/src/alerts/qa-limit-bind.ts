// QA — L1, L2 and L4 bound at last, plus the four attacks.
//
// These have been unbound since 05b and reported as unbound every round. This is the run
// that closes them.
import {
  applyLimit, fanOutProblems, fold, incidentsCoveredBy, UNMEASURED_LIMIT,
  type Aggregate, type Delivery, type DeliveryTiming, type LimitPolicy, type VerifiedRecipient,
} from './routing-policy.js'

const TO: VerifiedRecipient = { kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: new Date(0) }
const TICK = new Date('2026-03-01T12:00:00Z')
const D = (over: Partial<Delivery> = {}): Delivery => ({
  organizationId: 'org-1', causeKey: 'cause-1', tier: 'EMAIL', timing: { kind: 'IMMEDIATE' },
  recipient: TO, tickAt: TICK, affectedTenants: ['ten-1'], incidentKeys: ['inc-1'], ...over,
})
const many = (n: number, org = 'org-1', tier: Delivery['tier'] = 'EMAIL') =>
  Array.from({ length: n }, (_, i) => D({ organizationId: org, tier, causeKey: `c-${org}-${i}`, incidentKeys: [`i-${org}-${i}`] }))
const small: LimitPolicy = { perOrganizationPerTick: 3, because: 'a small limit, so the boundary is reachable' }

// ── L1. A LIMIT WITHHOLDS, NEVER DROPS ──────────────────────────────────────
const over = applyLimit([], many(10), small, TICK)
const l1 = {
  inputs: 10,
  sent: over.sent.length, withheld: over.withheld.length,
  inReleasedAggregates: over.released.reduce((n, a) => n + a.members.length, 0),
  accountedFor: over.sent.length + over.withheld.length + over.released.reduce((n, a) => n + a.members.length, 0),
  accountingProblems: over.accountingProblems,
  holds: over.accountingProblems.length === 0
    && over.sent.length + over.withheld.length === 10,
}

// ── L2. A WITHHELD DELIVERY IS RELEASED — the carry-over cycle, two ticks ────
const tick2 = new Date(TICK.getTime() + 60_000)
const second = applyLimit(over.withheld, [], small, tick2)
const l2 = {
  withheldOnTickOne: over.withheld.length,
  releasedOnTickTwo: second.released.reduce((n, a) => n + a.members.length, 0),
  stillWithheldOnTickTwo: second.withheld.length,
  releasedAsOneAggregate: second.released.length,
  everyWithheldOneEventuallyAccountedFor:
    second.released.reduce((n, a) => n + a.members.length, 0) + second.withheld.length === over.withheld.length,
}

// ── L4. COUNTED OVER THE DECLARED SCOPE — one organisation must not silence another ──
const twoOrgs = applyLimit([], [...many(5, 'org-1'), ...many(2, 'org-2')], small, TICK)
const perOrg = (list: readonly Delivery[], org: string) => list.filter((d) => d.organizationId === org).length
const l4 = {
  orgOneSent: perOrg(twoOrgs.sent, 'org-1'), orgOneWithheld: perOrg(twoOrgs.withheld, 'org-1'),
  orgTwoSent: perOrg(twoOrgs.sent, 'org-2'), orgTwoWithheld: perOrg(twoOrgs.withheld, 'org-2'),
  // org-2 is under the limit and must be untouched by org-1 being over it.
  holds: perOrg(twoOrgs.sent, 'org-2') === 2 && perOrg(twoOrgs.withheld, 'org-2') === 0
    && perOrg(twoOrgs.sent, 'org-1') === 3,
}

// ── ATTACK 1. IS THERE A FOURTH STATE? Limited AND held AND on a silenced rule ──
// A silenced rule never produces a Delivery at all, so the combination reaching the limit
// is limited + carried-over. Every delivery must be in exactly one of sent / withheld /
// released-members, across a run that mixes all three.
// DISTINCT causeKeys for the carried set. My first version reused many()'s keys for both
// sides, so carried and arriving collided and my own identity function counted duplicates
// — which read as the product placing a delivery in two buckets. It was my fixture.
const carriedMixed = many(4, 'org-1', 'PHONE').map((d) => ({ ...d, causeKey: `carried-${d.causeKey}` }))
const mixed = applyLimit(carriedMixed, [...many(6, 'org-1'), ...many(1, 'org-2')], small, TICK)
const idsIn = (list: readonly Delivery[]) => list.map((d) => d.causeKey)
const releasedIds = mixed.released.flatMap((a) => a.members.map((m) => m.causeKey))
const everyId = [...idsIn(mixed.sent), ...idsIn(mixed.withheld), ...releasedIds]
const counts = new Map<string, number>()
for (const id of everyId) counts.set(id, (counts.get(id) ?? 0) + 1)
const attack1 = {
  inputs: 11,
  totalPlacements: everyId.length,
  anyDeliveryInTwoBuckets: [...counts.values()].some((n) => n > 1),
  anyDeliveryInNoBucket: new Set(everyId).size !== 11,
  accountingProblems: mixed.accountingProblems,
  bucketsAvailable: Object.keys(mixed).filter((k) => k !== 'accountingProblems'),
}

// ── ATTACK 2. DOES THE AGGREGATE STILL RESIST NESTING, now that something builds them? ──
const producedAggregate: Aggregate | undefined = second.released[0]
const attack2 = {
  anAggregateWasActuallyProduced: producedAggregate !== undefined,
  itsMembersAreDeliveries: producedAggregate?.members.every((m) => 'incidentKeys' in m) ?? false,
  incidentsCoveredIsFlat: producedAggregate === undefined ? null : incidentsCoveredBy(producedAggregate).length,
  membersCount: producedAggregate?.members.length ?? 0,
  coveredEqualsSumOfMembers: producedAggregate === undefined ? null
    : incidentsCoveredBy(producedAggregate).length
      === producedAggregate.members.reduce((n, m) => n + m.incidentKeys.length, 0),
}
// Nesting is still unconstructible: fold takes a Delivery and an Aggregate is not one.
export const cannotNestAProducedAggregate = () =>
  producedAggregate === undefined ? null
    // @ts-expect-error an Aggregate is not a Delivery, even one the limit produced
    : fold(producedAggregate, producedAggregate)

// ── ATTACK 3. NO TIMESTAMP ON THE RELEASE PATH ──────────────────────────────
const withheldTiming: DeliveryTiming | undefined = over.withheld[0]?.timing
const attack3 = {
  kind: withheldTiming?.kind,
  carriesACondition: withheldTiming?.kind === 'LIMITED' && 'releaseWhen' in withheldTiming,
  conditionKind: withheldTiming?.kind === 'LIMITED' ? withheldTiming.releaseWhen.kind : null,
  // Nothing on the LIMITED arm is a Date, and the type has no `until` to fill in.
  noDateAnywhereOnTheArm: withheldTiming?.kind === 'LIMITED'
    && !Object.values(withheldTiming.releaseWhen).some((v) => v instanceof Date)
    && !('until' in withheldTiming),
}

// ── ATTACK 4. RE-ENUMERATE, because the old 48 predate the limit ─────────────
const TIERS: Delivery['tier'][] = ['PHONE', 'EMAIL', 'IN_APP']
const ARRIVING = [0, 1, 3, 4, 9]
const CARRIED = [0, 1, 5]
const LIMITS = [0, 1, 3]
const breaches: string[] = []
let cases = 0
for (const tier of TIERS) for (const a of ARRIVING) for (const cOver of CARRIED) for (const lim of LIMITS) {
  cases += 1
  const policy: LimitPolicy = { perOrganizationPerTick: lim, because: 'enumerated' }
  const carried = many(cOver, 'org-1', tier).map((d) => ({ ...d, causeKey: `carried-${d.causeKey}` }))
  const out = applyLimit(carried, many(a, 'org-1', tier), policy, TICK)
  const total = carried.length + a
  const placed = out.sent.length + out.withheld.length
    + out.released.reduce((n, agg) => n + agg.members.length, 0)
  const label = `${tier}/arriving ${a}/carried ${cOver}/limit ${lim}`
  if (placed !== total) breaches.push(`${label}: ${total} in, ${placed} placed`)
  if (out.accountingProblems.length > 0) breaches.push(`${label}: ${out.accountingProblems.join('; ')}`)
  // And one message per cause per tick must still hold for whatever went out.
  const fan = fanOutProblems(out.sent)
  if (fan.length > 0) breaches.push(`${label}: ${fan.join('; ')}`)
}

console.log(JSON.stringify({
  QA_LIMIT_BIND: {
    boundTo: '42622d1',
    L1_withholdsNeverDrops: l1,
    L2_withheldIsReleased: l2,
    L4_countedOverItsScope: l4,
    attack1_noFourthState: attack1,
    attack2_aggregateStillResistsNesting: attack2,
    attack3_conditionNotTimestamp: attack3,
    attack4_reEnumerated: { cases, breaches },
    theDefaultIsHonestlyLabelled: UNMEASURED_LIMIT.because.startsWith('NOT YET MEASURED'),
  },
}, null, 2))
