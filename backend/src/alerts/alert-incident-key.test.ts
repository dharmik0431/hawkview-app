import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { incidentGrouping, wouldGroupTogether, type ResolvedSubject } from './alert-incident-key.js'
import { quietIntervalIsDerived, quietIntervalMsOf } from './alert-episode-interval.js'
import type { AlertTypeDeclaration } from './alert-type.js'

/** The incident key: grouping, and unable to deduplicate. */

const declarationFor = (id: string): AlertTypeDeclaration => {
  const found = ALERT_CATALOG.find((entry) => entry.id === id)
  assert.ok(found, `no such alert type: ${id}`)
  return found
}

const CREDENTIAL_ATTACK = declarationFor('security.suspected_credential_attack')
const PRIVILEGED_CHANGE = declarationFor('security.privileged_directory_change')
const scope = { organizationId: 'org-1', customerTenantId: 'tenant-1' }
const resolved = (id: string): ResolvedSubject => ({ resolved: true, id })

test('the same subject in the same tenant is one incident', () => {
  const first = incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))
  const second = incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))
  assert.equal(wouldGroupTogether(first, second), true)

  // POSITIVE CONTROL: a different subject is a different incident, so grouping is
  // discriminating rather than a key that collapses everything.
  assert.equal(
    wouldGroupTogether(first, incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-2'))),
    false)
})

test('ONE ADMIN TOUCHING TWELVE ACCOUNTS IS ONE INCIDENT', () => {
  // The failure the ACTOR declaration exists to prevent: keying a privileged
  // directory change on the target would page twelve times for one compromise.
  // Twelve events, twelve different targets, one actor.
  const groupings = Array.from({ length: 12 }, () =>
    incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('compromised-admin')))
  // The 'ungrouped' string NARROWS THE TYPE HERE AND IS NOT A BUCKET. Every grouping in
  // this test resolves, so it is never produced — but it is the idiom anybody wiring this
  // will copy, and as a real key it would put every unattributable event in a tenant into
  // one incident, which is the merge the resolved/unresolved split exists to prevent.
  // `wouldGroupTogether` returns false for two non-grouping events precisely so that
  // collapse cannot happen through a comparison; a sentinel would reintroduce it through
  // a map key instead.
  const distinct = new Set(groupings.map((g) => (g.groups ? g.key : 'ungrouped')))
  assert.equal(distinct.size, 1, 'twelve changes by one actor must be one incident')
})

test('AN UNRESOLVABLE SUBJECT DOES NOT GROUP, and two of them are not each other', () => {
  const unattributed: ResolvedSubject = { resolved: false, why: 'initiatedBy absent' }
  const first = incidentGrouping(PRIVILEGED_CHANGE, scope, unattributed)
  assert.equal(first.groups, false)

  // The whole point. Merging on "unknown" would assert these are the same incident
  // on the strength of not knowing who did either one.
  const second = incidentGrouping(PRIVILEGED_CHANGE, scope, { resolved: false, why: 'initiatedBy unresolvable' })
  assert.equal(wouldGroupTogether(first, second), false,
    'two unattributed events are two incidents of one event each, not one incident')

  // And the reason is carried rather than discarded, so the unattributed set can be
  // measured and shrunk instead of quietly accumulating.
  assert.equal(first.groups === false && first.why, 'initiatedBy absent')

  // POSITIVE CONTROL: resolving the subject does group, so "does not group" is
  // about the subject and not a function that never groups.
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1')),
      incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))),
    true)
})

test('THE SAME SUBJECT IN TWO TENANTS IS TWO INCIDENTS', () => {
  const ours = incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))
  for (const other of [
    { organizationId: 'org-2', customerTenantId: 'tenant-1' },
    { organizationId: 'org-1', customerTenantId: 'tenant-2' },
  ]) {
    assert.equal(wouldGroupTogether(ours, incidentGrouping(PRIVILEGED_CHANGE, other, resolved('admin-1'))),
      false, JSON.stringify(other))
  }

  // A separator inside a component must not shift a boundary and forge another
  // tenant's incident — the subject is attacker-influenced in a way an event id is
  // not, so this matters more here than at the event layer.
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(PRIVILEGED_CHANGE, { organizationId: 'x:y', customerTenantId: 'z' }, resolved('a')),
      incidentGrouping(PRIVILEGED_CHANGE, { organizationId: 'x', customerTenantId: 'y:z' }, resolved('a'))),
    false)
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1')),
      incidentGrouping(PRIVILEGED_CHANGE, { organizationId: 'org-1', customerTenantId: 'tenant-1' }, resolved('admin-1'))),
    true)
})

test('two alert types about the same person are two incidents', () => {
  // A credential attack against an account and a directory change by that account
  // are different situations. No per-class key can express the correlation, which
  // is a deliberate and recorded loss rather than an oversight.
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(CREDENTIAL_ATTACK, scope, resolved('person-1')),
      incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('person-1'))),
    false)

  // THE DISCRIMINATING PAIR. The two above differ in BOTH type id and declared
  // role, so that assertion passes even with the type id dropped from the key —
  // the role alone separates them. Mutation testing found exactly that: removing
  // `declaration.id` from the key left every test green.
  //
  // These two share a role (both ACTOR) and differ only in id, so they isolate it.
  const privileged = declarationFor('security.privileged_directory_change')
  const routine = declarationFor('security.routine_directory_change')
  assert.equal(privileged.subject, routine.subject, 'the pair must agree on role to isolate the id')
  assert.notEqual(privileged.id, routine.id)
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(privileged, scope, resolved('person-1')),
      incidentGrouping(routine, scope, resolved('person-1'))),
    false,
    'a privileged change and a routine change by one actor are not one incident')
})

test('A TYPE WHOSE DECLARED ROLE CHANGES DOES NOT MERGE WITH ITS OLD GROUPING', () => {
  // Why the role is in the key even though it is derivable from the type id today.
  // If a declaration's role is ever changed, events keyed under the old role must
  // not join episodes keyed under the new one — that would merge "who did this"
  // with "who it was done to" inside one incident, silently, at the moment of a
  // one-word edit.
  //
  // Same id, different declared role. Nothing else differs, so this isolates the
  // role component the way the pair above isolates the id.
  const asActor: AlertTypeDeclaration = { ...PRIVILEGED_CHANGE, subject: 'ACTOR' }
  const asTarget: AlertTypeDeclaration = { ...PRIVILEGED_CHANGE, subject: 'TARGET' }
  assert.equal(asActor.id, asTarget.id)
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(asActor, scope, resolved('person-1')),
      incidentGrouping(asTarget, scope, resolved('person-1'))),
    false)

  // POSITIVE CONTROL: the same role does group, so the role is being compared
  // rather than the key being different every call.
  assert.equal(
    wouldGroupTogether(
      incidentGrouping(asActor, scope, resolved('person-1')),
      incidentGrouping({ ...PRIVILEGED_CHANGE, subject: 'ACTOR' }, scope, resolved('person-1'))),
    true)
})

test('THE INCIDENT KEY CANNOT DEDUPLICATE, and that is the point', () => {
  // It contains no event identifier, so two distinct events from the same actor
  // produce the SAME key — which is grouping working correctly and deduplication
  // being structurally impossible here. The event key does that job.
  const first = incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))
  const second = incidentGrouping(PRIVILEGED_CHANGE, scope, resolved('admin-1'))
  assert.equal(first.groups && second.groups && first.key === second.key, true)
})

test('EVERY DECLARED TYPE DECLARES THE ROLE IT WAS RULED TO HAVE', () => {
  // "Not all the same" was the first version of this, and mutation testing walked
  // through it: setting every ACTOR to TARGET left two other roles in the catalogue,
  // so the set still had more than one member and the assertion passed while three
  // types were wrong. Variety is not correctness.
  //
  // Pinned per type instead. A change to any one of these is a change to the
  // grouping an MSP sees, so it should require editing this table and saying why.
  const RULED: Readonly<Record<string, string>> = {
    // The account being attacked: the failures come from many addresses and often
    // resolve to nothing, so the attacker is not a subject that groups.
    'security.suspected_credential_attack': 'TARGET',
    // One compromised administrator touching twelve accounts is ONE incident.
    'security.privileged_directory_change': 'ACTOR',
    'security.routine_directory_change': 'ACTOR',
    // Nobody performed these and nothing was targeted.
    'monitoring.tenant_disconnected': 'TENANT',
    'monitoring.consent_expiring': 'TENANT',
    // Per feed: two collectors failing for two reasons are two fixes, and TENANT
    // here would merge them into one incident.
    'monitoring.collector_failing': 'COLLECTOR',
    'monitoring.recovered': 'COLLECTOR',
  }

  for (const declaration of ALERT_CATALOG) {
    assert.equal(declaration.subject, RULED[declaration.id], declaration.id)
  }
  // And the table covers the catalogue rather than a subset of it, so adding a type
  // without ruling its role fails here instead of passing unnoticed.
  assert.deepEqual(
    [...ALERT_CATALOG].map((d) => d.id).sort(), Object.keys(RULED).sort())
})

test('THE QUIET INTERVAL IS DERIVED, and a type without one fails loudly', () => {
  // Derived from the declared resolving condition, so there is nothing to drift.
  assert.equal(quietIntervalMsOf(CREDENTIAL_ATTACK), 24 * 60 * 60 * 1000)

  // THE DECLARATION IS READ, not matched by a constant that happens to agree. The
  // only declared window in the catalogue is 24 hours, so asserting 24 hours does
  // not distinguish "derived" from "hardcoded" — a mutation replacing the
  // computation with `24 * 60 * 60 * 1000` passed every test. A second window that
  // differs is what settles it.
  const withWindow = (windowHours: number): AlertTypeDeclaration => ({
    ...CREDENTIAL_ATTACK,
    // Explicit, because spreading a declaration of union type could otherwise carry
    // an `episodeInterval` into a quiet-timeout variant — the exact combination
    // `EpisodeGrouping` forbids. The compiler caught this when the union landed.
    episodeInterval: undefined,
    conditionClears: {
      kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW',
      windowHours,
      because: 'A second window, to prove the declared value is the one used.',
    },
  })
  assert.equal(quietIntervalMsOf(withWindow(48)), 48 * 60 * 60 * 1000)
  assert.equal(quietIntervalMsOf(withWindow(1)), 60 * 60 * 1000)
  assert.notEqual(quietIntervalMsOf(withWindow(48)), quietIntervalMsOf(withWindow(24)))

  // The OTHER path: a type resolving on an observation declares its interval, and
  // that number is read too. It is not a fallback — there is no timeout to derive
  // from, and a default would be a second constant no reviewer ever sees.
  assert.equal(quietIntervalMsOf(PRIVILEGED_CHANGE), 24 * 60 * 60 * 1000)
  assert.equal(quietIntervalIsDerived(PRIVILEGED_CHANGE), false)
  assert.equal(quietIntervalIsDerived(CREDENTIAL_ATTACK), true)

  // And the declared number is READ rather than matched by a constant. Same trap as
  // the derived path: every declared interval in the catalogue is 24h today, so
  // asserting 24h cannot tell "reads the declaration" from "returns 24".
  const withDeclared = (hours: number): AlertTypeDeclaration => ({
    ...PRIVILEGED_CHANGE,
    // The condition is pinned alongside the interval. Spreading a declaration of
    // union type and setting only the interval could produce a quiet-timeout variant
    // carrying one, which the union forbids — the compiler caught that too.
    conditionClears: { kind: 'CONFIGURATION_RESTORED', because: 'Synthetic, for this test.' },
    episodeInterval: { hours, because: 'A second interval, to prove the declared value is used.' },
  })
  assert.equal(quietIntervalMsOf(withDeclared(72)), 72 * 60 * 60 * 1000)
  assert.notEqual(quietIntervalMsOf(withDeclared(72)), quietIntervalMsOf(withDeclared(24)))
})

test('THE CENSUS: every declared type can produce an episode interval', () => {
  // This asserted ONE of seven when the interval could only be derived. Six types
  // resolve on an observation and had no window, including both directory-change
  // types — the 301-alert and 334-occurrence cases this step exists to fix. So
  // episodes were underivable for exactly the types that needed them.
  //
  // The ruling that followed split the rule: derive where the concept is the same,
  // declare where it is a different fact. The number moving from 1 to 7 IS that
  // decision, which is why the test was written to fail when it changed.
  const derived = ALERT_CATALOG.filter(quietIntervalIsDerived).map((d) => d.id)
  const declared = ALERT_CATALOG.filter((d) => !quietIntervalIsDerived(d)).map((d) => d.id)

  assert.equal(derived.length + declared.length, 7)
  assert.deepEqual(derived, ['security.suspected_credential_attack'])
  assert.equal(declared.length, 6)

  // Every type, both paths, a usable interval. No type falls through.
  for (const declaration of ALERT_CATALOG) {
    const interval = quietIntervalMsOf(declaration)
    assert.ok(interval > 0, `${declaration.id} has no usable interval`)
    assert.ok(Number.isFinite(interval), declaration.id)
  }

  // BOTH PATHS ARE LIVE. If every type took one path the other would be dead code
  // and the union protecting it would be untested — the same reason a per-type
  // subject where every type agrees is a global answer in disguise.
  assert.ok(derived.length > 0 && declared.length > 0)

  // Collected once, with `in` rather than the boolean helper, because a boolean does
  // not narrow a union whose other member has no such property at all.
  const declaredIntervals = ALERT_CATALOG.flatMap((entry) =>
    'episodeInterval' in entry ? [{ id: entry.id, interval: entry.episodeInterval }] : [])
  assert.equal(declaredIntervals.length, 6)

  // Every DECLARED interval states its reasoning, and says whether the number was
  // measured. "24 hours" with no evidence is an assertion, and whoever revisits it
  // needs to know which of these rests on a measurement and which does not — those
  // are different claims and they should not look alike.
  for (const { id, interval } of declaredIntervals) {
    assert.ok(interval.because.length > 80, `${id}: reasoning too thin to be reasoning`)
    assert.match(interval.because, /MEASURED|NOT measured/, `${id} does not say whether it was measured`)
  }

  // The measured ones carry the DISTRIBUTION rather than the conclusion, so the valley
  // is visible to the next reader instead of being taken on trust.
  const measured = declaredIntervals.filter(({ interval }) => interval.because.startsWith('MEASURED'))
  assert.equal(measured.length, 2, 'both directory-change types rest on the gap measurement')
  for (const { id, interval } of measured) {
    assert.match(interval.because, /761 gaps/, id)
    assert.match(interval.because, /78%/, id)
    // The SHAPE, however it is worded — 'bimodal' or 'valley' both say it, and
    // requiring one of them would assert the prose rather than the content.
    assert.match(interval.because, /bimodal|valley/i, id)
  }

  // And the four that were NOT measured say so plainly rather than borrowing the
  // credibility of the two that were. Taking 24h for one notion of quiet across the
  // product is a reason; it is not evidence about those types.
  assert.equal(declaredIntervals.length - measured.length, 4)
  for (const { id, interval } of declaredIntervals) {
    if (interval.because.startsWith('MEASURED')) continue
    assert.match(interval.because, /NOT measured/, id)
    assert.doesNotMatch(interval.because, /761 gaps/, `${id} must not cite a measurement it does not have`)
  }
})

test('THE COMPILER DECIDES WHICH PATH A TYPE TAKES, not a reviewer', () => {
  // Built from an explicit literal rather than by spreading a catalogue entry. A
  // spread of `AlertTypeDeclaration` is a union, so the result could match either
  // variant and the directives below would be testing something vaguer than the rule.
  const OBSERVATION = {
    id: 'synthetic.observation_type',
    severity: 'RECORD_ONLY',
    subject: 'TENANT',
    summary: 'A synthetic type, used only to check what the compiler permits.',
    escalations: [],
    opensInvestigation: false,
    category: 'OPERATIONAL',
    conditionClears: { kind: 'CONFIGURATION_RESTORED', because: 'Synthetic.' },
  } as const

  const TIMEOUT = {
    ...OBSERVATION,
    conditionClears: {
      kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW',
      windowHours: 24,
      because: 'Synthetic.',
    },
  } as const

  // POSITIVE CONTROLS FIRST. Both correct forms must compile, or the two directives
  // below could be firing for a missing field I forgot rather than for the rule —
  // which is the failure mode of every @ts-expect-error written in isolation.
  const observationWithInterval: AlertTypeDeclaration = {
    ...OBSERVATION,
    episodeInterval: { hours: 24, because: 'Synthetic, and long enough to read as reasoning.' },
  }
  const timeoutWithoutInterval: AlertTypeDeclaration = TIMEOUT
  assert.ok(observationWithInterval.episodeInterval)
  assert.ok(timeoutWithoutInterval)

  // An observation type may not OMIT the interval: no type inherits one silently.
  // @ts-expect-error an observation type must declare its episode interval
  const missing: AlertTypeDeclaration = OBSERVATION
  assert.ok(missing)

  // A quiet-timeout type may not ALSO declare one: two numbers meaning the same
  // thing is the case the derivation exists to prevent.
  // @ts-expect-error a quiet-timeout type derives its interval and may not declare one
  const twoNumbers: AlertTypeDeclaration = {
    ...TIMEOUT,
    episodeInterval: { hours: 1, because: 'A second number meaning the same thing.' },
  }
  assert.ok(twoNumbers)

  // Both directives are guarantees rather than comments: if either combination stops
  // being an error, the directive goes unused and the build fails saying so.
})
