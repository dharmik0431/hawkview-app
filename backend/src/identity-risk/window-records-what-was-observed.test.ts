import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUTH_WINDOW_SCHEMA, AUTH_WINDOW_SCHEMA_V1, authenticationWindow,
  mergeAuthenticationWindow, windowObservation,
} from './authentication-source-readiness.js'

/**
 * A WINDOW MUST SAY WHAT IT SAW, NOT WHAT IT ASKED FOR.
 *
 * `persistCompletedAuthenticationWindow` stamps the *requested* range after a
 * successful page chain, and its own header says the metadata "contains no
 * events/identities". So a collection that returned nothing writes a window
 * ending now and advances `lastSuccessfulCollectionAt`, and a tenant that has
 * produced no authentication evidence for two weeks is indistinguishable from
 * one that produced evidence a minute ago.
 *
 * RETRACTED: the "two of five production tenants since 2026-09-10 and
 * 2026-08-30" example this was written against has been withdrawn by whoever
 * measured it -- those dates were resource-level staleness on healthy tenants,
 * stated as tenant-level. The indistinguishability above is a property of this
 * code and is unaffected; only the anecdote was wrong.
 *
 * `lastSuccessfulCollectionAt` answers *when did we last look*. Nothing answers
 * *when did we last see anything*, and that is the missing fact.
 *
 * THREE STATES, AND THE THIRD IS THE MIGRATION ITSELF. A window written before
 * this change does not know what it observed. That is not "observed nothing" —
 * it is "not recorded", and collapsing it into either would be the same defect
 * this change exists to remove, introduced by the change removing it.
 */

const iso = (offsetMinutes: number) =>
  new Date(Date.parse('2026-09-13T12:00:00.000Z') + offsetMinutes * 60_000).toISOString()

/** The exact shape production holds today, built from the v1 key set rather
 *  than from anything this change introduces. */
const v1Window = () => ({
  schemaVersion: AUTH_WINDOW_SCHEMA_V1,
  source: 'GRAPH_SIGN_INS',
  start: iso(-24 * 60),
  end: iso(0),
  paginationComplete: true,
})

test('MIGRATION GUARD: every window already in production still validates', () => {
  // The single largest risk in this change. The validator matched an exact key
  // set, so adding a field would have invalidated every stored window at once
  // and dropped all five tenants to WAITING simultaneously — an outage that
  // would read as the fix causing it.
  const parsed = authenticationWindow(v1Window())
  assert.ok(parsed, 'a v1 window stopped validating; this would take the fleet down')
  assert.equal(parsed.paginationComplete, true)
  assert.equal(parsed.source, 'GRAPH_SIGN_INS')
})

test('a v1 window reports its observation as NOT RECORDED, not as nothing', () => {
  const observation = windowObservation(authenticationWindow(v1Window())!)
  assert.equal(observation.recorded, false)
  // It must not be possible to read a count or a date off it, because there is
  // none — an undefined that renders as 0 is how this defect works.
  assert.equal('events' in observation, false)
  assert.equal('latestEventAt' in observation, false)
})

test('a v2 window carries what the collection actually observed', () => {
  const observed = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 11, latestEventAt: iso(-12) })
  assert.equal(observed.schemaVersion, AUTH_WINDOW_SCHEMA)

  const parsed = authenticationWindow(observed)
  assert.ok(parsed, 'a window this code just produced failed its own validator')
  const observation = windowObservation(parsed)
  assert.equal(observation.recorded, true)
  assert.equal(observation.recorded && observation.events, 11)
  assert.equal(observation.recorded && observation.latestEventAt, iso(-12))
})

test('OBSERVED NOTHING is a different fact from OBSERVED SOMETHING', () => {
  // The defect, stated as a value comparison. These two collections both
  // succeeded and both stamp a window ending now.
  const sawEvents = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 11, latestEventAt: iso(-12) })
  const sawNothing = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 0, latestEventAt: null })

  assert.notDeepEqual(windowObservation(sawEvents), windowObservation(sawNothing))
  // BOUND ONCE SO THE NARROWING HOLDS. `AuthenticationObservation` is a
  // discriminated union and `events` lives only on the `recorded: true` arm;
  // two calls return two values, so checking `recorded` on the first cannot
  // narrow the second. The assertion was always right, it just could not compile.
  const nothingObserved = windowObservation(sawNothing)
  assert.equal(nothingObserved.recorded, true)
  assert.equal(nothingObserved.recorded && nothingObserved.events, 0)

  // And both are different from a window that predates the field.
  const notRecorded = windowObservation(authenticationWindow(v1Window())!)
  assert.notDeepEqual(notRecorded, windowObservation(sawNothing))
})

test('THE STALLED TENANT SIGNATURE survives the window rolling forward', () => {
  // This is the production case: collection succeeds every few minutes, the
  // window advances each time, and the tenant has not produced an event for
  // days. The newest observed event must be carried FORWARD through merges, or
  // it resets to null on the first empty pass and the fact is lost immediately.
  const first = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-120)), new Date(iso(-60)), true,
    { events: 4, latestEventAt: iso(-90) })

  let rolling = first
  for (let pass = 0; pass < 3; pass += 1) {
    rolling = mergeAuthenticationWindow(
      rolling, 'GRAPH_SIGN_INS',
      new Date(Date.parse(rolling.end)), new Date(iso(-50 + pass * 10)), true,
      { events: 0, latestEventAt: null })
  }

  const observation = windowObservation(rolling)
  assert.equal(observation.recorded, true)
  assert.equal(observation.recorded && observation.events, 0,
    'the most recent pass observed nothing and should say so')
  assert.equal(observation.recorded && observation.latestEventAt, iso(-90),
    'the last time anything was observed was lost when the window rolled')
})

test('a v1 prior does not fabricate an observation history', () => {
  // Merging onto a window that predates the field must not invent a
  // latestEventAt, and must not claim the new pass inherited one.
  const merged = mergeAuthenticationWindow(
    v1Window(), 'GRAPH_SIGN_INS',
    new Date(iso(0)), new Date(iso(30)), true,
    { events: 0, latestEventAt: null })
  const observation = windowObservation(merged)
  assert.equal(observation.recorded, true, 'the new pass did record an observation')
  assert.equal(observation.recorded && observation.latestEventAt, null,
    'a v1 prior has no observation history and none may be invented from it')
})

/**
 * C3 — THE OBSERVATION BELONGS TO A SOURCE, NOT TO A TENANT.
 *
 * `mergeAuthenticationWindow` already refuses to extend a window's START across
 * a source change: the `from` calculation requires `prior.source === source`.
 * The observation carry-forward, added beside it, does not — so switching a
 * tenant between Graph sign-ins and the audit lane carries the newest event time
 * from the abandoned source into the new one.
 *
 * That is worse than losing it. The stalled-tenant signature this field exists
 * to preserve — collection current, nothing observed for days — is defeated by
 * a value describing a source we are no longer reading, and the tenant reads as
 * recently active while its live source has produced nothing at all.
 *
 * Found by Codex review.
 */
test('C3: a source change does not inherit the other source observation', () => {
  const graph = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-120)), new Date(iso(-60)), true,
    { events: 9, latestEventAt: iso(-75) })
  const graphObserved = windowObservation(graph)
  assert.equal(graphObserved.recorded && graphObserved.latestEventAt, iso(-75))

  // The tenant switches lanes. The audit source has produced nothing yet.
  const audit = mergeAuthenticationWindow(
    graph, 'M365_AUDIT_STS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 0, latestEventAt: null })

  const observation = windowObservation(audit)
  assert.equal(observation.recorded, true, 'the audit pass did record an observation')
  assert.equal(observation.recorded && observation.latestEventAt, null,
    'the audit lane inherited a Graph event time and now reads as recently active')
  assert.equal(audit.source, 'M365_AUDIT_STS')
})

test('C3 CONTROL: the same source still carries its own history forward', () => {
  // The control that stops the fix being "stop carrying anything". Same shape,
  // same rolling window, source unchanged — the value must survive.
  const first = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-120)), new Date(iso(-60)), true,
    { events: 9, latestEventAt: iso(-75) })
  const second = mergeAuthenticationWindow(
    first, 'GRAPH_SIGN_INS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 0, latestEventAt: null })

  const secondObserved = windowObservation(second)
  assert.equal(secondObserved.recorded && secondObserved.latestEventAt, iso(-75),
    'the carry-forward was removed rather than scoped')
})

test('C3: switching back does not resurrect a stale observation', () => {
  // Graph -> audit -> Graph. The Graph observation was dropped on the way out
  // and must not reappear on the way back in; the audit window is the only
  // prior the third merge can see, and it knows nothing about Graph.
  const graph = mergeAuthenticationWindow(
    null, 'GRAPH_SIGN_INS', new Date(iso(-180)), new Date(iso(-120)), true,
    { events: 9, latestEventAt: iso(-150) })
  const audit = mergeAuthenticationWindow(
    graph, 'M365_AUDIT_STS', new Date(iso(-120)), new Date(iso(-60)), true,
    { events: 0, latestEventAt: null })
  const back = mergeAuthenticationWindow(
    audit, 'GRAPH_SIGN_INS', new Date(iso(-60)), new Date(iso(0)), true,
    { events: 0, latestEventAt: null })

  const backObserved = windowObservation(back)
  assert.equal(backObserved.recorded && backObserved.latestEventAt, null,
    'a Graph event time survived a round trip through the audit lane')
})
