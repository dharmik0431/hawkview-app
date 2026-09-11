import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPECTED_ONBOARDING_PERMISSIONS,
  classifyConditionalAccessChange,
  classifyDirectoryChange,
  type ClassificationContext,
  type ConditionalAccessState,
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
  enabled: true,
  grantOperator: 'AND',
  grantControls: ['mfa', 'compliantDevice'],
  excludedPrincipals: [],
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
    classifyConditionalAccessChange(policy(), policy({ enabled: false })).classification,
    'URGENT')
  assert.equal(
    classifyConditionalAccessChange(policy(), policy({ excludedPrincipals: ['user-1'] })).classification,
    'URGENT')

  // POSITIVE CONTROL: removing an exclusion is not weakening.
  assert.equal(
    classifyConditionalAccessChange(policy({ excludedPrincipals: ['user-1'] }), policy()).classification,
    'ROUTINE')
})
