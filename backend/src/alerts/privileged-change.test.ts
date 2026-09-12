import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPECTED_ONBOARDING_PERMISSIONS,
  classifyConditionalAccessChange,
  classifyDirectoryChange,
  type ClassificationContext,
  type ConditionalAccessState,
  CHANGE_RULES,
  type ChangeRule,
} from './privileged-change.js'
import { MICROSOFT_APPLICATION_PERMISSIONS } from '../microsoft/microsoft-access-contract.js'

/** Which directory changes are privileged. */

const OURS = '11111111-2222-3333-4444-555555555555'
const THEIRS = '99999999-8888-7777-6666-555555555555'
const context: ClassificationContext = { hawkviewApplicationId: OURS }

test('HAWKVIEW IS NOT EXEMPT BY APPLICATION ID ALONE', () => {
  // The defect that would have made HawkView the one blind spot in the tenant: an
  // unexpected permission increase to our own registration is the most alarming
  // event there is, and suppressing by AppId would have said nothing about it.
  const expected = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: OURS,
    permissions: ['User.Read.All', 'AuditLog.Read.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(expected.classification, 'ROUTINE', 'our own onboarding set is expected')

  // The SAME application, one permission outside the set we request.
  const escalated = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: OURS,
    permissions: ['User.Read.All', 'Application.ReadWrite.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(escalated.classification, 'URGENT', 'a permission we never request is not our onboarding')

  // And a credential added to our own registration is evaluated like anyone's,
  // because the exemption covers permissions we request and a credential is not one.
  assert.equal(
    classifyDirectoryChange({ kind: 'APPLICATION_CREDENTIAL_ADDED', applicationId: OURS }, context).classification,
    'URGENT')
})

test('the expected set is DERIVED from the access contract, not copied', () => {
  // So it cannot drift from what HawkView actually requests. A hand-written copy
  // would go stale the first time a permission is added, and go stale silently.
  for (const permission of MICROSOFT_APPLICATION_PERMISSIONS) {
    assert.ok(
      EXPECTED_ONBOARDING_PERMISSIONS.has(permission.name),
      `${permission.name} is requested but not in the expected set`)
  }
  assert.equal(EXPECTED_ONBOARDING_PERMISSIONS.size, MICROSOFT_APPLICATION_PERMISSIONS.length)
})

test('THE TWO CONSENT RULES CANNOT DISAGREE, because there is only one', () => {
  // The regression. The policy had a row saying tenant-wide consent raises ANY
  // permission to urgent, and a correction two rows below saying tenant-wide
  // consent is not urgent by itself — both in the same table. Scope MULTIPLIES a
  // sensitive permission and never promotes a routine one.
  //
  // Measured: tenant-wide admin consent fires 47 times in production, because
  // consenting on behalf of all users is how an administrator approves an app.
  const routineTenantWide = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['User.Read.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(routineTenantWide.classification, 'ROUTINE', 'tenant-wide scope must not promote a routine permission')

  // Same permission, narrower scope: also routine. Scope changed nothing.
  const routineSingle = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['User.Read.All'],
    scope: 'SINGLE_PRINCIPAL',
  }, context)
  assert.equal(routineSingle.classification, routineTenantWide.classification)

  // POSITIVE CONTROL: a SENSITIVE permission is urgent at either scope, and the
  // tenant-wide one says so in its reason. Without this the assertions above would
  // also pass against a classifier that never escalates.
  for (const scope of ['TENANT_WIDE', 'SINGLE_PRINCIPAL', 'UNKNOWN'] as const) {
    const sensitive = classifyDirectoryChange({
      kind: 'APPLICATION_PERMISSION_GRANT',
      applicationId: THEIRS,
      permissions: ['AppRoleAssignment.ReadWrite.All'],
      scope,
    }, context)
    assert.equal(sensitive.classification, 'URGENT', scope)
  }
  assert.match(
    classifyDirectoryChange({
      kind: 'APPLICATION_PERMISSION_GRANT',
      applicationId: THEIRS,
      permissions: ['AppRoleAssignment.ReadWrite.All'],
      scope: 'TENANT_WIDE',
    }, context).because,
    /tenant-wide/i,
    'scope should amplify the reason even though it does not change the classification')
})

test('UNCLASSIFIED NEVER RESOLVES TO ROUTINE', () => {
  // The regression. A permission missing from the sensitive list is not thereby
  // read-only — that is absence of evidence read as evidence of absence, which this
  // product refuses everywhere else.
  const unknownPermission = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['SomeNewThing.Invented.ByMicrosoft'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(unknownPermission.classification, 'UNCLASSIFIED')
  assert.notEqual(unknownPermission.classification, 'ROUTINE')
  // The token is carried so the unclassified set can be surfaced and shrunk rather
  // than accumulating.
  assert.equal(unknownPermission.unknown, 'SomeNewThing.Invented.ByMicrosoft')

  // A grant mixing known-routine with unrecognised is still unclassified — the
  // recognised half must not carry the unrecognised one.
  assert.equal(
    classifyDirectoryChange({
      kind: 'APPLICATION_PERMISSION_GRANT',
      applicationId: THEIRS,
      permissions: ['User.Read.All', 'SomeNewThing.Invented.ByMicrosoft'],
      scope: 'SINGLE_PRINCIPAL',
    }, context).classification,
    'UNCLASSIFIED')

  // POSITIVE CONTROL: an all-known grant IS routine, so the above is about the
  // unrecognised token rather than a classifier that never says routine.
  assert.equal(
    classifyDirectoryChange({
      kind: 'APPLICATION_PERMISSION_GRANT',
      applicationId: THEIRS,
      permissions: ['User.Read.All'],
      scope: 'SINGLE_PRINCIPAL',
    }, context).classification,
    'ROUTINE')
})

test('unclassified routes at email tier — except an unresolvable role', () => {
  // Otherwise every permission string Microsoft invents rings somebody at 2am and
  // the tier decays exactly the way this plan exists to prevent.
  const unknownPermission = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['SomeNewThing.Invented.ByMicrosoft'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(unknownPermission.severity, 'ACT_TODAY')

  // THE EXCEPTION. The activity has already told us this is a privilege grant;
  // only the magnitude is unknown, which is not a reason to wait.
  const unresolvableRole = classifyDirectoryChange(
    { kind: 'ROLE_ASSIGNMENT', roleTemplateId: null, roleIsPrivileged: null }, context)
  assert.equal(unresolvableRole.classification, 'UNCLASSIFIED')
  assert.equal(unresolvableRole.severity, 'ACT_NOW')

  // A custom role whose privilege cannot be determined is the same case.
  const customRole = classifyDirectoryChange(
    { kind: 'ROLE_ASSIGNMENT', roleTemplateId: 'custom-role-id', roleIsPrivileged: null }, context)
  assert.equal(customRole.severity, 'ACT_NOW')

  // POSITIVE CONTROL: a resolvable, non-privileged role is routine, so the above is
  // about the unresolvable half.
  assert.equal(
    classifyDirectoryChange(
      { kind: 'ROLE_ASSIGNMENT', roleTemplateId: 'known', roleIsPrivileged: false }, context).classification,
    'ROUTINE')
})

test('the two escalation paths are described correctly', () => {
  // The factual correction, and it was the example the whole policy argument rested
  // on. Application.ReadWrite.All confers CREDENTIAL MANAGEMENT — add a credential
  // to another registration and authenticate as it. AppRoleAssignment.ReadWrite.All
  // is the one that manages permission GRANTS. Both sensitive, different mechanisms.
  const credentialPath = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['Application.ReadWrite.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.match(credentialPath.because, /credential/i)
  assert.doesNotMatch(
    credentialPath.because,
    /grant itself every other permission|grant itself any permission/i,
    'the corrected description must not reappear')

  const grantPath = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['AppRoleAssignment.ReadWrite.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.match(grantPath.because, /grant/i)
})

test('nothing is asserted benign, and no coverage is claimed for another component', () => {
  // Both were unverified claims. MFA registration is also how somebody with stolen
  // credentials registers their own authenticator. And "caught by the
  // credential-attack detector, not here" was a claim about another component's
  // coverage that was never checked.
  for (const kind of ['AUTH_METHOD_REGISTERED', 'ADMIN_PASSWORD_RESET'] as const) {
    const classified = classifyDirectoryChange({ kind }, context)
    assert.equal(classified.classification, 'ROUTINE', `${kind} is routine by default`)
    // Routine by default is not a claim of safety, and the reason says so.
    assert.doesNotMatch(classified.because, /benign|harmless|safe|the good outcome/i, kind)
    // And no claim about what any other detector covers.
    assert.doesNotMatch(classified.because, /detector|covered by|caught by/i, kind)
  }
})

const policy = (over: Partial<ConditionalAccessState> = {}): ConditionalAccessState => ({
  state: 'ON',
  grantOperator: 'AND',
  grantControls: ['mfa', 'compliantDevice'],
  excludedUsers: [],
  excludedGroups: [],
  excludedRoles: [],
  sessionControls: [],
  unmodelledFingerprint: 'same',
  ...over,
})

test('REMOVING A GRANT CONTROL DOES NOT ALWAYS WEAKEN THE POLICY', () => {
  // The technically wrong test in the original rule. Grant controls combine with OR
  // or AND, and removing one from an OR set removes an ALTERNATIVE way to satisfy
  // the policy — which makes it stricter, not weaker.
  const fromAnd = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND' }),
    policy({ grantOperator: 'AND', grantControls: ['mfa'] }))
  assert.equal(fromAnd.classification, 'URGENT', 'removing a REQUIREMENT weakens it')

  const fromOr = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR' }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(fromOr.classification, 'ROUTINE', 'removing an ALTERNATIVE does not weaken it')
  assert.match(fromOr.because, /alternative/i)

  // Operator unknown: we cannot tell which happened, so we say so.
  const unknownOperator = classifyConditionalAccessChange(
    policy({ grantOperator: null }),
    policy({ grantOperator: null, grantControls: ['mfa'] }))
  assert.equal(unknownOperator.classification, 'UNCLASSIFIED')
  assert.match(unknownOperator.because, /impact unknown/i)
})

test('conditional access needs before and after, and says so when it lacks them', () => {
  for (const [before, after] of [[null, policy()], [policy(), null], [null, null]] as const) {
    const classified = classifyConditionalAccessChange(before, after)
    assert.equal(classified.classification, 'UNCLASSIFIED')
    assert.match(classified.because, /change detected; impact unknown/i)
  }

  // POSITIVE CONTROL: with both present it does classify, so the above is the
  // missing evidence rather than a function that never decides.
  assert.equal(
    classifyConditionalAccessChange(policy(), policy()).classification,
    'ROUTINE')
})

test('disabling a policy and excluding a principal are both weakening', () => {
  assert.equal(
    classifyConditionalAccessChange(policy(), policy({ state: 'OFF' })).classification,
    'URGENT')
  assert.equal(
    classifyConditionalAccessChange(policy(), policy({ excludedUsers: ['user-1'] })).classification,
    'URGENT')

  // POSITIVE CONTROL: removing an exclusion is not weakening.
  assert.equal(
    classifyConditionalAccessChange(policy({ excludedUsers: ['user-1'] }), policy()).classification,
    'ROUTINE')
})

test('A SESSION-CONTROL-ONLY CHANGE MUST NOT COME BACK ROUTINE', () => {
  // The production event that proved the old fallback wrong: a policy with session
  // controls and NO grant controls at all. It moved nothing the comparison models,
  // fell off the end, and was called routine. Sign-in frequency and persistent
  // browser are where a session is extended from an hour to weeks.
  const changed = classifyConditionalAccessChange(
    policy({ grantControls: [], grantOperator: null, sessionControls: ['signInFrequency'] }),
    policy({ grantControls: [], grantOperator: null, sessionControls: [] }))
  assert.equal(changed.classification, 'UNCLASSIFIED')
  assert.equal(changed.unknown, 'session-controls')
  assert.match(changed.because, /impact unknown/i)

  // Adding one is equally unknown: the direction depends on values this does not
  // capture, so presence alone cannot be read either way.
  assert.equal(
    classifyConditionalAccessChange(
      policy({ sessionControls: [] }),
      policy({ sessionControls: ['persistentBrowser'] })).classification,
    'UNCLASSIFIED')
})

test('a change in a dimension nothing models is unclassified, not routine', () => {
  // Correction 3, one function deeper. Unlisted is not harmless and unmodelled is
  // not harmless either — "we did not look at that" must never resolve to "it was
  // fine".
  const unmodelled = classifyConditionalAccessChange(
    policy({ unmodelledFingerprint: 'before' }),
    policy({ unmodelledFingerprint: 'after' }))
  assert.equal(unmodelled.classification, 'UNCLASSIFIED')
  assert.equal(unmodelled.unknown, 'unmodelled-dimension')

  // POSITIVE CONTROL: with everything identical there is nothing unaccounted for,
  // so routine is reachable and this is not a function that never says yes.
  assert.equal(classifyConditionalAccessChange(policy(), policy()).classification, 'ROUTINE')
})

test('routine requires the modelled dimensions to be the ones that moved', () => {
  // The OR-removal case must still reach routine — it is the correction that made
  // the whole function necessary, and my first attempt at the unmodelled check made
  // it unreachable by digesting the whole policy instead of only the unmodelled part.
  const orRemoval = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR' }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(orRemoval.classification, 'ROUTINE')
  assert.match(orRemoval.because, /alternative/i)

  // But the same OR removal WITH something unmodelled also moving is unclassified:
  // a modelled change that does not weaken must not vouch for an unmodelled one.
  const both = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR', unmodelledFingerprint: 'before' }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'], unmodelledFingerprint: 'after' }))
  assert.equal(both.classification, 'UNCLASSIFIED')

  // And a weakening still outranks an unknown — the urgent answer is the one that
  // matters when both are true.
  assert.equal(
    classifyConditionalAccessChange(
      policy({ unmodelledFingerprint: 'before' }),
      policy({ state: 'OFF', unmodelledFingerprint: 'after' })).classification,
    'URGENT')
})

test('URGENT AND UNCLASSIFIED SAY HOW SOON TO LOOK, NOT THAT SOMETHING IS WRONG', () => {
  // The same discipline the plan already holds for lockouts: suspected, never
  // confirmed. Unclassified means nobody has decided what a permission is; an
  // unresolved role means an identifier did not resolve. Urgency is about how soon
  // somebody should look, not about how likely it is that something is wrong.
  //
  // Scoped to the outcomes where an accusation would be unfounded — UNCLASSIFIED,
  // and the unresolvable-role case that is urgent despite being unclassified.
  const accusations = /\b(malicious|compromis|breach|unauthoris|unauthoriz|intrusion|wrongdoing|suspicious|rogue)/i

  const unclassifiedOutcomes = [
    classifyDirectoryChange({
      kind: 'APPLICATION_PERMISSION_GRANT',
      applicationId: THEIRS,
      permissions: ['SomeNewThing.Invented.ByMicrosoft'],
      scope: 'TENANT_WIDE',
    }, context),
    classifyDirectoryChange({ kind: 'ROLE_ASSIGNMENT', roleTemplateId: null, roleIsPrivileged: null }, context),
    classifyDirectoryChange({ kind: 'ROLE_ASSIGNMENT', roleTemplateId: 'custom', roleIsPrivileged: null }, context),
    classifyConditionalAccessChange(null, policy()),
    classifyConditionalAccessChange(policy({ grantOperator: null }), policy({ grantOperator: null, grantControls: ['mfa'] })),
    classifyConditionalAccessChange(policy({ sessionControls: ['signInFrequency'] }), policy({ sessionControls: [] })),
    classifyConditionalAccessChange(policy({ unmodelledFingerprint: 'a' }), policy({ unmodelledFingerprint: 'b' })),
    // The two paths the operator fix added. A sweep that says "every unclassified
    // path" and enumerates stops being true the moment one is added, which is the
    // same rot as a comment that counts.
    classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: [] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] })),
    classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'block'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] })),
  ]

  assert.equal(unclassifiedOutcomes.length, 9, 'the sweep must cover every unclassified path')
  for (const outcome of unclassifiedOutcomes) {
    assert.equal(outcome.classification, 'UNCLASSIFIED', outcome.because)
    assert.doesNotMatch(outcome.because, accusations, outcome.because)
    // And it must not claim harm the way an earlier draft did: "unrecognised is
    // not harmless" asserts that it IS harmful, which is the same overreach in
    // four words.
    assert.doesNotMatch(outcome.because, /\bis not harmless\b/i, outcome.because)
  }

  // POSITIVE CONTROL: the pattern does match accusation-shaped text, so the sweep
  // above is not passing against a regex that matches nothing.
  assert.match('a malicious actor compromised the tenant', accusations)
})

test('no outcome claims an act occurred rather than describing a capability', () => {
  // The sensitive-permission reasons describe what a permission ENABLES. Saying a
  // permission "is exfiltration" reads as an assertion about what happened, and an
  // earlier draft said exactly that.
  const sensitive = classifyDirectoryChange({
    kind: 'APPLICATION_PERMISSION_GRANT',
    applicationId: THEIRS,
    permissions: ['Mail.ReadWrite', 'Application.ReadWrite.All'],
    scope: 'TENANT_WIDE',
  }, context)
  assert.equal(sensitive.classification, 'URGENT')
  assert.doesNotMatch(sensitive.because, /\bis exfiltration\b/i)
  // Capability language instead: what the holder CAN do.
  assert.match(sensitive.because, /can /i)
})


/** THE GRANT-CONTROL TRANSITION MATRIX.
 *
 * Derived from Microsoft's semantics rather than from what the code returns:
 * AND(S) needs every control in S, OR(S) needs at least one, and a policy is WEAKER
 * when more sessions pass it. QA pre-registered the same eleven transitions at
 * c30f648 before this fix existed; these were written from the semantics and then
 * checked against theirs, which is why the two agree without either being shaped by
 * the other.
 *
 * A weakening is URGENT here. UNCLASSIFIED means "changed, impact undetermined", and
 * for these transitions the impact is determined exactly — understating what we know
 * would be its own inaccuracy.
 */
type Transition = readonly [
  name: string,
  before: Partial<ConditionalAccessState>,
  after: Partial<ConditionalAccessState>,
  weakens: boolean,
]

const TRANSITIONS: readonly Transition[] = [
  ['AND -> OR, two controls',
    { grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] },
    { grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }, true],
  ['OR -> AND, two controls',
    { grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] },
    { grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }, false],
  ['control added to an OR policy',
    { grantOperator: 'OR', grantControls: ['mfa'] },
    { grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }, true],
  ['control removed from an OR policy',
    { grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] },
    { grantOperator: 'OR', grantControls: ['mfa'] }, false],
  ['control added to an AND policy',
    { grantOperator: 'AND', grantControls: ['mfa'] },
    { grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }, false],
  ['control removed from an AND policy',
    { grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] },
    { grantOperator: 'AND', grantControls: ['mfa'] }, true],
  ['DEGENERATE: AND -> OR, single control',
    { grantOperator: 'AND', grantControls: ['mfa'] },
    { grantOperator: 'OR', grantControls: ['mfa'] }, false],
  ['DEGENERATE: OR -> AND, single control',
    { grantOperator: 'OR', grantControls: ['mfa'] },
    { grantOperator: 'AND', grantControls: ['mfa'] }, false],
  ['COMPOUND: AND -> OR and a control added',
    { grantOperator: 'AND', grantControls: ['mfa'] },
    { grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }, true],
  ['COMPOUND: AND -> OR and a control removed',
    { grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] },
    { grantOperator: 'OR', grantControls: ['mfa'] }, true],
  ['no grant change at all', {}, {}, false],
]

test('EVERY WEAKENING OF THE GRANT CONTROLS IS URGENT, AND NO TIGHTENING IS', () => {
  for (const [name, before, after, weakens] of TRANSITIONS) {
    const verdict = classifyConditionalAccessChange(policy(before), policy(after))
    assert.equal(verdict.classification, weakens ? 'URGENT' : 'ROUTINE',
      `${name}: got ${verdict.classification} — ${verdict.because}`)
  }

  // MIRROR. Without it "no weakening is routine" is satisfied by a classifier that
  // never says routine at all, which would bury the queue and pass every row above.
  assert.ok(
    TRANSITIONS.some(([, before, after, weakens]) =>
      !weakens && classifyConditionalAccessChange(policy(before), policy(after)).classification === 'ROUTINE'),
    'routine must stay reachable or the matrix proves nothing')
})

test('THE OPERATORS ARE EQUIVALENT ON A SINGLE CONTROL, and the record says why', () => {
  // "All of [mfa]" and "any of [mfa]" are the same requirement. A fix reading
  // "AND to OR is urgent" breaks exactly here, and this cell passed BEFORE the fix
  // only because no operator comparison happened at all — so it is the one place a
  // correct-looking fix regresses something that already worked.
  const flip = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(flip.classification, 'ROUTINE')
  assert.match(flip.because, /same requirement/i)

  // And it is not routine because the comparison gave up: two controls, same flip,
  // is urgent. That is what makes the single-control answer a judgement rather than
  // a blind spot.
  assert.equal(
    classifyConditionalAccessChange(
      policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] })).classification,
    'URGENT')
})

test('A COMPOUND WEAKENING NAMES EVERY RULE THAT FIRED, not the first', () => {
  // AND [mfa, cd] -> OR [mfa] is urgent under TWO rules: the operator relaxed, and a
  // requirement was removed. It was already urgent before this fix, but only because
  // the removal rule tripped first — the operator was never examined. An
  // implementation returning whichever reason it reached first would keep the
  // verdict green while the reason underneath it moved, which is the changed-subject
  // failure we have hit twice. Asserting both reasons is what makes that impossible.
  const both = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(both.classification, 'URGENT')
  assert.match(both.because, /now alternatives/i, 'the operator relaxation must be named')
  assert.match(both.because, /requirement is gone/i, 'the removed requirement must be named')

  // The other compound: operator relaxed AND an alternative added.
  const added = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }))
  assert.equal(added.classification, 'URGENT')
  assert.match(added.because, /now alternatives/i)
  assert.match(added.because, /one more way to satisfy/i)
})

test('ROUTINE SAYS WHAT WAS COMPARED, never that nothing weakened it', () => {
  // The sentence that stood over three weakenings was "none of them weakened it" —
  // a positive safety claim across every dimension at once, including the operator
  // the function never compared. A reader cannot audit a claim that does not say
  // what it rests on.
  const unchanged = classifyConditionalAccessChange(policy(), policy())
  assert.equal(unchanged.classification, 'ROUTINE')
  assert.doesNotMatch(unchanged.because, /none of them weakened/i)

  for (const [name, before, after, weakens] of TRANSITIONS) {
    if (weakens) continue
    const verdict = classifyConditionalAccessChange(policy(before), policy(after))
    assert.doesNotMatch(verdict.because, /none of them weakened/i, name)
    // Every routine record names the dimensions it checked, so the claim is
    // auditable rather than a blanket reassurance.
    assert.match(verdict.because, /grant (control|operator)/i, name)
    assert.match(verdict.because, /session controls are unchanged/i, name)
    assert.match(verdict.because, /does not model is identical/i, name)
  }
})

test('A DENIAL CONTROL HAS NO DIRECTION UNDER THE OPERATOR SEMANTICS', () => {
  // `block` is a grant control in Microsoft's model and HawkView renders it as
  // "Block access", so it can share the array with `mfa`. It is not an alternative
  // way to SATISFY the policy, so removing it from an OR set would be a weakening
  // where removing anything else is a tightening — every rule reads backwards.
  //
  // Not in QA's matrix and not in the report. Found by sweeping for the shape of the
  // operator defect rather than fixing the instance: a modelled field whose
  // direction is never computed.
  const removedBlock = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR', grantControls: ['mfa', 'block'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(removedBlock.classification, 'UNCLASSIFIED',
    'removing a denial from an OR set must not be filed as removing an alternative')
  assert.equal(removedBlock.unknown, 'grant-denial-control')

  const addedBlock = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa', 'block'] }))
  assert.equal(addedBlock.classification, 'UNCLASSIFIED')

  // POSITIVE CONTROL: the same shape with an ordinary control is NOT undetermined,
  // so this is about denial semantics and not a gate that gave up on any change.
  assert.equal(
    classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] })).classification,
    'ROUTINE')
})

test('AND AND OR INVERT AT THE EMPTY SET, so an empty side is undetermined', () => {
  // AND over no controls requires nothing and admits everything; OR over no controls
  // admits nothing. The two operators mean opposite things there, so every rule
  // would read the wrong way round. Microsoft does not permit a policy with neither
  // grant nor session controls, which makes this a state to report rather than
  // interpret.
  const fromEmpty = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR', grantControls: [] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }))
  assert.equal(fromEmpty.classification, 'UNCLASSIFIED')
  assert.equal(fromEmpty.unknown, 'grant-controls-absent')

  // But an unchanged empty grant set is not a grant change at all, and must still
  // fall through to the session-control comparison — the production event that made
  // the old fallback wrong had exactly this shape.
  const sessionOnly = classifyConditionalAccessChange(
    policy({ grantControls: [], grantOperator: null, sessionControls: ['signInFrequency'] }),
    policy({ grantControls: [], grantOperator: null, sessionControls: [] }))
  assert.equal(sessionOnly.unknown, 'session-controls')
})

test('a control that only changed case did not change', () => {
  // `effective-mfa-enforcement.ts` lowercases builtInControls before comparing and
  // this comparison now does the same, so the two halves of the product agree about
  // what counts as the same control. Without it, Microsoft altering the casing of a
  // value would read as one control removed and another added — on an AND policy,
  // an urgent page for a change that altered nothing.
  const recased = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
    policy({ grantOperator: 'AND', grantControls: ['MFA', 'CompliantDevice'] }))
  assert.equal(recased.classification, 'ROUTINE', recased.because)

  // POSITIVE CONTROL: a genuinely different control is still seen.
  assert.equal(
    classifyConditionalAccessChange(
      policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
      policy({ grantOperator: 'AND', grantControls: ['MFA'] })).classification,
    'URGENT')
})

test('THE RECORD KEEPS MICROSOFT\'S CASING for the control it names', () => {
  // Caught by the routine-wording test above, which failed with "compliantdevice".
  // Comparing case-insensitively is right; carrying the lowercased form into the
  // sentence is not. An MSP reading the record goes looking for that control in the
  // portal, and the portal calls it compliantDevice.
  const removal = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
    policy({ grantOperator: 'AND', grantControls: ['mfa'] }))
  assert.equal(removal.classification, 'URGENT')
  assert.match(removal.because, /compliantDevice/, 'the name must survive the comparison unchanged')

  // Both directions: an added control too, and the operator-relaxation wording that
  // lists the whole resulting set.
  const relaxed = classifyConditionalAccessChange(
    policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }))
  assert.match(relaxed.because, /compliantDevice/)

  const added = classifyConditionalAccessChange(
    policy({ grantOperator: 'OR', grantControls: ['mfa'] }),
    policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }))
  assert.match(added.because, /compliantDevice/)

  // And the degenerate no-op still reports nothing at all, so this is not satisfied
  // by a string that always contains every control name.
  assert.doesNotMatch(
    classifyConditionalAccessChange(policy(), policy()).because, /compliantDevice/)
})


/** THE RULE IDENTIFIERS — a wire contract, tested as one.
 *
 * These become the keys MSP preferences are stored against, so two properties
 * matter and neither is about classification: the strings are STABLE, and every one
 * of them is REACHABLE. A rule nobody can trigger is a switch in a settings screen
 * that does nothing, which is worse than a missing switch because it reads as
 * covered.
 */

const PERMISSION_GRANT = (applicationId: string, permissions: readonly string[], scope: 'TENANT_WIDE' | 'SINGLE_PRINCIPAL' = 'SINGLE_PRINCIPAL') =>
  ({ kind: 'APPLICATION_PERMISSION_GRANT', applicationId, permissions, scope }) as const

/** One input per declared rule. The table IS the reachability proof. */
const REACHES: ReadonlyArray<readonly [ChangeRule, () => { rule: ChangeRule }]> = [
  ['directory.hawkview_onboarding_grant',
    () => classifyDirectoryChange(PERMISSION_GRANT(OURS, ['User.Read.All'], 'TENANT_WIDE'), context)],
  ['directory.sensitive_permission_granted',
    () => classifyDirectoryChange(PERMISSION_GRANT(THEIRS, ['Application.ReadWrite.All']), context)],
  ['directory.permission_unrecognised',
    () => classifyDirectoryChange(PERMISSION_GRANT(THEIRS, ['Some.Permission.Invented.Yesterday']), context)],
  ['directory.read_scope_granted',
    () => classifyDirectoryChange(PERMISSION_GRANT(THEIRS, ['User.Read.All']), context)],
  ['directory.application_credential_added',
    () => classifyDirectoryChange({ kind: 'APPLICATION_CREDENTIAL_ADDED', applicationId: THEIRS }, context)],
  ['directory.privileged_role_assigned',
    () => classifyDirectoryChange({ kind: 'ROLE_ASSIGNMENT', roleTemplateId: 'role-1', roleIsPrivileged: true }, context)],
  ['directory.role_unidentified',
    () => classifyDirectoryChange({ kind: 'ROLE_ASSIGNMENT', roleTemplateId: null, roleIsPrivileged: null }, context)],
  ['directory.role_not_privileged',
    () => classifyDirectoryChange({ kind: 'ROLE_ASSIGNMENT', roleTemplateId: 'role-2', roleIsPrivileged: false }, context)],
  ['directory.auth_method_registered',
    () => classifyDirectoryChange({ kind: 'AUTH_METHOD_REGISTERED' }, context)],
  ['directory.admin_password_reset',
    () => classifyDirectoryChange({ kind: 'ADMIN_PASSWORD_RESET' }, context)],
  ['conditional_access.state_unavailable',
    () => classifyConditionalAccessChange(null, policy())],
  ['conditional_access.policy_disabled',
    () => classifyConditionalAccessChange(policy(), policy({ state: 'OFF' }))],
  ['conditional_access.policy_stopped_enforcing',
    () => classifyConditionalAccessChange(policy({ state: 'ON' }), policy({ state: 'REPORT_ONLY' }))],
  ['conditional_access.policy_stopped_reporting',
    () => classifyConditionalAccessChange(policy({ state: 'REPORT_ONLY' }), policy({ state: 'OFF' }))],
  ['conditional_access.policy_state_unrecognised',
    () => classifyConditionalAccessChange(policy({ state: 'ON' }), policy({ state: 'UNRECOGNISED' }))],
  // Ordered role, group, user in the classifier, so each of these adds only its own
  // kind — otherwise the earlier rule fires and the later entry is untested.
  ['conditional_access.role_excluded',
    () => classifyConditionalAccessChange(policy(), policy({ excludedRoles: ['role-1'] }))],
  ['conditional_access.group_excluded',
    () => classifyConditionalAccessChange(policy(), policy({ excludedGroups: ['group-1'] }))],
  ['conditional_access.user_excluded',
    () => classifyConditionalAccessChange(policy(), policy({ excludedUsers: ['user-1'] }))],
  ['conditional_access.grant_weakened',
    () => classifyConditionalAccessChange(
      policy({ grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'] }))],
  ['conditional_access.grant_operator_unknown',
    () => classifyConditionalAccessChange(
      policy({ grantOperator: null }), policy({ grantOperator: null, grantControls: ['mfa'] }))],
  ['conditional_access.grant_controls_absent',
    () => classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: [] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] }))],
  ['conditional_access.grant_denial_control',
    () => classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'block'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] }))],
  ['conditional_access.session_control_changed',
    () => classifyConditionalAccessChange(
      policy({ sessionControls: ['signInFrequency'] }), policy({ sessionControls: [] }))],
  ['conditional_access.unmodelled_dimension',
    () => classifyConditionalAccessChange(
      policy({ unmodelledFingerprint: 'a' }), policy({ unmodelledFingerprint: 'b' }))],
  ['conditional_access.no_modelled_weakening',
    () => classifyConditionalAccessChange(policy(), policy())],
]

test('EVERY DECLARED RULE IS REACHABLE, and nothing reaches a rule twice', () => {
  // A rule nobody can trigger is a settings switch that does nothing — and it reads
  // as coverage, which is the part that misleads.
  for (const [expected, produce] of REACHES) {
    assert.equal(produce().rule, expected, expected)
  }

  // The table covers the declared list exactly. A new branch with a new rule fails
  // here until it has an input that reaches it; a rule deleted from the list fails
  // here too. Both directions, because either gap is silent.
  assert.deepEqual([...REACHES.map(([rule]) => rule)].sort(), [...CHANGE_RULES].sort())

  // And no two entries claim the same rule, which would hide an unreachable one
  // behind a duplicate.
  assert.equal(new Set(REACHES.map(([rule]) => rule)).size, REACHES.length)
})

test('THE RULE IDENTIFIERS ARE A WIRE CONTRACT, pinned so a rename cannot be casual', () => {
  // Once an MSP preference row points at one of these, renaming it is a schema
  // migration and a conversation about somebody's saved settings. This test exists
  // so that "it would read better as X" fails loudly and the next reader is told
  // why, rather than being a one-line diff nobody questions.
  //
  // ADDING a rule is fine and only needs a line here. RENAMING one is not.
  assert.deepEqual([...CHANGE_RULES], [
    'directory.hawkview_onboarding_grant',
    'directory.sensitive_permission_granted',
    'directory.permission_unrecognised',
    'directory.read_scope_granted',
    'directory.application_credential_added',
    'directory.privileged_role_assigned',
    'directory.role_unidentified',
    'directory.role_not_privileged',
    'directory.auth_method_registered',
    'directory.admin_password_reset',
    'conditional_access.state_unavailable',
    'conditional_access.policy_disabled',
    'conditional_access.policy_stopped_enforcing',
    'conditional_access.policy_stopped_reporting',
    'conditional_access.policy_state_unrecognised',
    'conditional_access.user_excluded',
    'conditional_access.group_excluded',
    'conditional_access.role_excluded',
    'conditional_access.grant_weakened',
    'conditional_access.grant_operator_unknown',
    'conditional_access.grant_controls_absent',
    'conditional_access.grant_denial_control',
    'conditional_access.session_control_changed',
    'conditional_access.unmodelled_dimension',
    'conditional_access.no_modelled_weakening',
  ])

  // No duplicates in the contract itself, and every id is namespaced — the prefix is
  // what lets a settings screen group them without parsing prose.
  assert.equal(new Set(CHANGE_RULES).size, CHANGE_RULES.length)
  for (const rule of CHANGE_RULES) {
    assert.match(rule, /^(directory|conditional_access)\.[a-z0-9_]+$/, rule)
  }
})

test('THE THREE UNDETERMINED GRANT REASONS STAY SEPARATE RULES', () => {
  // They all produce UNCLASSIFIED, so a classification-level identifier would
  // collapse them into one switch. An MSP who wants to hear about a denial control
  // moving but not about an unknown operator needs them distinguishable, and the
  // distinction already exists in the `unknown` token — the rule must not be
  // coarser than what the function already knows.
  const rules = [
    classifyConditionalAccessChange(
      policy({ grantOperator: null }), policy({ grantOperator: null, grantControls: ['mfa'] })).rule,
    classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: [] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] })).rule,
    classifyConditionalAccessChange(
      policy({ grantOperator: 'OR', grantControls: ['mfa', 'block'] }),
      policy({ grantOperator: 'OR', grantControls: ['mfa'] })).rule,
  ]
  assert.equal(new Set(rules).size, 3, 'three distinct causes must be three distinct rules')
})

test('the rule is independent of the classification, which is the point of having both', () => {
  // Routing maps an opinion onto a channel. If the rule could be derived from the
  // classification there would be nothing to configure at a finer grain than the
  // tier, which is the coarseness this identifier exists to remove.
  const byClassification = new Map<string, Set<ChangeRule>>()
  for (const [, produce] of REACHES) {
    const verdict = produce() as { rule: ChangeRule; classification: string }
    const existing = byClassification.get(verdict.classification) ?? new Set<ChangeRule>()
    existing.add(verdict.rule)
    byClassification.set(verdict.classification, existing)
  }
  for (const [classification, rules] of byClassification) {
    assert.ok(rules.size > 1,
      `${classification} maps to only ${rules.size} rule — an MSP could not configure below the tier`)
  }
})


test('THE THREE POLICY-STATE TRANSITIONS SAY DIFFERENT THINGS, because they are different', () => {
  // The boolean this replaces produced a WRONG sentence, not just a lossy one.
  // Enabled-to-report-only read as "the policy was disabled" — it was not; it still
  // evaluates and still logs, it just stops enforcing.
  const toReportOnly = classifyConditionalAccessChange(policy({ state: 'ON' }), policy({ state: 'REPORT_ONLY' }))
  assert.equal(toReportOnly.classification, 'URGENT')
  assert.match(toReportOnly.because, /report-only/i)
  assert.match(toReportOnly.because, /still (evaluates|logs)/i, 'it must not claim the policy was disabled')
  assert.doesNotMatch(toReportOnly.because, /was disabled/i)

  // Enabled to disabled is the other one, and it may say the stronger thing.
  const toOff = classifyConditionalAccessChange(policy({ state: 'ON' }), policy({ state: 'OFF' }))
  assert.equal(toOff.classification, 'URGENT')
  assert.match(toOff.because, /disabled/i)
  assert.notEqual(toOff.rule, toReportOnly.rule, 'two different events need two different rules')

  // Report-only to disabled read as false-to-false before: no change at all. It now has
  // a verdict, and the verdict is ROUTINE for a stated reason rather than by falling off
  // the end — no session's access changes, because report-only was not enforcing either.
  // What is lost is our own visibility.
  const reportingOff = classifyConditionalAccessChange(policy({ state: 'REPORT_ONLY' }), policy({ state: 'OFF' }))
  assert.equal(reportingOff.classification, 'ROUTINE')
  assert.match(reportingOff.because, /log/i, 'the record must say what was actually lost')
  assert.doesNotMatch(reportingOff.because, /weaken/i, 'nobody\'s access changed, so it must not claim one did')

  // STRENGTHENING DIRECTIONS ARE NOT REPORTED AS CHANGES OF STATE. Turning a policy on
  // must not look like turning one off.
  for (const [before, after] of [['OFF', 'ON'], ['OFF', 'REPORT_ONLY'], ['REPORT_ONLY', 'ON']] as const) {
    const verdict = classifyConditionalAccessChange(policy({ state: before }), policy({ state: after }))
    assert.equal(verdict.classification, 'ROUTINE', `${before} -> ${after}`)
    assert.notEqual(verdict.rule, 'conditional_access.policy_disabled', `${before} -> ${after}`)
  }
})

test('AN UNRECOGNISED POLICY STATE IS NEVER TREATED AS ONE OF THE THREE', () => {
  // This field is modelled losslessly and therefore excluded from the fingerprint, so a
  // state Microsoft has not sent before would have no backstop if it were guessed.
  for (const known of ['ON', 'REPORT_ONLY', 'OFF'] as const) {
    const intoUnknown = classifyConditionalAccessChange(policy({ state: known }), policy({ state: 'UNRECOGNISED' }))
    assert.equal(intoUnknown.classification, 'UNCLASSIFIED', `${known} -> UNRECOGNISED`)
    assert.equal(intoUnknown.rule, 'conditional_access.policy_state_unrecognised')
    assert.match(intoUnknown.because, /impact unknown/i)

    const outOfUnknown = classifyConditionalAccessChange(policy({ state: 'UNRECOGNISED' }), policy({ state: known }))
    assert.equal(outOfUnknown.classification, 'UNCLASSIFIED', `UNRECOGNISED -> ${known}`)
  }

  // POSITIVE CONTROL: unrecognised on BOTH sides is not a state change, so it must fall
  // through to the other comparisons rather than reporting every time it is seen.
  const unchanged = classifyConditionalAccessChange(
    policy({ state: 'UNRECOGNISED' }), policy({ state: 'UNRECOGNISED' }))
  assert.equal(unchanged.classification, 'ROUTINE')
})

test('AN EXCLUSION NAMES THE KIND, because the kinds are different sizes of event', () => {
  // Merging them lost the blast radius rather than a label, and this is the tier that
  // rings a phone.
  const role = classifyConditionalAccessChange(policy(), policy({ excludedRoles: ['role-1'] }))
  const group = classifyConditionalAccessChange(policy(), policy({ excludedGroups: ['group-1'] }))
  const user = classifyConditionalAccessChange(policy(), policy({ excludedUsers: ['user-1'] }))

  for (const verdict of [role, group, user]) assert.equal(verdict.classification, 'URGENT')
  assert.equal(new Set([role.rule, group.rule, user.rule]).size, 3,
    'three kinds, three rules, so an MSP can hear about groups and not individuals')

  // The sentence has to carry the scope, which is the reason for the split.
  assert.match(role.because, /role/i)
  assert.match(role.because, /changes as role assignments change|holding that role/i,
    'a role exclusion covers a set that moves without the policy being edited')
  assert.match(group.because, /group/i)
  assert.match(group.because, /not visible from the policy/i,
    'the member count is the part an MSP cannot see')
  assert.doesNotMatch(user.because, /group|role/i, 'an account exclusion must not overstate its scope')
})

test('A WEAKENING OUTRANKS EVERY UNKNOWN FIRING ALONGSIDE IT', () => {
  // The precedence question worth checking rather than assuming: now that the
  // fingerprint has a real producer, a genuine weakening happens in the same comparison
  // as an unmodelled change far more often — a policy edit moves several things at once.
  // If the fingerprint were checked first, a weakening would be relabelled "impact
  // unknown" and dropped off the tier that pages. The verdict would still look
  // defensible, which is what makes it the dangerous ordering.
  const weakenedAndMore = classifyConditionalAccessChange(
    policy({
      grantOperator: 'AND', grantControls: ['mfa', 'compliantDevice'],
      sessionControls: [], unmodelledFingerprint: 'before',
    }),
    policy({
      grantOperator: 'OR', grantControls: ['mfa', 'compliantDevice'],
      sessionControls: ['signInFrequency'], unmodelledFingerprint: 'after',
    }))
  assert.equal(weakenedAndMore.classification, 'URGENT',
    'a grant weakening must not be downgraded by an unknown firing beside it')
  assert.equal(weakenedAndMore.rule, 'conditional_access.grant_weakened')

  // Each of the three weakening kinds, against every unknown at once.
  const noisy = { sessionControls: ['signInFrequency'], unmodelledFingerprint: 'after' } as const
  for (const [label, after] of [
    ['disabled', { state: 'OFF', ...noisy }],
    ['role excluded', { excludedRoles: ['role-1'], ...noisy }],
    ['stopped enforcing', { state: 'REPORT_ONLY', ...noisy }],
  ] as const) {
    const verdict = classifyConditionalAccessChange(
      policy({ unmodelledFingerprint: 'before' }), policy(after))
    assert.equal(verdict.classification, 'URGENT', label)
  }

  // POSITIVE CONTROL: with no weakening present, those same unknowns DO decide the
  // verdict — so the ordering is a precedence rather than the unknowns being inert.
  const unknownsOnly = classifyConditionalAccessChange(
    policy({ unmodelledFingerprint: 'before' }), policy({ ...noisy }))
  assert.equal(unknownsOnly.classification, 'UNCLASSIFIED')
  assert.equal(unknownsOnly.rule, 'conditional_access.session_control_changed')
})
