import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { incidentGrouping, wouldGroupTogether, type ResolvedSubject } from './alert-incident-key.js'
import { hasQuietInterval, quietIntervalMsOf, NoQuietIntervalDeclared } from './alert-episode-interval.js'
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
    conditionClears: {
      kind: 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW',
      windowHours,
      because: 'A second window, to prove the declared value is the one used.',
    },
  })
  assert.equal(quietIntervalMsOf(withWindow(48)), 48 * 60 * 60 * 1000)
  assert.equal(quietIntervalMsOf(withWindow(1)), 60 * 60 * 1000)
  assert.notEqual(quietIntervalMsOf(withWindow(48)), quietIntervalMsOf(withWindow(24)))

  // A type declaring no window throws rather than substituting a plausible number.
  assert.throws(() => quietIntervalMsOf(PRIVILEGED_CHANGE), NoQuietIntervalDeclared)
  assert.equal(hasQuietInterval(PRIVILEGED_CHANGE), false)
  assert.equal(hasQuietInterval(CREDENTIAL_ATTACK), true)
})

test('THE CENSUS: how many declared types can derive an episode interval', () => {
  // NOT a coverage assertion — a MEASUREMENT, recorded because the answer decides
  // whether step 02 can group the types it was built for.
  //
  // Deriving the interval from the declared resolving condition is right, and only
  // ONE of the seven declared types states a window. The two that cannot are
  // security.privileged_directory_change and security.routine_directory_change —
  // which are precisely the 301-alerts and 334-occurrences cases that motivated
  // this step. Episodes are therefore underivable for the types that need them
  // most, and that is a declaration gap rather than a flaw in the derivation: the
  // repair is to declare windows on those types, not to default one here.
  const withInterval = ALERT_CATALOG.filter(hasQuietInterval).map((d) => d.id)
  const without = ALERT_CATALOG.filter((d) => !hasQuietInterval(d)).map((d) => d.id)

  assert.deepEqual(withInterval, ['security.suspected_credential_attack'])
  assert.equal(without.length, 6)
  assert.ok(without.includes('security.privileged_directory_change'))
  assert.ok(without.includes('security.routine_directory_change'))

  // This test is expected to CHANGE when windows are declared. It fails loudly at
  // that moment, which is the point: the number moving is the decision being taken,
  // and nobody should be able to take it without noticing.
})
