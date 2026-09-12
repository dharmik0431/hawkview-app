import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import {
  causeKeyOf,
  contradictions,
  defaultPreference,
  fanOutProblems,
  type CoverageStatement,
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

const incident = (over: Partial<RoutableIncident> = {}): RoutableIncident => ({
  incidentKey: 'k-1',
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  alertTypeId: 'security.privileged_directory_change',
  ruleId: 'directory.privileged_role_assigned',
  severity: 'ACT_NOW',
  subjectId: 'admin-1',
  ...over,
})

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
  const collectorIn = (tenant: string) => incident({
    incidentKey: `k-${tenant}`, customerTenantId: tenant,
    alertTypeId: 'monitoring.collector_failing', ruleId: 'monitoring.collector_failing',
    subjectId: 'SIGN_INS', severity: 'ACT_TODAY',
  })
  const fleet = ['tenant-1', 'tenant-2', 'tenant-3'].map(collectorIn)
  assert.equal(new Set(fleet.map(causeKeyOf)).size, 1,
    'three tenants, one broken collector, one cause')

  const grantIn = (tenant: string) => incident({
    incidentKey: `g-${tenant}`, customerTenantId: tenant,
    alertTypeId: 'security.privileged_directory_change',
    ruleId: 'directory.privileged_role_assigned', subjectId: 'admin-1',
  })
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
    const inTenant = (tenant: string): RoutableIncident => ({
      incidentKey: `k-${declaration.id}-${tenant}`,
      organizationId: 'org-1',
      customerTenantId: tenant,
      alertTypeId: declaration.id,
      ruleId: declaration.id,
      severity: declaration.severity,
      // When the declared subject IS the tenant, the subject id is the tenant id. That is the
      // whole defect, so the fixture has to reproduce it rather than passing a constant.
      subjectId: declaration.subject === 'TENANT' ? tenant : 'shared-subject',
    })
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
  const sharedAdmin = (tenant: string): RoutableIncident => ({
    incidentKey: `k-${tenant}`,
    organizationId: 'org-1',
    customerTenantId: tenant,
    alertTypeId: 'security.privileged_directory_change',
    ruleId: 'directory.privileged_role_assigned',
    severity: 'ACT_NOW',
    subjectId: 'msp-admin@example-msp.test',
  })
  assert.notEqual(causeKeyOf(sharedAdmin('tenant-1')), causeKeyOf(sharedAdmin('tenant-2')),
    'the same admin in two tenants is two privileged changes, not one')

  // @ts-expect-error there is no `category` on an incident for a caller to assert
  const asserted: RoutableIncident = { ...sharedAdmin('tenant-1'), category: 'OPERATIONAL' }
  assert.ok(asserted)

  // @ts-expect-error nor an alert type the catalogue does not declare
  const undeclared: RoutableIncident = { ...sharedAdmin('tenant-1'), alertTypeId: 'security.invented' }
  assert.ok(undeclared)
})
