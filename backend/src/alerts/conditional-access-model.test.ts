import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COLLECTED_POLICY_FIELDS,
  MODELLED_PATHS,
  mapCollectedPolicy,
  unmodelledFingerprintOf,
  type Canonicaliser,
} from './conditional-access-model.js'
import { classifyConditionalAccessChange } from './privileged-change.js'

/** The mapper and the fingerprint, which share one declaration of what is modelled. */

/** Stands in for the collection layer's canonicaliser. Identity is the WRONG wiring
 * and is used deliberately in one test below; everything else uses this, which sorts
 * the arrays Microsoft returns in arbitrary order. */
const canonicalise: Canonicaliser = (value) => {
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(walk).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
    if (typeof entry === 'object' && entry !== null) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    }
    return entry
  }
  return walk(value)
}

const policy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'policy-1',
  displayName: 'Require MFA',
  state: 'enabled',
  createdDateTime: '2026-01-01T00:00:00Z',
  modifiedDateTime: '2026-01-02T00:00:00Z',
  conditions: {
    users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
    applications: { includeApplications: ['All'] },
  },
  grantControls: { operator: 'AND', builtInControls: ['mfa', 'compliantDevice'] },
  sessionControls: null,
  ...over,
})

test('the mapper reads every modelled field from the collected policy', () => {
  const state = mapCollectedPolicy(policy(), canonicalise)
  assert.equal(state.state, 'ON')
  assert.equal(state.grantOperator, 'AND')
  assert.deepEqual(state.grantControls, ['mfa', 'compliantDevice'])
  assert.deepEqual(state.excludedUsers, [])
  assert.deepEqual(state.excludedGroups, [])
  assert.deepEqual(state.excludedRoles, [])
  assert.deepEqual(state.sessionControls, [])
  assert.equal(typeof state.unmodelledFingerprint, 'string')

  // The three exclude lists land in one array, which is why those paths are LOSSY.
  const excluded = mapCollectedPolicy(policy({
    conditions: { users: { excludeUsers: ['u1'], excludeGroups: ['g1'], excludeRoles: ['r1'] } },
  }), canonicalise)
  // KEPT APART, which is the point: merging them lost which kind was excluded.
  assert.deepEqual(excluded.excludedUsers, ['u1'])
  assert.deepEqual(excluded.excludedGroups, ['g1'])
  assert.deepEqual(excluded.excludedRoles, ['r1'])

  // An absent or unrecognised operator is null rather than guessed.
  assert.equal(mapCollectedPolicy(policy({ grantControls: {} }), canonicalise).grantOperator, null)
  assert.equal(
    mapCollectedPolicy(policy({ grantControls: { operator: 'SOMETHING_NEW' } }), canonicalise).grantOperator,
    null)
  // And case is normalised, matching effective-mfa-enforcement.
  assert.equal(mapCollectedPolicy(policy({ grantControls: { operator: 'or' } }), canonicalise).grantOperator, 'OR')
})

test('EVERY DECLARED PATH IS A FIELD THE COLLECTOR ACTUALLY STORES', () => {
  // The modelled paths must be a subset of what is collected, not of what I imagined.
  // A path naming a field the collector does not store is modelled against nothing:
  // the mapper reads undefined and the digest excludes a key that was never there.
  for (const modelled of MODELLED_PATHS) {
    const root = modelled.path[0]
    assert.ok(root !== undefined && (COLLECTED_POLICY_FIELDS as readonly string[]).includes(root),
      `${modelled.path.join('.')} is not under any collected field`)
  }

  // And every modelled path resolves on a realistic policy, so none is a typo that
  // silently reads undefined forever.
  const sample = policy({ sessionControls: { signInFrequency: { value: 1 } } })
  for (const modelled of MODELLED_PATHS) {
    let cursor: unknown = sample
    for (const segment of modelled.path) {
      assert.ok(typeof cursor === 'object' && cursor !== null, modelled.path.join('.'))
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    assert.notEqual(cursor, undefined, `${modelled.path.join('.')} resolves to undefined on a real policy`)
  }
})

test('EVERY MODELLED FIELD OF THE STATE IS FED BY A DECLARED PATH', () => {
  // A field read from somewhere undeclared would be modelled by nobody and excluded
  // from the digest by nothing — a gap in both directions at once.
  const fed = new Set(MODELLED_PATHS.map((modelled) => modelled.reads))
  const state = mapCollectedPolicy(policy(), canonicalise)
  for (const field of Object.keys(state)) {
    if (field === 'unmodelledFingerprint') continue // computed, not read from a path
    assert.ok(fed.has(field as keyof typeof state), `${field} is read from no declared path`)
  }
})

test('A LOSSLESS PATH IS EXCLUDED FROM THE DIGEST, so a modelled verdict stays reachable', () => {
  // The grant operator is fully captured by the state, so the classifier's verdict is
  // the only thing that should report it. If it also moved the digest, every grant
  // change would come back unclassified and the routine branch would be unreachable —
  // the defect that made a whole-policy digest wrong the first time.
  const before = unmodelledFingerprintOf(policy(), canonicalise)
  const flipped = unmodelledFingerprintOf(
    policy({ grantControls: { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] } }), canonicalise)
  assert.equal(flipped, before, 'an operator change must not move the digest')

  const controls = unmodelledFingerprintOf(
    policy({ grantControls: { operator: 'AND', builtInControls: ['mfa'] } }), canonicalise)
  assert.equal(controls, before, 'a grant-control change must not move the digest')
})

test('AN UNMODELLED DIMENSION MOVES THE DIGEST — the silent direction', () => {
  const before = unmodelledFingerprintOf(policy(), canonicalise)

  // A field Microsoft adds tomorrow. Nobody updates a list for this to work, which is
  // the property the whole mechanism rests on.
  assert.notEqual(
    unmodelledFingerprintOf(policy({ someDimensionAddedLater: 'changed' }), canonicalise), before)

  // An existing unmodelled field changing: the include lists, the display name, the
  // platform conditions. None of these is compared by the classifier.
  assert.notEqual(unmodelledFingerprintOf(policy({ displayName: 'Renamed' }), canonicalise), before)
  assert.notEqual(unmodelledFingerprintOf(policy({
    conditions: { users: { includeUsers: ['someone-else'] }, applications: { includeApplications: ['All'] } },
  }), canonicalise), before)
})

test('A LOSSY PATH STAYS IN THE DIGEST, because the part the projection drops is otherwise invisible', () => {
  // SESSION CONTROLS. The state models only the NAMES, so a control present with a
  // different value is a change it cannot express. Excluding this subtree would hide
  // it from the presence check (the key set is unchanged) AND from the fingerprint.
  // persistentBrowser always-to-never is the real instance: one weakens a policy and
  // one strengthens it.
  const always = policy({ sessionControls: { persistentBrowser: { isEnabled: true, mode: 'always' } } })
  const never = policy({ sessionControls: { persistentBrowser: { isEnabled: true, mode: 'never' } } })

  const mappedAlways = mapCollectedPolicy(always, canonicalise)
  const mappedNever = mapCollectedPolicy(never, canonicalise)
  assert.deepEqual(mappedAlways.sessionControls, mappedNever.sessionControls,
    'the presence check cannot tell these apart — that is the premise')
  assert.notEqual(mappedAlways.unmodelledFingerprint, mappedNever.unmodelledFingerprint,
    'so the fingerprint must')

  // And the classifier therefore reports it rather than filing it as a record.
  const verdict = classifyConditionalAccessChange(mappedAlways, mappedNever)
  assert.equal(verdict.classification, 'UNCLASSIFIED')
  assert.equal(verdict.rule, 'conditional_access.unmodelled_dimension')

  // STATE IS NO LONGER IN THIS LIST. It was lossy — three values onto a boolean — and
  // is now carried as three plus UNRECOGNISED, so it is excluded from the digest and
  // the classifier sees the transition directly. Kept here as the case that moved:
  // report-only and disabled were indistinguishable and are not any more.
  const reportOnly = mapCollectedPolicy(policy({ state: 'enabledForReportingButNotEnforced' }), canonicalise)
  const disabled = mapCollectedPolicy(policy({ state: 'disabled' }), canonicalise)
  assert.equal(reportOnly.state, 'REPORT_ONLY')
  assert.equal(disabled.state, 'OFF')
  assert.notEqual(reportOnly.state, disabled.state, 'the projection no longer loses this')
  assert.equal(reportOnly.unmodelledFingerprint, disabled.unmodelledFingerprint,
    'and because it is lossless it is excluded from the digest, so the state is the only reporter')

  // A state Microsoft has not sent before is UNRECOGNISED rather than guessed as OFF,
  // which is what keeps excluding this path honest.
  assert.equal(mapCollectedPolicy(policy({ state: 'somethingNew' }), canonicalise).state, 'UNRECOGNISED')
})

test('EVERY LOSSY PATH SAYS WHAT ITS PROJECTION DISCARDS', () => {
  // A path marked lossy without saying what was lost is a note to nobody. This is the
  // list somebody needs in order to decide whether to make a projection lossless, so
  // it has to be readable rather than a flag.
  const lossy = MODELLED_PATHS.filter((modelled) => modelled.fidelity === 'LOSSY')
  assert.equal(lossy.length, 1, 'only sessionControls, whose values we refuse to infer a direction from')
  for (const modelled of lossy) {
    assert.ok(modelled.because.length > 60, `${modelled.path.join('.')}: reasoning too thin`)
  }

  // BOTH FIDELITIES ARE PRESENT. If every path were lossy the digest would move on
  // every modelled change and routine would be unreachable; if every path were
  // lossless the distinction would be untested and the silent gap above unguarded.
  assert.ok(MODELLED_PATHS.some((m) => m.fidelity === 'LOSSLESS'))
  assert.ok(MODELLED_PATHS.some((m) => m.fidelity === 'LOSSY'))
})

test('key order is not information, but a real reordering of a LIST is the canonicaliser\'s job', () => {
  const reordered = unmodelledFingerprintOf({
    ...policy(),
    // Same policy, keys serialised in a different order.
  }, canonicalise)
  const sameContentDifferentKeyOrder = unmodelledFingerprintOf(
    Object.fromEntries(Object.entries(policy()).reverse()), canonicalise)
  assert.equal(sameContentDifferentKeyOrder, reordered,
    'a fingerprint that moves on key order cries wolf and gets widened until it stops firing')

  // THE INJECTED FUNCTION IS LOAD-BEARING, and wiring it wrong degrades the digest
  // silently toward everything reading routine. Identity is the wrong wiring: with it,
  // Microsoft returning the same array in a different order reads as a change.
  const identity: Canonicaliser = (value) => value
  const a = { ...policy(), conditions: { users: { includeUsers: ['a', 'b'] } } }
  const b = { ...policy(), conditions: { users: { includeUsers: ['b', 'a'] } } }
  assert.equal(unmodelledFingerprintOf(a, canonicalise), unmodelledFingerprintOf(b, canonicalise))
  assert.notEqual(unmodelledFingerprintOf(a, identity), unmodelledFingerprintOf(b, identity))
})

test('the fingerprint is stable and does not depend on the input being mutated', () => {
  const collected = policy()
  const first = unmodelledFingerprintOf(collected, canonicalise)
  const second = unmodelledFingerprintOf(collected, canonicalise)
  assert.equal(first, second, 'a key that varied run to run would deduplicate nothing')

  // The excluded paths are removed from a COPY. If the digest deleted from its input,
  // the caller's policy would lose its grant controls and the mapper running after it
  // would read an empty set.
  assert.deepEqual((collected.grantControls as Record<string, unknown>).builtInControls,
    ['mfa', 'compliantDevice'])
  const state = mapCollectedPolicy(collected, canonicalise)
  assert.deepEqual(state.grantControls, ['mfa', 'compliantDevice'])
})

test('A SESSION CONTROL PRESENT BUT NULL IS NOT CONFIGURED', () => {
  // Microsoft returns the whole `sessionControls` object with every control as a KEY,
  // setting the unconfigured ones to null — not omitting them. My first fixtures used
  // `sessionControls: null` wholesale, which is not the shape the Graph sends, and a
  // mutation removing the null filter survived because of it. An unrealistic fixture
  // cannot test the thing the code was written for.
  //
  // Without the filter every policy reports all four names as present, so the presence
  // comparison returns the same set for every policy and can never fire. That is a
  // guard that cannot fail, which is indistinguishable from a guard that passes.
  const graphShape = policy({
    sessionControls: {
      applicationEnforcedRestrictions: null,
      cloudAppSecurity: null,
      persistentBrowser: { isEnabled: true, mode: 'always' },
      signInFrequency: null,
    },
  })
  const state = mapCollectedPolicy(graphShape, canonicalise)
  assert.deepEqual(state.sessionControls, ['persistentBrowser'],
    'only configured controls are present; null keys are not')

  // POSITIVE CONTROL: configuring a second one IS seen, so the filter discriminates
  // rather than dropping everything.
  const two = mapCollectedPolicy(policy({
    sessionControls: {
      applicationEnforcedRestrictions: null,
      persistentBrowser: { isEnabled: true, mode: 'always' },
      signInFrequency: { value: 1, type: 'hours' },
    },
  }), canonicalise)
  assert.deepEqual(two.sessionControls, ['persistentBrowser', 'signInFrequency'])

  // And the classifier therefore sees a session-control change when one is configured,
  // which is the verdict the presence comparison exists to produce.
  const verdict = classifyConditionalAccessChange(state, two)
  assert.equal(verdict.classification, 'UNCLASSIFIED')
  assert.equal(verdict.rule, 'conditional_access.session_control_changed')
})


test('EVERY FIDELITY CLAIM IS WITNESSED, so a lossy path cannot be excluded by accident', () => {
  // THE ENFORCEMENT, rather than a label somebody wrote. Each path carries two policies
  // differing only at it, and the two fidelities make opposite predictions:
  //
  //   LOSSLESS  the state MUST differ across the pair (nothing was lost)
  //             and the digest must NOT move (it is excluded, so a modelled verdict
  //             stays reachable)
  //   LOSSY     the state must NOT differ (the loss is real)
  //             and the digest MUST move (the lost part is still visible somewhere)
  //
  // A lossy path marked lossless fails the first pair; a lossless one marked lossy
  // fails the second. The configuration that produced the grant-operator defect — a
  // dimension inside the modelled set with no backstop — cannot be written again
  // without a test going red.
  const base = policy({ sessionControls: { persistentBrowser: { isEnabled: true, mode: 'always' } } })

  for (const modelled of MODELLED_PATHS) {
    const { before, after } = modelled.witness(base)
    const mappedBefore = mapCollectedPolicy(before, canonicalise)
    const mappedAfter = mapCollectedPolicy(after, canonicalise)
    const where = `${modelled.path.join('.')} (${modelled.fidelity})`

    if (modelled.fidelity === 'LOSSLESS') {
      assert.notDeepEqual(mappedAfter[modelled.reads], mappedBefore[modelled.reads],
        `${where}: the state does NOT reflect a change here, so excluding it from the digest hides it`)
      assert.equal(mappedAfter.unmodelledFingerprint, mappedBefore.unmodelledFingerprint,
        `${where}: a lossless path must be excluded, or every modelled verdict is unreachable`)
    } else {
      assert.deepEqual(mappedAfter[modelled.reads], mappedBefore[modelled.reads],
        `${where}: declared lossy, but the state DOES capture this — it may be lossless`)
      assert.notEqual(mappedAfter.unmodelledFingerprint, mappedBefore.unmodelledFingerprint,
        `${where}: lossy and the digest does not move — invisible to both layers at once`)
    }
  }

  // The witnesses must actually perturb something, or every assertion above is vacuous.
  for (const modelled of MODELLED_PATHS) {
    const { before, after } = modelled.witness(base)
    assert.notEqual(JSON.stringify(before), JSON.stringify(after),
      `${modelled.path.join('.')}: the witness changes nothing`)
  }
})
