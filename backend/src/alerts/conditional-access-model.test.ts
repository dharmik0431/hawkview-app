import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COLLECTED_POLICY_FIELDS,
  MODELLED_PATHS,
  mapCollectedPolicy,
  unmodelledFingerprintOf,
  type Canonicaliser,
  type ModelledPath,
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
  assert.deepEqual(state.grantControls, { values: ['mfa', 'compliantDevice'], unreadable: 0 })
  for (const list of [state.excludedUsers, state.excludedGroups, state.excludedRoles]) {
    assert.deepEqual(list, { values: [], unreadable: 0 })
  }
  assert.deepEqual(state.sessionControls, [])
  assert.equal(typeof state.unmodelledFingerprint, 'string')

  // The three exclude lists land in one array, which is why those paths are LOSSY.
  const excluded = mapCollectedPolicy(policy({
    conditions: { users: { excludeUsers: ['u1'], excludeGroups: ['g1'], excludeRoles: ['r1'] } },
  }), canonicalise)
  // KEPT APART, which is the point: merging them lost which kind was excluded.
  assert.deepEqual(excluded.excludedUsers.values, ['u1'])
  assert.deepEqual(excluded.excludedGroups.values, ['g1'])
  assert.deepEqual(excluded.excludedRoles.values, ['r1'])

  // An absent or unrecognised operator is null rather than guessed.
  // ABSENT, not null: the policy states no operator. Distinct from UNRECOGNISED below,
  // because no-operator is normal for a session-controls-only policy and an unreadable
  // one never is.
  assert.equal(mapCollectedPolicy(policy({ grantControls: {} }), canonicalise).grantOperator, 'ABSENT')
  assert.equal(
    mapCollectedPolicy(policy({ grantControls: { operator: 'SOMETHING_NEW' } }), canonicalise).grantOperator,
    'UNRECOGNISED')
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
  // A TRIPWIRE, NOT A TEST, and worth reading as one. It fails on ANY change to the
  // table including a legitimate one — which is the point: somebody changing a fidelity
  // has to state the new count deliberately rather than have it drift. It proves nothing
  // about correctness on its own, so do not read a green here as the table being right;
  // the witnessed-fidelity test is what checks that.
  assert.equal(lossy.length, 1, "only sessionControls, whose values we refuse to infer a direction from")
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
  assert.deepEqual(state.grantControls.values, ['mfa', 'compliantDevice'])
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


test('A LIST REPORTS WHAT IT COULD NOT READ, in all three cases', () => {
  // The silent drop this replaces: a filter that discarded every non-string entry,
  // in four places, all excluded from the digest. The three cases matter separately
  // and the middle one is what a bare filter gets wrong.
  const read = (value: unknown) =>
    mapCollectedPolicy(policy({ grantControls: { operator: 'AND', builtInControls: value } }), canonicalise)
      .grantControls

  // Absent: nothing there and nothing unread.
  assert.deepEqual(read(undefined), { values: [], unreadable: 0 })

  // A list: its strings, plus a count of everything else. Microsoft sending a
  // structured control where a string used to be is the case with no backstop.
  assert.deepEqual(read(['mfa', { authenticationStrength: 'phishingResistant' }, 'compliantDevice']),
    { values: ['mfa', 'compliantDevice'], unreadable: 1 })

  // NOT A LIST AT ALL: zero read and ONE unread — never "nothing was there", which is
  // what a bare Array.isArray guard returns and is a silent drop of the whole field.
  assert.deepEqual(read({ builtInControls: 'mfa' }), { values: [], unreadable: 1 })
  assert.deepEqual(read('mfa'), { values: [], unreadable: 1 })
})

test('THE LOSSLESS LABEL IS CONSTRAINED BY THE TARGET TYPE, not by the witness', () => {
  // ITEM 2, and the reason it exists: a witness is one pair chosen by the author, so an
  // author can always find a pair that passes. This constraint is a property of the
  // field the path feeds, which no choice of example can satisfy.
  //
  // A LOSSLESS path may only feed a field that can represent "there was more here than
  // I captured" — a null member, an UNRECOGNISED member, or an unreadable count.

  // POSITIVE CONTROLS FIRST, or the directive below could be firing for an unrelated
  // reason. All three capable shapes are accepted.
  const capable: readonly ModelledPath[] = [
    { path: ['state'], fidelity: 'LOSSLESS', reads: 'state', because: 'x'.repeat(70), witness: base => ({ before: base, after: base }) },
    { path: ['x'], fidelity: 'LOSSLESS', reads: 'grantOperator', because: 'x'.repeat(70), witness: base => ({ before: base, after: base }) },
    { path: ['y'], fidelity: 'LOSSLESS', reads: 'grantControls', because: 'x'.repeat(70), witness: base => ({ before: base, after: base }) },
  ]
  assert.equal(capable.length, 3)

  // sessionControls is a bare string[] — it cannot say "there was more here", which is
  // exactly QA's boolean-over-a-subtree in a different costume. LOSSLESS is unavailable.
  // The directive sits on the DECLARATION because that is where TypeScript reports the
  // union mismatch — it names `reads` as incompatible with LosslessCapableField rather
  // than blaming the fidelity line. Worth knowing: a directive on the field I expected
  // to be at fault went unused, and an unused directive fails the build, which is how I
  // found out rather than guessing.
  // @ts-expect-error a LOSSLESS path may not feed a field that cannot report an unread remainder
  const refused: ModelledPath = {
    path: ['sessionControls'],
    fidelity: 'LOSSLESS',
    reads: 'sessionControls',
    because: 'x'.repeat(70),
    witness: base => ({ before: base, after: base }),
  }
  assert.ok(refused)

  // And the same field IS available as LOSSY, so the constraint is about the
  // combination rather than about the field being unusable.
  const allowed: ModelledPath = {
    path: ['sessionControls'], fidelity: 'LOSSY', reads: 'sessionControls',
    because: 'x'.repeat(70), witness: base => ({ before: base, after: base }),
  }
  assert.ok(allowed)

  // The shipped table still satisfies it, and every lossless path feeds a capable field.
  for (const modelled of MODELLED_PATHS) {
    if (modelled.fidelity !== 'LOSSLESS') continue
    assert.ok(['state', 'grantOperator', 'grantControls', 'excludedUsers', 'excludedGroups', 'excludedRoles']
      .includes(modelled.reads), modelled.reads)
  }
})

test('A TRUNCATED SNAPSHOT DOES NOT SILENCE A REAL FINDING', () => {
  // THE REACHABILITY PATH, end to end through the mapper rather than by setting the
  // mapped state directly. Every other test for this set `state: 'UNAVAILABLE'` on the
  // state object, so none of them exercised the mapper's own distinction — and a mutation
  // putting an absent field back onto UNRECOGNISED survived all of them. Asserting the
  // classifier's behaviour while injecting the value the mapper was supposed to choose
  // is the instrument sitting below the level where the value is decided.
  //
  // This is the case QA described: no Microsoft vocabulary change, just a field missing
  // from the payload. Before the ordering fix it turned an unambiguous role exclusion
  // into impact-unknown, which is "the worse collection gets, the quieter alerting gets".
  const complete = policy({
    conditions: { users: { excludeUsers: [], excludeGroups: [], excludeRoles: [] } },
  })
  const truncated: Record<string, unknown> = {
    ...policy({ conditions: { users: { excludeUsers: [], excludeGroups: [], excludeRoles: ['role-1'] } } }),
  }
  delete truncated.state

  const before = mapCollectedPolicy(complete, canonicalise)
  const after = mapCollectedPolicy(truncated, canonicalise)

  // The mapper distinguishes absent from unrecognised — which a test that sets the
  // mapped value itself can never check.
  assert.equal(after.state, 'UNAVAILABLE')
  assert.notEqual(after.state, 'UNRECOGNISED')

  // And the real finding survives the truncation.
  const verdict = classifyConditionalAccessChange(before, after)
  assert.equal(verdict.classification, 'URGENT')
  assert.equal(verdict.rule, 'conditional_access.role_excluded')

  // With no finding present, the truncation IS the report — and it says the field was
  // not read rather than not understood.
  const quiet = mapCollectedPolicy((() => {
    const copy: Record<string, unknown> = { ...complete }
    delete copy.state
    return copy
  })(), canonicalise)
  const onlyTruncation = classifyConditionalAccessChange(before, quiet)
  assert.equal(onlyTruncation.rule, 'conditional_access.policy_state_unavailable')
  assert.match(onlyTruncation.because, /collected/i)

  // A null state field is the same fact as an absent one: Microsoft sends both.
  assert.equal(mapCollectedPolicy(policy({ state: null }), canonicalise).state, 'UNAVAILABLE')
  // POSITIVE CONTROL: an unknown WORD is still unrecognised, so the split discriminates.
  assert.equal(mapCollectedPolicy(policy({ state: 'somethingNew' }), canonicalise).state, 'UNRECOGNISED')
})

test('A SESSION-CONTROLS-ONLY POLICY IS NOT REPORTED AS UNREADABLE', () => {
  // The case the operator split exists to protect. A policy with session controls and no
  // grant controls is legitimate and common; its operator is absent because there is
  // nothing to combine. Forcing impact-unknown on it would be noise generated by a safety
  // rule, which is how safety rules get removed.
  const sessionOnly = (controls: Record<string, unknown>) => policy({
    grantControls: null,
    sessionControls: controls,
  })

  const before = mapCollectedPolicy(sessionOnly({ signInFrequency: { value: 1, type: 'hours' } }), canonicalise)
  assert.equal(before.grantOperator, 'ABSENT', 'no controls to combine means no operator, not an unreadable one')
  assert.deepEqual(before.grantControls, { values: [], unreadable: 0 })

  // Unchanged: routine, and specifically NOT an impact-unknown verdict about the operator.
  const unchanged = classifyConditionalAccessChange(before, before)
  assert.equal(unchanged.classification, 'ROUTINE', unchanged.because)
  assert.doesNotMatch(unchanged.rule, /operator/, unchanged.rule)

  // A session control changing on such a policy reports the session control — the finding
  // that is actually there — rather than the absent operator.
  const after = mapCollectedPolicy(sessionOnly({ persistentBrowser: { isEnabled: true, mode: 'always' } }), canonicalise)
  const changed = classifyConditionalAccessChange(before, after)
  assert.equal(changed.rule, 'conditional_access.session_control_changed', changed.because)

  // POSITIVE CONTROL: the same absent operator WITH grant controls present is undirectable
  // and does report, because then there genuinely is something we cannot direct. That is
  // what makes the exemption about the combination rather than about the value.
  const withControls = mapCollectedPolicy(
    policy({ grantControls: { builtInControls: ['mfa', 'compliantDevice'] } }), canonicalise)
  assert.equal(withControls.grantOperator, 'ABSENT')
  const removal = mapCollectedPolicy(policy({ grantControls: { builtInControls: ['mfa'] } }), canonicalise)
  const undirectable = classifyConditionalAccessChange(withControls, removal)
  assert.equal(undirectable.classification, 'UNCLASSIFIED')
  assert.equal(undirectable.rule, 'conditional_access.grant_operator_absent')
  assert.match(undirectable.because, /no operator/i)
})


test('AN OPERATOR THAT IS NOT A STRING IS UNREADABLE, not absent', () => {
  // A mutation mapping a non-string operator to ABSENT survived every test: nothing
  // exercised it. Absent means the policy did not state one; a number or an object means
  // Microsoft sent something we could not read, which is a fact about our read and must
  // carry the impact-unknown rule.
  for (const raw of [7, true, { operator: 'AND' }, ['AND']]) {
    const mapped = mapCollectedPolicy(
      policy({ grantControls: { operator: raw, builtInControls: ['mfa'] } }), canonicalise)
    assert.equal(mapped.grantOperator, 'UNRECOGNISED', JSON.stringify(raw))
  }

  // POSITIVE CONTROL, both directions: a real operator reads, and a missing one is ABSENT.
  assert.equal(
    mapCollectedPolicy(policy({ grantControls: { operator: 'and', builtInControls: ['mfa'] } }), canonicalise)
      .grantOperator, 'AND')
  assert.equal(
    mapCollectedPolicy(policy({ grantControls: { builtInControls: ['mfa'] } }), canonicalise)
      .grantOperator, 'ABSENT')
})

test('A POLICY GAINING ITS FIRST GRANT CONTROLS IS NOT DESCRIBED AS OPERATOR-LESS', () => {
  // What the controls-present guard actually protects, and a mutation dropping that guard
  // survived until this existed. The verdict is unclassified either way — what changes is
  // the SENTENCE, and without the guard we would say "states grant controls but no
  // operator" about the side that has neither.
  const none = mapCollectedPolicy(policy({ grantControls: null }), canonicalise)
  const some = mapCollectedPolicy(
    policy({ grantControls: { operator: 'AND', builtInControls: ['mfa'] } }), canonicalise)

  const gained = classifyConditionalAccessChange(none, some)
  assert.equal(gained.classification, 'UNCLASSIFIED')
  assert.equal(gained.rule, 'conditional_access.grant_controls_absent',
    'the empty set is the accurate description of this transition, not a missing operator')
  assert.notEqual(gained.rule, 'conditional_access.grant_operator_absent')

  // And the reverse — losing them entirely — is described the same way.
  assert.equal(
    classifyConditionalAccessChange(some, none).rule, 'conditional_access.grant_controls_absent')

  // Whereas controls present on BOTH sides with no operator IS the operator-less case.
  const twoControls = mapCollectedPolicy(
    policy({ grantControls: { builtInControls: ['mfa', 'compliantDevice'] } }), canonicalise)
  const oneControl = mapCollectedPolicy(
    policy({ grantControls: { builtInControls: ['mfa'] } }), canonicalise)
  assert.equal(
    classifyConditionalAccessChange(twoControls, oneControl).rule,
    'conditional_access.grant_operator_absent')
})
