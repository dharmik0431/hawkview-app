import assert from 'node:assert/strict'
import test from 'node:test'
import { alertType, ALERT_CATALOG } from './alert-catalog.js'
import {
  alertTypeForChange,
  applyLimit,
  causeKeyOf,
  fold,
  statements,
  incidentsCoveredBy,
  UNMEASURED_LIMIT,
  routableIncident,
  type IncidentOrigin,
  contradictions,
  defaultPreference,
  fanOutProblems,
  type Acknowledgement,
  type Aggregate,
  type CoverageStatement,
  type EscalationState,
  type EscalationTick,
  type LadderRungs,
  type LimitPolicy,
  type Delivery,
  type DeliveryPreference,
  type PreferenceChange,
  type Recipient,
  type RoutableIncident,
  type Routing,
  type RoutingOutcome,
  type RoutingTick,
} from './routing-policy.js'

/** THE STEP-05 GATE, run before the routing logic exists.
 *
 * Two of the three guardrails are meant to be UNEXPRESSIBLE defects rather than forbidden
 * ones, and the difference matters: a forbidden thing is caught by a check somebody can
 * delete, an unexpressible one has no value to write down. So these tests come in two kinds
 * and they are labelled, because they prove different things:
 *
 *   - UNEXPRESSIBLE: asserted with `@ts-expect-error`. The proof is that it does not compile;
 *     if it ever does, the expect-error itself becomes the failure.
 *   - EXPRESSIBLE: two states the property must separate, shown distinguishable, as in step 04.
 *
 * Nothing here tests routing. There is no routing.
 */

const HELD_AT = new Date('2026-09-01T23:40:00Z')
const DUE_AT = new Date('2026-09-02T07:00:00Z')

const VERIFIED: Recipient = {
  kind: 'MSP_SECURITY_INBOX',
  address: 'soc@example-msp.test',
  verifiedAt: new Date('2026-09-01T00:00:00Z'),
}

test('GUARDRAIL 1 — there is no preference value that silences the record', () => {
  // Any rule can be turned down to record-only; no rule can be made not-recorded. Expressed
  // as a MISSING ENUM MEMBER rather than as a validation, because a validation is a thing a
  // later code path can skip and an absent value is not a thing anyone can select.
  const quietest: DeliveryPreference = 'RECORD_ONLY'
  assert.equal(quietest, 'RECORD_ONLY')

  // @ts-expect-error there is no 'OFF', and that absence is the guarantee
  const off: DeliveryPreference = 'OFF'
  assert.ok(off, 'referenced so the expectation is checked rather than optimised away')

  // @ts-expect-error nor any other spelling of it
  const none: DeliveryPreference = 'NONE'
  assert.ok(none)

  // Every preference is reachable, so the floor is a real setting rather than the only one.
  const all: readonly DeliveryPreference[] = ['RING', 'EMAIL', 'DIGEST', 'RECORD_ONLY']
  assert.equal(new Set(all).size, 4)
})

test('GUARDRAIL 1 — the record is not an output a preference can address', () => {
  // The stronger half. Even with no `OFF`, a routing result whose record were OPTIONAL would
  // let a quiet preference produce nothing at all. `Routing.record` is required, so there is
  // no branch in which a preference suppressed it.
  const routing: Routing = {
    record: {
      incidentKey: 'k-1',
      organizationId: 'org-1',
      customerTenantId: 'tenant-1',
      ruleId: 'security.privileged_role_granted',
      severity: 'ACT_NOW',
      category: 'SECURITY',
      deliveryOutcome: 'Recorded only, at your setting for this rule.',
      heldDeliveries: [],
    },
    // The quietest possible outcome: nothing delivered. The record is still there.
    deliveries: [],
  }
  assert.equal(routing.deliveries.length, 0)
  assert.ok(routing.record, 'the record survives the quietest setting there is')

  // @ts-expect-error a routing result without a record does not typecheck
  const recordless: Routing = { deliveries: [] }
  assert.ok(recordless)
})

test('GUARDRAIL 2 — a per-tenant fan-out has no field to vary', () => {
  // A fleet-wide collector failure is ONE cause. At 100 MSPs by 15 tenants, one message per
  // tenant is 1,500 messages from a single incident — the failure that would destroy the
  // channel on its first bad day. So a delivery names an ORGANISATION and lists the tenants.
  const oneMessage: Delivery = {
    organizationId: 'org-1',
    causeKey: 'monitoring.collector_failing/SIGN_INS',
    tier: 'EMAIL',
    timing: { kind: 'IMMEDIATE' },
    recipient: VERIFIED,
    tickAt: HELD_AT,
    affectedTenants: Array.from({ length: 15 }, (_, n) => `tenant-${n}`),
    incidentKeys: Array.from({ length: 15 }, (_, n) => `k-${n}`),
  }
  assert.equal(oneMessage.affectedTenants.length, 15, 'fifteen tenants')
  assert.equal([oneMessage].length, 1, 'one message')

  // @ts-expect-error there is no customerTenantId on a Delivery to vary per message
  const perTenant: Delivery = { ...oneMessage, customerTenantId: 'tenant-1' }
  assert.ok(perTenant)

  // Coalescing cannot be FORGOTTEN, because un-coalesced is not a thing you can write. That is
  // the difference between this and a rate limit applied afterwards, which is a thing that can
  // be bypassed by a caller that does not know it exists.
})

test('QUIET HOURS DEFER AND NEVER DROP, and the deferral is visible immediately', () => {
  const until = new Date('2026-09-02T07:00:00Z')
  const held: Delivery = {
    organizationId: 'org-1',
    causeKey: 'security.privileged_role_granted/admin-1',
    tier: 'PHONE',
    timing: { kind: 'HELD', until, because: 'quiet hours until 07:00' },
    recipient: VERIFIED,
    tickAt: HELD_AT,
    affectedTenants: ['tenant-1'],
    incidentKeys: ['k-1'],
  }
  assert.equal(held.timing.kind, 'HELD')

  // @ts-expect-error there is no variant meaning "discarded because it was inconvenient"
  const dropped: Delivery = { ...held, timing: { kind: 'DROPPED' } }
  assert.ok(dropped)

  // AND THE RECORD SHOWS IT AT ONCE. An in-app view marks the alert as held from the moment
  // the deferral is decided — "you will hear about this at 07:00" rather than silence until
  // 07:00, which is indistinguishable from having been forgotten.
  const record: Routing['record'] = {
    incidentKey: 'k-1',
    organizationId: 'org-1',
    customerTenantId: 'tenant-1',
    ruleId: 'security.privileged_role_granted',
    severity: 'ACT_NOW',
    category: 'SECURITY',
    deliveryOutcome: 'Held until 07:00 — quiet hours. It will ring then.',
    heldDeliveries: [{ until, because: 'quiet hours until 07:00' }],
  }
  assert.equal(record.heldDeliveries.length, 1)
  assert.match(record.deliveryOutcome, /07:00/, 'and the sentence names when, not just that')
})

test('THE DEFAULT IS DERIVED FROM THE DECLARED SEVERITY, so it cannot drift from the tiering', () => {
  assert.equal(defaultPreference('ACT_NOW'), 'RING')
  assert.equal(defaultPreference('ACT_TODAY'), 'EMAIL')
  assert.equal(defaultPreference('RECORD_ONLY'), 'RECORD_ONLY')

  // AND IT DISCRIMINATES. Three severities, three answers — a default function returning one
  // value everywhere would satisfy "there is a default" and mean nothing.
  const answers = (['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'] as const).map(defaultPreference)
  assert.equal(new Set(answers).size, 3)

  // The MSP overriding this is expressing a preference; HawkView disagreeing with its own
  // catalogue would be a bug, which is why the default is derived rather than listed again.
})

test('A RECIPIENT IS VERIFIED OR IT IS NAMED AS ABSENT — never a bare address', () => {
  // Never a customer end user: they have no relationship with HawkView and did not ask to
  // hear from it. A type accepting any string invites one to be typed in.
  assert.equal(VERIFIED.kind, 'MSP_SECURITY_INBOX')

  // @ts-expect-error an address with no verification is not a recipient
  const unverified: Recipient = { kind: 'MSP_SECURITY_INBOX', address: 'someone@customer.test' }
  assert.ok(unverified)

  // "Nobody is listening" is a VARIANT, not an empty list, so a settings screen can say which
  // tenants have no recipient instead of rendering a blank where a name should be.
  const nobody: Recipient = { kind: 'NONE_VERIFIED', because: 'no inbox has been verified yet' }
  assert.equal(nobody.kind, 'NONE_VERIFIED')
  assert.match(nobody.kind === 'NONE_VERIFIED' ? nobody.because : '', /verified/)
})

test('COVERAGE GAPS ARE SENTENCES, because a count is not something a reader can act on', () => {
  // The plan's coverage-gaps requirement, and what stops "make it configurable" becoming
  // "everybody turns it off and blames HawkView". Under-alerting by default is not a virtue;
  // it is the same failure as a screen quietly showing stale data.
  const gaps: readonly CoverageStatement[] = [
    {
      ruleId: 'security.privileged_role_granted',
      preference: 'RECORD_ONLY',
      sentence: 'You will not be contacted about privileged role grants. They are still recorded.',
    },
  ]
  assert.match(gaps[0]?.sentence ?? '', /not be contacted/)
  // AND IT SAYS THE RECORD SURVIVES, in the same breath. A gap statement that only said what
  // is lost would read as "HawkView stops watching", which is not what record-only means.
  assert.match(gaps[0]?.sentence ?? '', /still recorded/i)

  // "8 rules are set to record-only" tells a reader nothing they can act on.
  assert.notEqual(String(gaps.length), gaps[0]?.sentence)
})

test('A PREFERENCE CHANGE CARRIES WHO, WHEN, AND WHAT IT WAS BEFORE', () => {
  // An MSP asking why they were not told gets an answer with a date on it. The PREVIOUS value
  // is what explains the gap: "who set this" and "what did they change it from" are different
  // questions, and only the second says why the period before the change looked different.
  const change: PreferenceChange = {
    organizationId: 'org-1',
    ruleId: 'security.privileged_role_granted',
    from: 'RING',
    to: 'RECORD_ONLY',
    changedByUserId: 'user-7',
    changedAt: new Date('2026-08-14T09:12:00Z'),
  }
  assert.notEqual(change.from, change.to, 'a recorded change must actually be a change')

  // @ts-expect-error a change with no author is not an answer to "who turned this off"
  const anonymous: PreferenceChange = { ...change, changedByUserId: undefined }
  assert.ok(anonymous)
})

/** The two properties QA's seam attack showed the first shape could not express. */

/** A fixture built the only way an incident can be: through the constructor.
 *
 * The old helper was an object literal setting `alertTypeId` and `ruleId` side by side —
 * which is exactly the pair the brand now forbids, and the fact that every fixture had to
 * change is the evidence that it was reachable everywhere. */
const mustRoute = (
  scope: Parameters<typeof routableIncident>[0],
  origin: IncidentOrigin,
): RoutableIncident => {
  const built = routableIncident(scope, origin)
  assert.ok(built.routable, 'fixture must be routable')
  return built.incident
}

const SCOPE = {
  incidentKey: 'k-1',
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  subjectId: 'admin-1',
}

const PRIVILEGED: IncidentOrigin = {
  kind: 'CLASSIFIED_CHANGE',
  classification: 'URGENT',
  rule: 'directory.privileged_role_assigned',
  severity: 'ACT_NOW',
}

const incident = (over: Partial<typeof SCOPE> = {}): RoutableIncident =>
  mustRoute({ ...SCOPE, ...over }, PRIVILEGED)

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  organizationId: 'org-1',
  causeKey: 'security.privileged_role_granted/admin-1',
  tier: 'PHONE',
  timing: { kind: 'HELD', until: DUE_AT, because: 'quiet hours until 07:00' },
  recipient: VERIFIED,
  tickAt: HELD_AT,
  affectedTenants: ['tenant-1'],
  incidentKeys: ['k-1'],
  ...over,
})

const outcome = (over: Partial<RoutingOutcome> = {}): RoutingOutcome => ({
  records: [],
  delivered: [],
  stillHeld: [],
  suppressed: [],
  unroutable: [],
  silencedRules: [],
  unanswered: [],
  accountingProblems: [],
  ...over,
})

test('QUIET HOURS NEED MORE THAN ONE MOMENT — held-then-sent differs from held-then-lost', () => {
  // `route(incidents, preferences, now)` carries one `now` and has no later, so a hold that
  // matures and one that is quietly forgotten are the SAME OUTPUT. Step 04's flat list one
  // feature over: there "emitted then stopped" and "never emitted" were the same input.
  const ticks: readonly RoutingTick[] = [
    { at: HELD_AT, incidents: [incident()] },
    // A TICK WITH NO INCIDENTS IS NOT A WASTED ENTRY. It is the thing that lets a hold come
    // due; without it the passage of time is not expressible at all.
    { at: DUE_AT, incidents: [] },
  ]
  assert.equal(ticks.length, 2)
  assert.equal(ticks[1]?.incidents.length, 0, 'time passing, with nothing new')

  const heldThenSent = outcome({ delivered: [delivery({ timing: { kind: 'IMMEDIATE' } })] })
  const heldThenLost = outcome({
    stillHeld: [{ delivery: delivery(), heldSince: HELD_AT, until: DUE_AT, because: 'quiet hours' }],
  })
  assert.notEqual(JSON.stringify(heldThenSent), JSON.stringify(heldThenLost),
    'the two fates must be different outputs, or a lost hold is indistinguishable from a sent one')

  // And a hold still waiting is visible as waiting, with its due time — not absent.
  assert.equal(heldThenLost.stillHeld[0]?.until.getTime(), DUE_AT.getTime())
})

test('A PROPERTY ABOUT A CONFIGURATION CANNOT BE CARRIED BY A LIST OF EVENTS', () => {
  // QA's sixth finding, and the one I would have missed. `suppressed` is EVENT-DRIVEN: an
  // entry exists only when an incident arrives on a silenced rule. So an MSP who silences a
  // rule that then never fires produces output identical to an MSP who silenced nothing and
  // had a quiet week — and silenced-and-therefore-silent is exactly the state the property
  // exists to make visible.
  const silencedButQuiet = outcome({
    silencedRules: [{
      ruleId: 'security.privileged_role_granted',
      preference: 'RECORD_ONLY',
      sentence: 'You will not be contacted about privileged role grants. They are still recorded.',
    }],
  })
  const nothingSilencedAndQuiet = outcome()

  // Both had a quiet week. Only one of them chose to.
  assert.equal(silencedButQuiet.suppressed.length, 0, 'nothing fired, so nothing was suppressed')
  assert.equal(nothingSilencedAndQuiet.suppressed.length, 0, 'nothing fired here either')
  assert.notEqual(JSON.stringify(silencedButQuiet), JSON.stringify(nothingSilencedAndQuiet),
    'the configuration is visible even when no event exercised it')

  // THE CONTROL, WITHOUT WHICH THIS PASSES BY LISTING EVERYTHING ALWAYS. An MSP who silenced
  // nothing must list nothing — a coverage section that always has entries says as little as
  // one that never does.
  assert.deepEqual(nothingSilencedAndQuiet.silencedRules, [])

  // If the answer changes when nothing happens, it is not derivable from what happened.
})

test('EVERY INCIDENT LANDS IN EXACTLY ONE BUCKET, and there is no bucket for dropped', () => {
  // The accounting identity from step 03, arriving here. An incident in NO bucket is silence
  // nobody can find; an incident in TWO is a message somebody gets twice while the record
  // says once.
  const buckets = outcome({
    delivered: [delivery({ timing: { kind: 'IMMEDIATE' }, incidentKeys: ['k-1'] })],
    stillHeld: [{
      delivery: delivery({ incidentKeys: ['k-2'] }),
      heldSince: HELD_AT, until: DUE_AT, because: 'quiet hours',
    }],
    suppressed: [{
      incidentKey: 'k-3', organizationId: 'org-1',
      ruleId: 'security.application_permission_granted',
      recordedAs: 'Recorded only, at your setting for this rule.',
    }],
  })
  const landed = [
    ...buckets.delivered.flatMap((d) => d.incidentKeys),
    ...buckets.stillHeld.flatMap((h) => h.delivery.incidentKeys),
    ...buckets.suppressed.map((s) => s.incidentKey),
  ]
  assert.equal(new Set(landed).size, landed.length, 'no incident in two buckets')
  assert.deepEqual([...landed].sort(), ['k-1', 'k-2', 'k-3'])

  // A DELIVERY LIMIT MAY AGGREGATE OR DEFER. IT MAY NEVER DROP. There is no fourth bucket to
  // put a dropped message in, so dropping cannot be written and then explained. A limit that
  // drops is silence produced by a feature whose purpose is volume — the same failure as a
  // hold that expires, and the more tempting one, because dropping is the simplest
  // implementation and looks like working as designed.
  const keys = Object.keys(outcome())
  assert.ok(!keys.some((k) => /drop/i.test(k)), 'no dropped bucket exists')
  assert.deepEqual(keys.filter((k) => ['delivered', 'stillHeld', 'suppressed'].includes(k)).sort(),
    ['delivered', 'stillHeld', 'suppressed'])
})

test('ONLY MONITORING COALESCES — a security finding never merges across tenants', () => {
  // A collector failing across fifteen tenants is ONE REASON: our collection broke, or
  // Microsoft's API did. Two privileged role grants in two tenants are TWO REASONS that happen
  // to share a rule, and coalescing them HIDES ONE BEHIND THE OTHER — the 301 defect wearing a
  // rate-limit costume.
  const collectorIn = (tenant: string) =>
    mustRoute({
      incidentKey: `k-${tenant}`, organizationId: SCOPE.organizationId,
      customerTenantId: tenant, subjectId: 'SIGN_INS',
    }, { kind: 'DECLARED_TYPE', alertTypeId: 'monitoring.collector_failing' })
  const fleet = ['tenant-1', 'tenant-2', 'tenant-3'].map(collectorIn)
  assert.equal(new Set(fleet.map(causeKeyOf)).size, 1,
    'three tenants, one broken collector, one cause')

  const grantIn = (tenant: string) =>
    incident({ incidentKey: `g-${tenant}`, customerTenantId: tenant })
  const grants = ['tenant-1', 'tenant-2', 'tenant-3'].map(grantIn)
  assert.equal(new Set(grants.map(causeKeyOf)).size, 3,
    'three tenants, three grants, three causes — even with the same actor and rule')

  // THE ASYMMETRY IS THE RULING, so assert it directly rather than leaving it to two counts
  // that happen to differ: the tenant is absent from one key and present in the other.
  assert.ok(!causeKeyOf(fleet[0]!).includes('tenant-1'), 'no tenant in a monitoring cause')
  assert.ok(causeKeyOf(grants[0]!).includes('tenant-1'), 'the tenant IS the point in a security one')

  // Different collectors are still different causes, or "one message per MSP" would collapse
  // every monitoring problem into a single message.
  assert.notEqual(
    causeKeyOf(collectorIn('tenant-1')),
    causeKeyOf({ ...collectorIn('tenant-1'), subjectId: 'AUDIT_LOGS' }))
})

test('THE MISSING FIELD STOPS THE ADDRESS, NOT THE FAN-OUT', () => {
  // A Delivery cannot be ADDRESSED to a tenant — no customerTenantId to vary, verified as a
  // compile error above. But FIFTEEN DELIVERIES EACH NAMING ONE TENANT compile fine and share
  // a cause key, and that is the 1,500 messages. So the guarantee needs an accounting rule as
  // well as a missing field.
  const cause = 'hawkview-cause/v1-monitoring-SIGN_INS'
  const fannedOut = ['tenant-1', 'tenant-2', 'tenant-3'].map((tenant) =>
    delivery({ causeKey: cause, affectedTenants: [tenant], incidentKeys: [`k-${tenant}`] }))

  const problems = fanOutProblems(fannedOut)
  assert.equal(problems.length, 1, 'one cause fanned across three messages is one problem')
  assert.match(problems[0] ?? '', /3 deliveries for one cause/)

  // The correct shape: one delivery, three tenants named inside it.
  assert.deepEqual(fanOutProblems([delivery({
    causeKey: cause, affectedTenants: ['tenant-1', 'tenant-2', 'tenant-3'],
    incidentKeys: ['k-1', 'k-2', 'k-3'],
  })]), [])

  // AND IT MUST NOT FIRE ACROSS TICKS. The same cause recurring next tick is a new message,
  // not a duplicate — a check that flagged it would make recurrence unreportable.
  assert.deepEqual(fanOutProblems([
    delivery({ causeKey: cause, tickAt: HELD_AT }),
    delivery({ causeKey: cause, tickAt: DUE_AT }),
  ]), [], 'one per cause per MSP per TICK, not once ever')

  // Nor across MSPs: two organisations with the same cause are two messages by definition.
  assert.deepEqual(fanOutProblems([
    delivery({ causeKey: cause, organizationId: 'org-1' }),
    delivery({ causeKey: cause, organizationId: 'org-2' }),
  ]), [])
})

test('HELD THEN SILENCED IS SUPPRESSED — the outcome may not assert both at once', () => {
  // An alert held under EMAIL, silenced to RECORD_ONLY while the hold is pending, then
  // maturing: delivering it makes the outcome say the message went out AND that the MSP will
  // not hear about that rule. The preference at delivery time wins.
  const contradictory = outcome({
    records: [{
      incidentKey: 'k-1', organizationId: 'org-1', customerTenantId: 'tenant-1',
      ruleId: 'security.privileged_role_granted', severity: 'ACT_NOW', category: 'SECURITY',
      deliveryOutcome: 'Delivered.', heldDeliveries: [],
    }],
    delivered: [delivery({ timing: { kind: 'IMMEDIATE' }, incidentKeys: ['k-1'] })],
    silencedRules: [{
      ruleId: 'security.privileged_role_granted',
      preference: 'RECORD_ONLY',
      sentence: 'You will not be contacted about privileged role grants. They are still recorded.',
    }],
  })
  const found = contradictions(contradictory)
  assert.equal(found.length, 1)
  assert.match(found[0] ?? '', /delivered while the standing statement says it is silenced/)

  // THE REVERSE IS ALREADY RIGHT AND STAYS: silenced on arrival then un-silenced leaves a
  // suppression in HISTORY and nothing in the standing statement. One is what happened, the
  // other is what is configured — the same distinction as coverage not being derivable from
  // events, and conflating them here would undo it.
  const unsilencedLater = outcome({
    suppressed: [{
      incidentKey: 'k-9', organizationId: 'org-1',
      ruleId: 'security.privileged_role_granted',
      recordedAs: 'Recorded only, at your setting at the time.',
    }],
    silencedRules: [],
  })
  assert.deepEqual(contradictions(unsilencedLater), [],
    'a past suppression is not a contradiction with a present setting')
})

test('AN UNROUTABLE INCIDENT IS NOT A DELIVERED ONE', () => {
  // A Delivery once took the full Recipient union, so an organisation with no verified inbox
  // produced an entry in `delivered` that satisfied the accounting identity and READ AS SERVED.
  // The bucket was honest and silence got in through a field inside it.
  const nobody = { kind: 'NONE_VERIFIED', because: 'no inbox has been verified yet' } as const

  // @ts-expect-error a delivery cannot be addressed to nobody
  const toNobody: Delivery = { ...delivery(), recipient: nobody }
  assert.ok(toNobody)

  const gap = outcome({
    unroutable: [{
      incidentKey: 'k-1', organizationId: 'org-1',
      ruleId: 'security.privileged_role_granted', recipient: nobody,
    }],
  })
  assert.equal(gap.delivered.length, 0, 'nothing was delivered')
  assert.equal(gap.unroutable.length, 1, 'and the accounting can see why')
  assert.notEqual(JSON.stringify(gap), JSON.stringify(outcome()),
    'an organisation nobody is listening to is distinguishable from one fully reached')

  // AND IT IS NOT SUPPRESSED EITHER. Suppressed means the MSP chose this; unroutable means we
  // have nobody to tell. Conflating a choice with a gap is the error this feature keeps
  // finding, one layer down each time.
  assert.equal(gap.suppressed.length, 0)
})

test('THE SWEEP — every declared rule, not the two somebody thought to check', () => {
  // The instruction was to go through all the subject/category pairs rather than the obvious
  // candidate. Driven off ALERT_CATALOG so a rule added later is covered without anybody
  // remembering to come back — a hand-written list of cases is a list of what was thought of.
  //
  // THE GENERAL SHAPE BEING SWEPT FOR: any rule whose declared subject reintroduces a
  // dimension its category branch removes. The operational branch removes the tenant; a
  // subject that IS the tenant puts it straight back.
  const pairs = new Set<string>()
  let tenantSubjected = 0

  for (const declaration of ALERT_CATALOG) {
    pairs.add(`${declaration.category}/${declaration.subject}`)
    const inTenant = (tenant: string): RoutableIncident =>
      mustRoute({
        incidentKey: `k-${declaration.id}-${tenant}`,
        organizationId: 'org-1',
        customerTenantId: tenant,
        // When the declared subject IS the tenant, the subject id is the tenant id. That is
        // the whole defect, so the fixture reproduces it rather than passing a constant.
        subjectId: declaration.subject === 'TENANT' ? tenant : 'shared-subject',
      }, { kind: 'DECLARED_TYPE', alertTypeId: declaration.id })
    const one = causeKeyOf(inTenant('tenant-1'))
    const two = causeKeyOf(inTenant('tenant-2'))

    if (declaration.category === 'SECURITY') {
      assert.notEqual(one, two,
        `${declaration.id} is SECURITY and must never coalesce across tenants`)
      assert.ok(one.includes('tenant-1'), `${declaration.id} must carry its tenant`)
      continue
    }

    assert.equal(one, two,
      `${declaration.id} is OPERATIONAL and two tenants must be one cause`)
    assert.ok(!one.includes('tenant-1') && !one.includes('tenant-2'),
      `${declaration.id} leaks a tenant into an operational cause key`)
    if (declaration.subject === 'TENANT') tenantSubjected += 1
  }

  // THE SWEEP FOUND MORE THAN THE ONE THAT WAS LOOKED AT. `monitoring.tenant_disconnected` was
  // the obvious candidate; `monitoring.consent_expiring` has the identical shape and was not
  // checked. Asserted as a count so that adding a third without handling it fails here.
  assert.equal(tenantSubjected, 2,
    'two OPERATIONAL rules declare the tenant as their subject, not one')

  // And the fixture must actually span the interesting pairs, or the loop proves little.
  assert.deepEqual([...pairs].sort(),
    ['OPERATIONAL/COLLECTOR', 'OPERATIONAL/TENANT', 'SECURITY/ACTOR', 'SECURITY/TARGET'])
})

test('THE CATEGORY COMES FROM THE DECLARATION, so a caller cannot put a tenant in or out', () => {
  // Direction 2: the tenant entered a security cause key only because a caller-supplied field
  // said SECURITY. The catalogue owns that fact and declares it beside the subject — the same
  // rule step 02 settled for the subject, one step later, because a second place for one fact
  // is free to drift.
  //
  // THE CASE THAT BITES: one subject present in several tenants — an MSP's own admin account,
  // or a vendor service principal, which is precisely the identity a fleet-wide privileged
  // change involves. Same subject, two tenants, mislabelled OPERATIONAL: one message covering a
  // privileged change in two customers, naming one of them.
  const sharedAdmin = (tenant: string): RoutableIncident =>
    mustRoute({
      incidentKey: `k-${tenant}`,
      organizationId: 'org-1',
      customerTenantId: tenant,
      subjectId: 'msp-admin@example-msp.test',
    }, PRIVILEGED)
  assert.notEqual(causeKeyOf(sharedAdmin('tenant-1')), causeKeyOf(sharedAdmin('tenant-2')),
    'the same admin in two tenants is two privileged changes, not one')

  // AND THE PAIR CANNOT BE SUPPLIED AT ALL. An object literal is not a RoutableIncident,
  // however plausible its fields, so there is no place to set a category or to pair a
  // security rule with an operational type. A field a caller can still set is DERIVABLE,
  // not derived, and only the second is what the standing rule asks for.
  // @ts-expect-error an incident cannot be written down, only derived
  const literal: RoutableIncident = {
    incidentKey: 'k-1', organizationId: 'org-1', customerTenantId: 'tenant-1',
    alertTypeId: 'monitoring.collector_failing', ruleId: 'directory.privileged_role_assigned',
    severity: 'ACT_NOW', subjectId: 'admin-1',
  }
  assert.ok(literal)

  // AND THE LIMIT OF THE BRAND, MEASURED RATHER THAN ASSUMED. A spread COPIES the brand, so
  // patching a derived incident does compile — I wrote a `@ts-expect-error` here claiming
  // otherwise and the compiler reported it unused, which is the compiler catching me making
  // the same overclaim twice in a row.
  //
  // What the brand actually gives: an incident cannot be FABRICATED, so no code path can
  // invent an inconsistent pair from nothing. What it does not give: immunity from someone
  // holding a real one and overriding a field. That is a smaller surface — it needs a valid
  // incident in hand — and it is not zero, so it is written down rather than implied.
  const patched = { ...sharedAdmin('tenant-1'), alertTypeId: 'monitoring.collector_failing' as const }
  assert.equal(causeKeyOf(patched).includes('tenant-1'), false,
    'a patched incident routes as its OVERRIDDEN type — the residual, demonstrated not hidden')

  // AND AN UNCLASSIFIED CHANGE PRODUCES NO INCIDENT, so it cannot be routed under either
  // directory type by a caller who has one to hand.
  const refused = routableIncident(SCOPE, { kind: 'CLASSIFIED_CHANGE', classification: 'UNCLASSIFIED',
    rule: 'directory.permission_unrecognised', severity: 'ACT_TODAY' })
  assert.equal(refused.routable, false)
})

test('THE TYPE IS DERIVED FROM THE CLASSIFICATION, not declared beside the rule', () => {
  // The residual: alertTypeId and ruleId were independent fields with nothing tying them, so a
  // security-natured rule paired with an operational type merged two tenants again. The
  // mapping has an owner already — the classifier's verdict is exactly the distinction the
  // catalogue's two directory types draw — so this creates no second place for the fact.
  assert.deepEqual(alertTypeForChange('URGENT'),
    { resolved: true, alertTypeId: 'security.privileged_directory_change' })
  assert.deepEqual(alertTypeForChange('ROUTINE'),
    { resolved: true, alertTypeId: 'security.routine_directory_change' })

  // AND IT DISCRIMINATES: two classifications, two types. A derivation returning one answer
  // everywhere satisfies "there is a mapping" and means nothing.
  assert.notEqual(
    alertTypeForChange('URGENT'), alertTypeForChange('ROUTINE'))

  // UNCLASSIFIED REFUSES RATHER THAN DEFAULTING. Neither privileged nor routine; picking
  // either files a real privileged change as a record or pages somebody about a read scope.
  const refused = alertTypeForChange('UNCLASSIFIED')
  assert.equal(refused.resolved, false)
  assert.match(refused.resolved ? '' : refused.because, /could not be classified/)

  // The refusal must not name a type anywhere in its sentence, or a caller reading the message
  // gets the default the type refused to give.
  for (const declared of ALERT_CATALOG) {
    assert.doesNotMatch(refused.resolved ? '' : refused.because,
      new RegExp(declared.id.replace(/\./g, '\\.')),
      `the refusal must not name ${declared.id}`)
  }
})

test('EVERY DERIVED TYPE IS ONE THE CATALOGUE DECLARES, and carries the category it needs', () => {
  // A derivation that produced an id the catalogue does not declare would fail at the first
  // causeKeyOf call rather than here, which is later and further from the cause.
  for (const classification of ['URGENT', 'ROUTINE'] as const) {
    const derived = alertTypeForChange(classification)
    assert.ok(derived.resolved)
    const declaration = alertType(derived.resolved ? derived.alertTypeId : 'monitoring.recovered')
    assert.equal(declaration.category, 'SECURITY',
      'a directory change is a security finding, so it must never coalesce across tenants')
    assert.equal(declaration.subject, 'ACTOR',
      'and its subject is who made the change')
  }

  // THE CONSEQUENCE THAT MATTERS, checked through the key rather than asserted about it: two
  // tenants stay two causes for both derived types.
  for (const classification of ['URGENT', 'ROUTINE'] as const) {
    const derived = alertTypeForChange(classification)
    assert.ok(derived.resolved)
    const inTenant = (tenant: string): RoutableIncident =>
      mustRoute({
        incidentKey: `k-${tenant}`,
        organizationId: 'org-1',
        customerTenantId: tenant,
        subjectId: 'msp-admin@example-msp.test',
      }, { kind: 'CLASSIFIED_CHANGE', classification, rule: 'directory.privileged_role_assigned',
          severity: 'ACT_NOW' })
    assert.notEqual(causeKeyOf(inTenant('tenant-1')), causeKeyOf(inTenant('tenant-2')),
      `${classification} must not coalesce the same admin across two tenants`)
  }
})

/** 05b: the three QA will check first, each made structural rather than checked. */

test('A LIMIT-INDUCED HOLD HAS NO `until` TO INVENT', () => {
  // Quiet hours release at a time — 07:00, a Date, and a person can be told it. A LIMIT
  // RELEASES WHEN VOLUME FALLS, WHICH IS NOT A TIME. Invent an `until` and the hold sits
  // forever while the incident is in exactly one bucket and every accounting identity passes:
  // SILENCE THAT SATISFIES THE BOOKS.
  const limited: Delivery = delivery({
    timing: {
      kind: 'LIMITED',
      releaseWhen: { kind: 'WHEN_VOLUME_FALLS', limit: 20, observed: 47 },
      because: '47 causes this tick, over the limit of 20.',
    },
  })
  assert.equal(limited.timing.kind, 'LIMITED')

  const invented: Delivery = delivery({
    // @ts-expect-error a limited hold has nowhere to put a timestamp
    timing: { kind: 'LIMITED', releaseWhen: { kind: 'WHEN_VOLUME_FALLS', limit: 20, observed: 47 }, because: 'x', until: DUE_AT },
  })
  assert.ok(invented)

  // AND IT IS NOT THE QUIET-HOURS SHAPE WEARING A DIFFERENT LABEL: the two timings are
  // distinguishable, so a reader can be told which kind of wait this is and therefore what
  // ends it. "Held until 07:00" and "held until volume falls" are different sentences.
  const byClock = delivery({ timing: { kind: 'HELD', until: DUE_AT, because: 'quiet hours' } })
  assert.notEqual(JSON.stringify(limited.timing), JSON.stringify(byClock.timing))
  assert.equal(byClock.timing.kind === 'HELD' ? byClock.timing.until.getTime() : 0, DUE_AT.getTime())

  // The condition names the numbers, so the sentence a person reads is checkable rather than
  // "temporarily deferred".
  const release = limited.timing.kind === 'LIMITED' ? limited.timing.releaseWhen : null
  assert.equal(release?.kind === 'WHEN_VOLUME_FALLS' ? release.observed : 0, 47)
})

test('FOLDING FLATTENS — an aggregate of aggregates cannot be constructed', () => {
  // `incidentKeys` resists nesting only one level deep, so an aggregate holding aggregates
  // loses what is inside it: silence produced by a feature whose purpose is clarity.
  const base: Aggregate = {
    organizationId: 'org-1',
    causeKey: 'monitoring.collector_failing/SIGN_INS',
    tickAt: HELD_AT,
    members: [],
  }
  const three = ['tenant-1', 'tenant-2', 'tenant-3'].reduce(
    (acc, tenant) => fold(acc, delivery({ incidentKeys: [`k-${tenant}`] })), base)

  assert.equal(three.members.length, 3)
  assert.deepEqual(incidentsCoveredBy(three), ['k-tenant-1', 'k-tenant-2', 'k-tenant-3'])

  // FOLD AGAIN AND NOTHING IS LOST — the property that a nested shape would break. Constructed
  // rather than reasoned about: the count of named incidents survives repeated folding.
  const four = fold(three, delivery({ incidentKeys: ['k-tenant-4'] }))
  assert.equal(incidentsCoveredBy(four).length, 4)
  assert.deepEqual(incidentsCoveredBy(four).slice(0, 3), incidentsCoveredBy(three),
    'folding appends; it never replaces or buries what was already named')

  // @ts-expect-error an aggregate is not a delivery, so it cannot be folded into another one
  const nested: Aggregate = fold(base, three)
  assert.ok(nested)

  // @ts-expect-error nor can members hold aggregates directly
  const nestedMembers: Aggregate = { ...base, members: [three] }
  assert.ok(nestedMembers)
})

test('THE ESCALATION INPUT HAS INCIDENTS OF ITS OWN, not a projection of what was sent', () => {
  // Derive the set from deliveries and an incident nobody was told about does not exist to
  // have a ladder — so the property passes VACUOUSLY against a correct implementation and a
  // broken one alike. Fourth instance: a property about something that did not happen cannot
  // be carried by a list of things that did.
  const tick: EscalationTick = {
    at: DUE_AT,
    notified: [{ incidentKey: 'k-1', organizationId: 'org-1', notifiedAt: HELD_AT }],
    acknowledgements: [],
  }
  assert.equal(tick.notified.length, 1)
  assert.equal(tick.acknowledgements.length, 0,
    'notified but unacknowledged is the case the ladder exists for, and it is representable')

  // THE CLOCK STARTS AT THE NOTIFICATION, NOT AT THE INCIDENT. An incident raised at 02:00 and
  // first delivered at 07:00 after quiet hours is five hours old and zero minutes notified; a
  // ladder measuring the first climbs a rung before the first message has landed.
  const raisedAt = new Date(HELD_AT.getTime() - 5 * 60 * 60 * 1000)
  assert.notEqual(tick.notified[0]?.notifiedAt.getTime(), raisedAt.getTime())
  assert.ok(tick.notified[0]?.notifiedAt !== undefined,
    'the ladder reads a notification time, and there is no incident time on this input to reach for')

  // AN ASSUMED ACKNOWLEDGEMENT HAS NO CONSTRUCTOR. "Somebody probably saw it" is not a state:
  // if it were representable, a ladder could be stopped by an inference nobody made.
  const real: Acknowledgement = { kind: 'ACKNOWLEDGED', by: 'user-7', at: DUE_AT }
  assert.equal(real.kind, 'ACKNOWLEDGED')

  // @ts-expect-error there is no ASSUMED variant
  const assumed: Acknowledgement = { kind: 'ASSUMED', because: 'the inbox was open' }
  assert.ok(assumed)

  // @ts-expect-error nor an acknowledgement without an author
  const anonymous: Acknowledgement = { kind: 'ACKNOWLEDGED', at: DUE_AT }
  assert.ok(anonymous)
})

test('EXHAUSTED IS NOT A FAILURE, and the ladder needs more than one moment', () => {
  // Exhausted means we told everybody we were told to tell. Whether it also raises something
  // to HawkView's own operators is a product question, deliberately unanswered rather than
  // defaulted into a state that reads like an error.
  const exhausted = {
    kind: 'EXHAUSTED', notifiedAt: HELD_AT, rungsClimbed: 3, lastRungAt: DUE_AT,
    because: 'Every named recipient was contacted and none acknowledged.',
  } as const satisfies EscalationState
  assert.doesNotMatch(exhausted.because, /fail|error|lost/i,
    'the sentence must not read as a malfunction — it is a completed ladder')

  // AND IT CANNOT BE WRITTEN WITHOUT THE MOMENT SOMEBODY WAS TOLD. Notification is what
  // starts the climb, so a ladder that exhausted while nobody had been notified is not a
  // state to be asserted against — it is unreachable, because the field has to be filled.
  // @ts-expect-error EXHAUSTED with nobody notified does not typecheck
  const neverTold: EscalationState = { kind: 'EXHAUSTED', rungsClimbed: 3, lastRungAt: DUE_AT,
    because: 'x' }
  assert.ok(neverTold)
  assert.equal(exhausted.notifiedAt.getTime(), HELD_AT.getTime())
  assert.ok(exhausted.lastRungAt.getTime() > exhausted.notifiedAt.getTime(),
    'the climb happens after the telling, which is the ordering the field makes checkable')

  // A LADDER ADVANCES OVER TIME, so one `now` cannot express two advances. Same
  // sequence-not-snapshot repair as quiet hours, arriving a third time in this feature.
  const ticks: readonly EscalationTick[] = [
    { at: HELD_AT, notified: [{ incidentKey: 'k-1', organizationId: 'org-1', notifiedAt: HELD_AT }],
      acknowledgements: [] },
    { at: new Date(HELD_AT.getTime() + 30 * 60 * 1000), notified: [], acknowledgements: [] },
    { at: new Date(HELD_AT.getTime() + 60 * 60 * 1000), notified: [], acknowledgements: [] },
  ]
  assert.equal(ticks.length, 3, 'two advances need three moments, and one call has one')

  // Acknowledgement stops it, permanently — and it is per INCIDENT, so acknowledging a
  // coalesced message about fifteen tenants acknowledges the cause. Flagged to PM as the
  // decision it is, rather than assumed here.
  const stopped: EscalationState = { kind: 'ACKNOWLEDGED', by: 'user-7', at: DUE_AT }
  assert.equal(stopped.kind, 'ACKNOWLEDGED')
})

test('EXHAUSTED IS DISTINCT FROM EVERY OTHER WAY A LADDER STOPS', () => {
  // A ladder can stop for reasons that mean opposite things, and only one of them is "we did
  // everything". Collapsing them is how the worst outcome the product can produce ends up
  // indistinguishable from an ordinary one.
  const terminal: readonly EscalationState[] = [
    { kind: 'ACKNOWLEDGED', by: 'user-7', at: DUE_AT },
    { kind: 'STOPPED_BY_PREFERENCE', rungsClimbed: 1, at: DUE_AT },
    { kind: 'EXHAUSTED', notifiedAt: HELD_AT, rungsClimbed: 3, lastRungAt: DUE_AT,
      because: 'Every named recipient was contacted and none acknowledged.' },
  ]
  assert.equal(new Set(terminal.map((state) => state.kind)).size, 3,
    'three ways to stop, three states')

  // STOPPED_BY_PREFERENCE IS NOT EXHAUSTED, and the difference is whose decision it was:
  // nobody was reached and we did not try everything — the MSP asked us to stop. Same
  // observable silence, opposite meanings, different remedies.
  // Written as a comparison of the two VALUES rather than of one kind against a literal: the
  // compiler rejected `stopped.kind !== 'EXHAUSTED'` as having no overlap, which is it saying
  // the assertion could not fail. A statically true assertion tests nothing, and the compiler
  // says so for free if you leave it able to.
  const stopped = terminal.filter((s) => s.kind === 'STOPPED_BY_PREFERENCE')
  const spent = terminal.filter((s) => s.kind === 'EXHAUSTED')
  assert.equal(stopped.length, 1)
  assert.equal(spent.length, 1)
  assert.notDeepEqual(stopped[0], spent[0],
    'same observable silence, opposite meanings, different remedies')
})

test('A ZERO-RUNG LADDER HAS NO CONSTRUCTOR', () => {
  // A zero-rung ladder is EXHAUSTED the moment it starts, so an incident that never escalated
  // at all would read as "we tried everything and nobody came" — the worst sentence the
  // product can produce, attached to the case where it did nothing. Third false-sentence-in-
  // the-wrong-company in this feature.
  const oneRung: LadderRungs = [{ afterMs: 15 * 60 * 1000, recipient: VERIFIED }]
  assert.equal(oneRung.length, 1)

  // @ts-expect-error a ladder with no rungs does not typecheck
  const none: LadderRungs = []
  assert.ok(none)

  // A non-empty tuple rather than a length check, because a check is a thing a later caller
  // can route around and an empty array simply is not this type.
  const three: LadderRungs = [
    { afterMs: 15 * 60 * 1000, recipient: VERIFIED },
    { afterMs: 60 * 60 * 1000, recipient: VERIFIED },
    { afterMs: 4 * 60 * 60 * 1000, recipient: VERIFIED },
  ]
  assert.equal(three.length, 3)
})

test('AN UNANSWERED LADDER REACHES THE READER WHO IS NOT LOOKING', () => {
  // A `because` is an explanation for somebody already reading that incident. The statement
  // surface exists for the reader who is not, and this is the worst thing the product can
  // report — so it goes there rather than living only inside a state machine.
  const withBoth = outcome({
    silencedRules: [{
      ruleId: 'security.privileged_role_granted', preference: 'RECORD_ONLY',
      sentence: 'You will not be contacted about privileged role grants. They are still recorded.',
    }],
    unanswered: [{
      incidentKey: 'k-1', organizationId: 'org-1',
      ruleId: 'security.privileged_directory_change',
      notifiedAt: HELD_AT, rungsClimbed: 3,
      sentence: 'Nobody answered a privileged directory change after three attempts.',
    }],
  })

  const said = statements(withBoth)
  assert.equal(said.length, 2, 'both derivations reach the one surface')
  assert.ok(said.some((s) => /Nobody answered/.test(s)))
  assert.ok(said.some((s) => /not be contacted/.test(s)))

  // TWO DERIVATIONS, ONE SURFACE, AND THEY STAY SEPARATE LISTS. One answers "what did you
  // choose not to hear" and the other "what did we tell you that nobody answered"; neither is
  // derivable from the other, and a single list would have to lie about where its entries
  // came from — the same reason coverage could not come from events.
  assert.equal(withBoth.silencedRules.length, 1)
  assert.equal(withBoth.unanswered.length, 1)

  // A quiet week with nothing unanswered says nothing, or the surface means nothing.
  assert.deepEqual(statements(outcome()), [])
})

/** L1, L2 and L4 — unbound since 05b landed because the function did not exist. */

const TICK = new Date('2026-09-02T09:00:00Z')
const NEXT = new Date('2026-09-02T09:05:00Z')
const cap = (n: number): LimitPolicy => ({ perOrganizationPerTick: n, because: 'test' })

const arriving = (n: number, over: Partial<Delivery> = {}): readonly Delivery[] =>
  Array.from({ length: n }, (_, i) =>
    delivery({ causeKey: `cause-${i}`, tier: 'EMAIL', tickAt: TICK, incidentKeys: [`k-${i}`], ...over }))

test('L1 — a limit WITHHOLDS, and every delivery is accounted for exactly once', () => {
  // A limit that drops is silence produced by a feature whose purpose is volume. There is no
  // bucket for it, and this is that stated as arithmetic rather than as a promise.
  const outcome = applyLimit([], arriving(30), cap(20), TICK)

  assert.equal(outcome.sent.length, 20)
  assert.equal(outcome.withheld.length, 10)
  assert.deepEqual(outcome.accountingProblems, [], 'in equals out')
  assert.equal(outcome.sent.length + outcome.withheld.length, 30)

  // WITHHELD CARRIES A CONDITION, NEVER AN `until`. A limit releases when volume falls, which
  // is not a time; an invented timestamp produces the hold that sits forever while every
  // accounting identity still passes.
  for (const held of outcome.withheld) {
    assert.equal(held.timing.kind, 'LIMITED')
    const release = held.timing.kind === 'LIMITED' ? held.timing.releaseWhen : null
    assert.equal(release?.kind, 'WHEN_VOLUME_FALLS')
    assert.equal(release?.kind === 'WHEN_VOLUME_FALLS' ? release.observed : 0, 30,
      'and the numbers are carried, so the sentence a person reads is checkable')
  }

  // UNDER THE LIMIT, NOTHING IS WITHHELD — or "withholds everything" satisfies the above.
  assert.equal(applyLimit([], arriving(5), cap(20), TICK).withheld.length, 0)
})

test('L1 — the most urgent go first, so a phone alert is never withheld behind a digest', () => {
  const outcome = applyLimit([], [
    ...arriving(3, { tier: 'IN_APP' }),
    ...arriving(2, { tier: 'PHONE' }).map((d, i) => ({ ...d, causeKey: `urgent-${i}` })),
  ], cap(2), TICK)

  assert.equal(outcome.sent.length, 2)
  assert.deepEqual(outcome.sent.map((d) => d.tier), ['PHONE', 'PHONE'])
  assert.deepEqual([...new Set(outcome.withheld.map((d) => d.tier))], ['IN_APP'])
})

test('L2 — what was withheld is RELEASED, and does not immediately re-trip the limit', () => {
  // A withheld delivery nobody looks at again is indistinguishable from a dropped one. "We
  // withheld it" is not a defence if nothing releases it, so release is part of the same
  // function rather than a path somebody must remember to call.
  const first = applyLimit([], arriving(30), cap(20), TICK)
  assert.equal(first.withheld.length, 10)

  const second = applyLimit(first.withheld, [], cap(20), NEXT)
  assert.equal(second.withheld.length, 0, 'the backlog drains when there is room')
  assert.equal(second.released.length, 1, 'and goes as ONE aggregate, not ten messages')
  assert.equal(second.released[0]?.members.length, 10)
  assert.deepEqual(second.accountingProblems, [])

  // NOTHING IS LOST INSIDE THE AGGREGATE — the second suspicion. Folding flattens, so every
  // incident it speaks for is still named.
  assert.deepEqual(
    [...incidentsCoveredBy(second.released[0]!)].sort(),
    first.withheld.flatMap((d) => d.incidentKeys).sort())

  // AND THE BACKLOG GOES BEFORE NEW ARRIVALS at the same tier, or a busy MSP starves its own
  // queue and the oldest alert is the last one told.
  const third = applyLimit(first.withheld, arriving(15, { causeKey: 'fresh' }), cap(12), NEXT)
  assert.equal(third.released[0]?.members.length, 10, 'all ten carried-over go first')
  assert.equal(third.sent.length, 2, 'and only the remaining room goes to new arrivals')
})

test('L4 — the limit is counted PER ORGANISATION, not across the fleet', () => {
  // Counted over the wrong scope is not a smaller limit, it is a different one. Per tenant
  // would let a hundred tenants send a hundred times the volume; across the fleet, one noisy
  // MSP would silence everybody else.
  const twoOrgs = [
    ...arriving(15).map((d) => ({ ...d, organizationId: 'org-1' })),
    ...arriving(15).map((d) => ({ ...d, organizationId: 'org-2' })),
  ]
  const outcome = applyLimit([], twoOrgs, cap(20), TICK)

  assert.equal(outcome.withheld.length, 0, 'fifteen each is under the limit for each')
  assert.equal(outcome.sent.length, 30, 'even though thirty is over it across the fleet')

  // AND ONE ORGANISATION OVER THE LIMIT DOES NOT WITHHOLD THE OTHER'S.
  const lopsided = applyLimit([], [
    ...arriving(25).map((d) => ({ ...d, organizationId: 'org-1' })),
    ...arriving(3).map((d) => ({ ...d, organizationId: 'org-2' })),
  ], cap(20), TICK)
  assert.equal(lopsided.withheld.filter((d) => d.organizationId === 'org-2').length, 0)
  assert.equal(lopsided.withheld.filter((d) => d.organizationId === 'org-1').length, 5)

  // It matches the fan-out window, so the limit and the invariant measure the same thing
  // rather than two windows that nearly agree.
  assert.deepEqual(fanOutProblems(lopsided.sent), [])
})

test('THE LIMIT NUMBER IS NOT MEASURED, and says so', () => {
  // The staleness threshold carries 5,166 runs. This carries an admission, which is the honest
  // difference — a placeholder that reads as authoritative is worse than one that reads as a
  // guess, because nobody goes back for the second kind.
  assert.match(UNMEASURED_LIMIT.because, /NOT YET MEASURED/)
  assert.match(UNMEASURED_LIMIT.because, /guess/)
  assert.ok(UNMEASURED_LIMIT.perOrganizationPerTick > 0)
})
