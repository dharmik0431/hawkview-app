import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG, PRIVILEGED_DIRECTORY_CHANGES, alertType } from './alert-catalog.js'
import { mayAutoClose, routingTier } from './alert-type.js'
import { applyObservation, OPENED } from './alert-lifecycle.js'
import { evidenceFromSync } from '../risky-users-wiring/evidence-availability.js'
import { urgencyOf, collectorLagMs, arrivedLate, eventInstant, compareByEventTime, newestByEventTime } from './alert-event-time.js'

/** What every alert type must have declared before it may exist. */

test('EVERY alert type says what makes it stop', () => {
  // "An alert type with no stated resolving condition is not ready to be built."
  // The field is required, so this cannot fail as written — which is the point.
  // It is asserted anyway because the sweep also checks the sentences are real
  // rather than placeholders, which the type cannot do.
  assert.ok(ALERT_CATALOG.length >= 7, 'the catalogue was not read')
  for (const declaration of ALERT_CATALOG) {
    assert.ok(declaration.conditionClears.kind, `${declaration.id} has no resolving condition`)
    assert.ok(
      declaration.conditionClears.because.length > 40,
      `${declaration.id} states a resolving condition without saying why it is safe`)
    assert.ok(declaration.summary.length > 0)
  }
})

test('no security type can close itself', () => {
  // Enforced by the type — declaring a SECURITY type with
  // AUTOMATICALLY_WHEN_CONDITION_CLEARS does not compile. Asserted here so the
  // guarantee is visible to a reader of the tests, and so that widening the type
  // later breaks something.
  for (const declaration of ALERT_CATALOG) {
    if (declaration.category !== 'SECURITY') continue
    assert.equal(mayAutoClose(declaration), false, `${declaration.id} must not auto-close`)
  }

  // POSITIVE CONTROL: at least one operational type DOES auto-close, so the above
  // is not passing because nothing ever auto-closes.
  assert.ok(
    ALERT_CATALOG.some((declaration) => mayAutoClose(declaration)),
    'an operational type must be able to auto-close, or holding collectors open is noise')
})

test('RECORD_ONLY types open no investigation, and everything else does', () => {
  // The pairing found by writing the catalogue. A record with nothing to do must
  // not sit in a queue only a person can empty — that is what 301 of the current
  // alerts are, and a SECURITY-category record would inherit exactly that.
  for (const declaration of ALERT_CATALOG) {
    if (declaration.severity === 'RECORD_ONLY') {
      assert.equal(declaration.opensInvestigation, false, `${declaration.id} is a record and must not open an investigation`)
    } else {
      assert.equal(declaration.opensInvestigation, true, `${declaration.id} needs acting on and must open an investigation`)
    }
  }
  // Both sides of the condition are exercised, so neither branch is vacuous.
  assert.ok(ALERT_CATALOG.some((d) => d.severity === 'RECORD_ONLY'))
  assert.ok(ALERT_CATALOG.some((d) => d.severity !== 'RECORD_ONLY'))
})

test('NO alert type escalates on volume', () => {
  // There is no OCCURRENCE_COUNT escalation signal, and that absence is the rule:
  // more of the same updates quietly. A type that could escalate on count would
  // reproduce the behaviour that turned 301 events into 301 notifications.
  const signals = ALERT_CATALOG.flatMap((declaration) => declaration.escalations.map((e) => e.signal))
  assert.ok(signals.length > 0, 'no escalations were read')
  for (const signal of signals) {
    assert.doesNotMatch(signal, /COUNT|VOLUME|OCCURRENCE/, `${signal} escalates on volume`)
  }
  // And every escalation says why it changes what the alert is.
  for (const declaration of ALERT_CATALOG) {
    for (const escalation of declaration.escalations) {
      assert.ok(escalation.because.length > 40, `${declaration.id}/${escalation.signal} does not say why`)
    }
  }
})

test('severity names an action, and the routing tier follows from it', () => {
  // Severity must describe what the recipient should do, not how bad the event
  // sounds. 301 alerts are marked `high` and have been unread for weeks.
  for (const declaration of ALERT_CATALOG) {
    assert.match(declaration.severity, /^(ACT_NOW|ACT_TODAY|RECORD_ONLY)$/)
    assert.doesNotMatch(declaration.severity, /^(info|low|medium|high|critical)$/)
  }
  assert.equal(routingTier('ACT_NOW'), 'PHONE')
  assert.equal(routingTier('ACT_TODAY'), 'EMAIL')
  assert.equal(routingTier('RECORD_ONLY'), 'IN_APP')
})

test('ids are unique and the lookup refuses an undeclared type', () => {
  const ids = ALERT_CATALOG.map((declaration) => declaration.id)
  assert.equal(new Set(ids).size, ids.length, 'two declarations share an id')
  // A throw rather than a default: a missing declaration must never resolve to
  // some other type's resolving condition.
  assert.throws(() => alertType('security.not_declared' as never), /No alert type declared/)
  // POSITIVE CONTROL: a declared id resolves.
  assert.equal(alertType('security.suspected_credential_attack').category, 'SECURITY')
})

test('the credential-attack type cannot be resolved by a quiet collector', () => {
  // The catalogue entry and the lifecycle agreeing, end to end: the declared
  // resolving condition is an absence, and the lifecycle refuses to act on an
  // absence without readable evidence.
  const attack = alertType('security.suspected_credential_attack')
  assert.equal(attack.conditionClears.kind, 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW')

  const broken = applyObservation(OPENED, {
    evidence: evidenceFromSync('FAILED'),
    conditionCleared: true,
    mayAutoCloseInvestigation: mayAutoClose(attack),
  })
  assert.equal(broken.condition, 'UNKNOWN')
  assert.equal(broken.investigation, 'OPEN')

  // POSITIVE CONTROL: with readable evidence the condition clears — and the
  // investigation still does not, because it is a security type.
  const seen = applyObservation(OPENED, {
    evidence: evidenceFromSync('SUCCESS'),
    conditionCleared: true,
    mayAutoCloseInvestigation: mayAutoClose(attack),
  })
  assert.equal(seen.condition, 'CLEARED')
  assert.equal(seen.investigation, 'OPEN')
})

test('the privileged-change policy is written down, with all three tests per entry', () => {
  // The plan lists this as an open question that must be answered before step 01
  // can finish. Revision 3 requires each phone-tier candidate to carry context,
  // persistence and urgency — a privileged role assigned during a scheduled
  // onboarding must not ring a phone, and without the context test it would.
  assert.ok(PRIVILEGED_DIRECTORY_CHANGES.length >= 3, 'the policy is empty')
  for (const rule of PRIVILEGED_DIRECTORY_CHANGES) {
    assert.ok(rule.change.length > 20, 'a rule must say what the change is')
    assert.ok(rule.context.length > 20, `${rule.change} has no context test`)
    assert.ok(rule.persistence.length > 20, `${rule.change} has no persistence test`)
    assert.ok(rule.urgency.length > 20, `${rule.change} does not say why delay makes it worse`)
  }
  // The three the plan names explicitly are all present.
  const text = PRIVILEGED_DIRECTORY_CHANGES.map((rule) => rule.change.toLowerCase()).join(' | ')
  assert.match(text, /role/)
  assert.match(text, /authentication policy/)
  assert.match(text, /permission/)
})

test('URGENCY COMES FROM THE EVENT, NOT FROM WHEN IT ARRIVED', () => {
  // One collector is 400 hours behind. A backfill must not read as an attack
  // happening now.
  const now = new Date('2026-09-11T12:00:00.000Z')
  const fourHundredHoursAgo = new Date(now.getTime() - 400 * 60 * 60 * 1000)

  // Arrived this instant; happened sixteen days ago.
  const backfilled = { occurredAt: fourHundredHoursAgo, receivedAt: now }
  assert.equal(urgencyOf(eventInstant(backfilled), now), 'HISTORICAL')
  assert.ok(arrivedLate(backfilled), 'and it is visibly a backfill')
  assert.equal(collectorLagMs(backfilled), 400 * 60 * 60 * 1000)

  // THE GUARANTEE, ASSERTED BY THE COMPILER RATHER THAN BY A CONVENTION.
  // Arrival time is not merely ignored on the decision path — it does not fit.
  // If that ever stops being true this directive goes unused and `tsc` fails, so
  // the property cannot rot quietly.
  // @ts-expect-error an arrival time must not be usable as an event instant
  urgencyOf(backfilled.receivedAt, now)

  // POSITIVE CONTROL: a live event from the SAME lagging collector is still live.
  // Lateness is a property of the feed, not of the event.
  const live = { occurredAt: new Date(now.getTime() - 5 * 60 * 1000), receivedAt: now }
  assert.equal(urgencyOf(eventInstant(live), now), 'LIVE')

  const recent = { occurredAt: new Date(now.getTime() - 2 * 60 * 60 * 1000), receivedAt: now }
  assert.equal(urgencyOf(eventInstant(recent), now), 'RECENT')
})

test('ORDER COMES FROM THE EVENT, NOT FROM ARRIVAL ORDER', () => {
  // A different mistake from using arrival TIME, and subtler. Using arrival time
  // is caught by the brand. Using arrival ORDER is not: an event delivered after a
  // backfill, whose own time is later, is the newer event — the arrival order of
  // the two is identical and only the event times differ. Code that takes "most
  // recently delivered" as "newest" is correct on every in-order feed and wrong on
  // exactly the feed we have.
  const now = new Date('2026-09-11T12:00:00.000Z')

  // Both arrive at the same instant. The backfill HAPPENED sixteen days ago; the
  // live one happened five minutes ago.
  const backfill = { occurredAt: new Date(now.getTime() - 400 * 60 * 60 * 1000), receivedAt: now }
  const live = { occurredAt: new Date(now.getTime() - 5 * 60 * 1000), receivedAt: now }

  // Delivered backfill-then-live and live-then-backfill: same answer both ways,
  // because arrival order carries no information here.
  assert.equal(newestByEventTime([backfill, live]), live)
  assert.equal(newestByEventTime([live, backfill]), live)

  assert.ok(compareByEventTime(live, backfill) > 0)
  assert.ok(compareByEventTime(backfill, live) < 0)

  // POSITIVE CONTROL: the comparator does order things, so the agreement above is
  // not a function that returns its first argument.
  const older = { occurredAt: new Date(now.getTime() - 10 * 60 * 1000), receivedAt: now }
  assert.equal(newestByEventTime([older, live]), live)
  assert.equal(newestByEventTime([]), null, 'no events is null, never a fabricated instant')
})

test('a record declares escalations, so it can become an investigation', () => {
  // "Records do not open investigations" is a default. A RECORD_ONLY type with no
  // escalation thresholds at all would be permanently un-investigable, which is
  // the dead end we were trying not to trade for.
  const records = ALERT_CATALOG.filter((declaration) => declaration.severity === 'RECORD_ONLY')
  assert.ok(records.length > 0, 'no records were read')
  assert.ok(
    records.some((declaration) => declaration.escalations.length > 0),
    'at least one record must be promotable, or records are structurally un-investigable')

  // The routine directory change specifically, since it is the one the plan's two
  // rules collided over.
  const routine = alertType('security.routine_directory_change')
  assert.equal(routine.opensInvestigation, false)
  assert.ok(routine.escalations.length > 0, 'a routine change must be able to turn out to matter')
})

test('an alert must not clear on a weaker claim than it opened on', () => {
  // tenant_disconnected specifically, because it is a phone-tier page and a page
  // that clears on a weaker signal than it fired on is how people learn to stop
  // trusting pages.
  const blind = alertType('monitoring.tenant_disconnected')
  assert.equal(blind.summary, 'HawkView cannot see this tenant')

  // The inverse of "cannot see" is "can see all of it".
  assert.equal(blind.conditionClears.kind, 'EVERY_COVERED_SOURCE_READABLE')

  // NOT the handshake: a tenant can reconnect with narrower consent, or reconnect
  // cleanly while one collector still returns PERMISSION_REQUIRED.
  assert.notEqual(blind.conditionClears.kind, 'CONNECTION_VERIFIED')
  // And NOT any-one-collector, which is the same partial visibility reworded.
  assert.notEqual(blind.conditionClears.kind, 'COLLECTOR_REPORTS_SUCCESS')

  // POSITIVE CONTROL: CONNECTION_VERIFIED is still right where the claim really is
  // about the connection rather than about seeing. Consent expiring is retracted by
  // re-consent, which a verification does observe.
  assert.equal(alertType('monitoring.consent_expiring').conditionClears.kind, 'CONNECTION_VERIFIED')
})
