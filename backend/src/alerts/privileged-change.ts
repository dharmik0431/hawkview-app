import { MICROSOFT_APPLICATION_PERMISSIONS } from '../microsoft/microsoft-access-contract.js'
import type { Severity } from './alert-type.js'

/** Which directory changes are privileged, decided from evidence HawkView holds.
 *
 * THREE OUTCOMES, NOT TWO. `UNCLASSIFIED` exists because a permission missing from
 * the sensitive list is not thereby read-only, and an unresolvable role is not
 * thereby harmless. Falling through to ROUTINE would be absence of evidence read as
 * evidence of absence — the thing this product refuses everywhere else, where a
 * count that cannot be determined is NOT_AVAILABLE rather than zero.
 */

export type ChangeClassification = 'URGENT' | 'ROUTINE' | 'UNCLASSIFIED'

export interface ClassifiedChange {
  readonly classification: ChangeClassification
  /** Why, in a sentence a person reads before acting. */
  readonly because: string
  /** Derived from the classification rather than chosen beside it. */
  readonly severity: Severity
  /** The token nobody could classify — a permission string, a role id, a policy
   * field. Carried so the unclassified set can be surfaced and SHRUNK rather than
   * quietly accumulating. */
  readonly unknown?: string
}

/** Permissions whose grant is an escalation path in its own right.
 *
 * THE TWO AT THE TOP ARE DIFFERENT PATHS AND WERE PREVIOUSLY DESCRIBED WRONG. The
 * policy document said `Application.ReadWrite.All` lets an application grant itself
 * every other permission. It does not, and it was the example the whole argument
 * rested on. Both are genuinely sensitive; they are simply not the same mechanism,
 * and whoever reads this next will believe what it says. */
const SENSITIVE_PERMISSIONS: ReadonlyMap<string, string> = new Map([
  [
    'Application.ReadWrite.All',
    'Confers CREDENTIAL MANAGEMENT over application registrations: the holder can add a credential to ' +
    'another registration and then authenticate as that application, assuming whatever privileges it ' +
    'already holds. The escalation is indirect and survives a password reset on any user.',
  ],
  [
    'AppRoleAssignment.ReadWrite.All',
    'This is the one that manages permission GRANTS: the holder can assign application role ' +
    'assignments, which is the direct path to giving an application permissions it was not consented.',
  ],
  [
    'RoleManagement.ReadWrite.Directory',
    'Assigns directory roles, including administrative ones, without going through a role-assignment UI.',
  ],
  [
    'Directory.ReadWrite.All',
    'Writes across the directory — users, groups and memberships — which includes paths into privilege.',
  ],
  [
    'User.ReadWrite.All',
    'Writes user objects, which includes the attributes some authentication and policy decisions read.',
  ],
  [
    'Policy.ReadWrite.ConditionalAccess',
    'Edits the policies that enforce multi-factor and device requirements — the controls everything else assumes.',
  ],
  [
    'Mail.ReadWrite',
    'Reads and writes mailbox contents tenant-wide, so the holder can both take mail out and put mail in.',
  ],
  [
    'Mail.Read',
    'Reads mailbox contents tenant-wide. Read-only and still the highest-value data in the tenant.',
  ],
  [
    'Files.ReadWrite.All',
    'Reads and writes all files in SharePoint and OneDrive.',
  ],
])

/** Permissions known to be routine. Deliberately an ALLOW-LIST rather than "not
 * sensitive", because the whole point of UNCLASSIFIED is that we do not know what
 * an unfamiliar permission does. Read scopes HawkView itself requests are the
 * obvious members; anything else has to be added deliberately. */
const KNOWN_ROUTINE_PERMISSIONS: ReadonlySet<string> = new Set(
  MICROSOFT_APPLICATION_PERMISSIONS
    .map((permission) => permission.name)
    .filter((name) => name !== 'Exchange.ManageAsAppV2'),
)

/** What HawkView asks for at onboarding, derived from the access contract rather
 * than copied — so it cannot drift from what we actually request. */
export const EXPECTED_ONBOARDING_PERMISSIONS: ReadonlySet<string> = new Set(
  MICROSOFT_APPLICATION_PERMISSIONS.map((permission) => permission.name),
)

export type ConsentScope = 'TENANT_WIDE' | 'SINGLE_PRINCIPAL' | 'UNKNOWN'

export type DirectoryChange =
  | Readonly<{
      kind: 'APPLICATION_PERMISSION_GRANT'
      applicationId: string
      permissions: readonly string[]
      scope: ConsentScope
    }>
  | Readonly<{ kind: 'APPLICATION_CREDENTIAL_ADDED'; applicationId: string }>
  | Readonly<{ kind: 'ROLE_ASSIGNMENT'; roleTemplateId: string | null; roleIsPrivileged: boolean | null }>
  | Readonly<{ kind: 'CONDITIONAL_ACCESS_CHANGE'; before: ConditionalAccessState | null; after: ConditionalAccessState | null }>
  | Readonly<{ kind: 'AUTH_METHOD_REGISTERED' }>
  | Readonly<{ kind: 'ADMIN_PASSWORD_RESET' }>

/** Enough of a conditional access policy to compare two of them. */
export interface ConditionalAccessState {
  readonly enabled: boolean
  /** How the grant controls combine. Microsoft's model: OR means any one control
   * satisfies the policy, AND means all of them must. */
  readonly grantOperator: 'OR' | 'AND' | null
  readonly grantControls: readonly string[]
  readonly excludedPrincipals: readonly string[]
  /** Session controls PRESENT, by name. Modelled far enough to notice they moved
   * and deliberately no further: their direction depends on values this does not
   * capture — `persistentBrowser: always` weakens a policy and `never` strengthens
   * it, and `signInFrequency` depends entirely on the interval. Guessing a
   * direction from presence alone would be the same error as "removing a grant
   * control weakens the policy", one dimension across. So a session-control change
   * is reported as a change whose impact is unknown, which is what we can honestly
   * say. */
  readonly sessionControls: readonly string[]
  /** A digest of everything this comparison does NOT model — the policy as
   * collected, minus the fields above.
   *
   * Of everything unmodelled, deliberately, and not of the whole policy. A digest
   * covering the modelled fields too would differ whenever anything changed at
   * all, so it could not distinguish "a dimension we understand moved" from "a
   * dimension we do not". It would have made the OR-removal case unreachable,
   * which is how I first wrote it.
   *
   * It exists so "we did not look at that" can never resolve to "it was fine".
   * Without it the only safe comparison would enumerate every field Microsoft has
   * or later adds, and would silently widen its claim each time one appeared.
   *
   * The coupling is real and worth stating: whoever computes this must exclude
   * exactly the fields above, and must change it when that set changes. */
  readonly unmodelledFingerprint: string
}

export interface ClassificationContext {
  /** HawkView's own application id, from the platform connector row. Runtime
   * configuration rather than a constant, so it is passed in. */
  readonly hawkviewApplicationId: string | null
}

const URGENT_SEVERITY: Severity = 'ACT_NOW'
const REVIEW_SEVERITY: Severity = 'ACT_TODAY'
const ROUTINE_SEVERITY: Severity = 'RECORD_ONLY'

const urgent = (because: string): ClassifiedChange =>
  ({ classification: 'URGENT', because, severity: URGENT_SEVERITY })
const routine = (because: string): ClassifiedChange =>
  ({ classification: 'ROUTINE', because, severity: ROUTINE_SEVERITY })
const unclassified = (because: string, unknown: string, severity: Severity = REVIEW_SEVERITY): ClassifiedChange =>
  ({ classification: 'UNCLASSIFIED', because, severity, unknown })

/** HawkView's own grants are exempt ONLY within the set we actually request.
 *
 * NOT BY APPLICATION ID ALONE, which would make HawkView itself the one blind spot
 * in the tenant: an unexpected permission increase to our own registration would be
 * the most alarming event there is, and we would say nothing about it. We know our
 * own permission list exactly, so this is a precise allow-list and not a heuristic —
 * and it is strictly narrower than exempting the application. */
function isExpectedOnboardingGrant(
  change: Extract<DirectoryChange, { kind: 'APPLICATION_PERMISSION_GRANT' }>,
  context: ClassificationContext,
): boolean {
  if (context.hawkviewApplicationId === null) return false
  if (change.applicationId !== context.hawkviewApplicationId) return false
  return change.permissions.every((permission) => EXPECTED_ONBOARDING_PERMISSIONS.has(permission))
}

export function classifyDirectoryChange(
  change: DirectoryChange,
  context: ClassificationContext,
): ClassifiedChange {
  switch (change.kind) {
    case 'APPLICATION_PERMISSION_GRANT': {
      if (isExpectedOnboardingGrant(change, context)) {
        return routine('HawkView onboarding: every permission in this grant is one HawkView requests.')
      }

      // SENSITIVITY AND SCOPE TOGETHER, never scope alone.
      //
      // An earlier rule said a tenant-wide consent type raised ANY permission to
      // urgent, and a correction two rows below it said tenant-wide consent is not
      // urgent by itself. Both were in the same table. The second is right, and it
      // is measured: tenant-wide admin consent fires 47 times in production,
      // because consenting on behalf of all users is simply how an administrator
      // approves an application. Scope MULTIPLIES a sensitive permission; it never
      // promotes a routine one.
      const sensitive = change.permissions.filter((permission) => SENSITIVE_PERMISSIONS.has(permission))
      if (sensitive.length > 0) {
        const reasons = sensitive.map((permission) => `${permission}: ${SENSITIVE_PERMISSIONS.get(permission)}`)
        const amplifier = change.scope === 'TENANT_WIDE'
          ? ' Granted tenant-wide, so it applies to every user at once.'
          : ''
        return urgent(`A sensitive permission was granted. ${reasons.join(' ')}${amplifier}`)
      }

      // Not sensitive — but "not on the list" is not "read-only".
      const unrecognised = change.permissions.filter((permission) => !KNOWN_ROUTINE_PERMISSIONS.has(permission))
      if (unrecognised.length > 0) {
        return unclassified(
          'A permission was granted that is on neither the sensitive nor the known-routine list. ' +
          'Unrecognised is not the same as established-harmless, so it is recorded as unclassified rather ' +
          'than downgraded. Nobody has decided what this permission is; that is the finding.',
          unrecognised.join(', '))
      }

      return routine('Every permission in this grant is a known read scope.')
    }

    case 'APPLICATION_CREDENTIAL_ADDED':
      // Including to HawkView's own registration. The onboarding exemption covers
      // permissions we request; a credential is not a permission, so it is never in
      // that set and is evaluated like anyone else's.
      return urgent(
        'A credential was added to an application registration. Whoever holds it can authenticate as ' +
        'that application and assume the privileges it already has, and the credential survives any ' +
        'user password reset.')

    case 'ROLE_ASSIGNMENT': {
      if (change.roleTemplateId === null || change.roleIsPrivileged === null) {
        // THE ONE UNCLASSIFIED CASE THAT IS URGENT. The activity has already told us
        // this is a privilege grant; only the magnitude is unknown. "Somebody was
        // granted a role we cannot identify" is materially different from "an
        // application got a permission we do not recognise".
        return unclassified(
          'A directory role was assigned and the role could not be identified. The activity is a privilege ' +
          'grant regardless — only its magnitude is unknown, which is not a reason to wait.',
          change.roleTemplateId ?? 'unresolved-role',
          URGENT_SEVERITY)
      }
      return change.roleIsPrivileged
        ? urgent('A role granting administrative access was assigned.')
        : routine('A directory role with no administrative privilege was assigned.')
    }

    case 'CONDITIONAL_ACCESS_CHANGE':
      return classifyConditionalAccessChange(change.before, change.after)

    case 'AUTH_METHOD_REGISTERED':
      // ROUTINE BY DEFAULT, AND NOT ASSERTED BENIGN. Registering an authentication
      // method is usually a person improving their own security. It is ALSO how
      // somebody holding stolen credentials registers their own authenticator, which
      // is a standard persistence move — so this is classified routine because it is
      // ordinarily unremarkable, not because it has been shown to be safe. It
      // escalates on the ordinary signals like anything else.
      //
      // Deliberately says nothing about what any other detector covers.
      return routine(
        'An authentication method was registered. Ordinarily unremarkable; it is also how an attacker ' +
        'holding stolen credentials establishes persistence, so it is recorded rather than dismissed.')

    case 'ADMIN_PASSWORD_RESET':
      // Same treatment and the same reason. An earlier version asserted this case
      // was "caught by the credential-attack detector, not here" — a claim about
      // another component's coverage that was never checked. No such claim is made
      // anywhere in this file.
      return routine(
        'An administrator reset a password. Ordinarily an administrator doing their job, and also the ' +
        'step that follows a successful account takeover, so it is recorded rather than dismissed.')
  }
}

/** Whether a conditional access change weakened the policy.
 *
 * REMOVING A GRANT CONTROL DOES NOT ALWAYS WEAKEN IT, which is the correction that
 * makes this function necessary rather than a one-line test. Microsoft's grant
 * controls combine with OR or AND:
 *
 *   OR   any one control satisfies the policy. REMOVING one removes an ALTERNATIVE,
 *        so the policy becomes harder to satisfy, not easier.
 *   AND  every control must be satisfied. Removing one removes a REQUIREMENT, which
 *        weakens it.
 *
 * Reference: Microsoft's conditional access grant-control documentation.
 *
 * Where the evidence is missing or unparseable this reports "change detected;
 * impact unknown" rather than passing silently — the same rule as an unrecognised
 * permission, and for the same reason. */
/** Which way a grant-control change moved the policy.
 *
 * THE SEMANTICS, and every rule below follows from them:
 *
 *   AND(S)  a session must satisfy EVERY control in S
 *   OR(S)   a session must satisfy AT LEAST ONE control in S
 *
 * A policy is WEAKER when more sessions pass it. So relaxing AND to OR weakens it,
 * adding an alternative to an OR set weakens it, and removing a requirement from an
 * AND set weakens it. The other three transitions tighten it.
 *
 * THE DEFECT THIS REPLACES READ ONLY ONE OF THOSE. `before.grantOperator` was read
 * twice, `after.grantOperator` never, and `removed` was the only thing computed
 * from the control sets — so a policy going from "MFA AND a compliant device" to
 * "MFA OR a compliant device" was filed as a record. That is close to the clearest
 * relaxation available short of disabling the policy.
 *
 * WHY NOTHING CAUGHT IT, which is the part that generalises. `grantOperator` is a
 * MODELLED field, so a correct producer excludes it from `unmodelledFingerprint` by
 * construction — the unmodelled guard is designed not to fire here, and the better
 * the producer, the more certainly a gap inside the modelled set slips through. A
 * safety net covering everything except what you decided to handle yourself leaves
 * the handled part uniquely undefended. The net cannot be widened to cover it
 * without destroying what makes it useful, so the only defence is that every
 * modelled dimension is actually compared — which is what this function is for.
 */
type GrantVerdict =
  | Readonly<{ kind: 'WEAKER'; reasons: readonly string[] }>
  | Readonly<{ kind: 'UNDETERMINED'; because: string; unknown: string }>
  | Readonly<{ kind: 'NOT_WEAKER'; compared: string }>

/** Controls that DENY access rather than offering a way to satisfy the policy.
 *
 * `block` is a grant control in Microsoft's model and HawkView already renders it
 * as "Block access" (`tenant-sync.service.ts`), so it can arrive in the same array
 * as `mfa`. Every rule above reads BACKWARDS for it: a denial is not an
 * alternative way to pass, so removing it from an OR set weakens the policy where
 * removing any other control strengthens it.
 *
 * How Microsoft combines a denial with a grant is not something this comparison has
 * evidence for, so it does not guess a direction — a change involving one is
 * reported as undetermined. Same discipline as session controls, and the same
 * reason: the honest answer is that we did not look, not a direction inferred from
 * presence. This is not in the report or in QA's matrix; it is the silent direction
 * of the same gap, found by sweeping for the shape rather than fixing the instance. */
const DENIAL_CONTROLS: ReadonlySet<string> = new Set(['block'])

/** The controls on one side, for case-insensitive membership tests.
 *
 * Matching `effective-mfa-enforcement`, which lowercases `builtInControls` before
 * comparing, so both halves of the product agree about what counts as the same
 * control. No producer for `ConditionalAccessState` exists yet; without this, a
 * casing change from Microsoft would read as one control removed and another added
 * — on an AND policy, an urgent page for a change that altered nothing.
 *
 * A SET RATHER THAN AN ARRAY, and lowercasing happens here and at the probe below,
 * because the failure mode is normalising ONE SIDE. Lowercase only the haystack and
 * every camelCase control reads as removed from a policy that did not change; that
 * is not a hypothetical — it is what a mutation of this line produced, and it turned
 * six unrelated tests red for a reason none of them named. */
const lowercased = (controls: readonly string[]): ReadonlySet<string> =>
  new Set(controls.map((control) => control.toLowerCase()))

/** Null when the grant dimension did not move, so the caller can say that rather
 * than describe a comparison it never needed to make. */
function grantChangeVerdict(
  before: ConditionalAccessState,
  after: ConditionalAccessState,
): GrantVerdict | null {
  // Compared case-insensitively, REPORTED as Microsoft sent them. Lowercasing the
  // comparison stops a recased value reading as a change; lowercasing the report
  // would hand an MSP a control name that does not appear in their own portal.
  const beforeSet = lowercased(before.grantControls)
  const afterSet = lowercased(after.grantControls)
  const removed = before.grantControls.filter((control) => !afterSet.has(control.toLowerCase()))
  const added = after.grantControls.filter((control) => !beforeSet.has(control.toLowerCase()))
  const operatorChanged = before.grantOperator !== after.grantOperator

  if (!operatorChanged && removed.length === 0 && added.length === 0) return null

  if (before.grantOperator === null || after.grantOperator === null) {
    return {
      kind: 'UNDETERMINED',
      because:
        'Grant controls changed and the operator combining them is unknown on one side, so whether a ' +
        'requirement or an alternative moved cannot be determined. Change detected; impact unknown.',
      unknown: 'grant-operator-unknown',
    }
  }

  if (before.grantControls.length === 0 || after.grantControls.length === 0) {
    // AND over no controls requires nothing; OR over no controls admits nothing. The
    // operators invert at the empty set, so every rule below would read the wrong
    // way. Microsoft does not permit a policy with neither grant nor session
    // controls, which makes this a state to report rather than interpret.
    return {
      kind: 'UNDETERMINED',
      because:
        'Grant controls changed and one side has none at all, where the AND and OR operators mean ' +
        'opposite things. Change detected; impact unknown.',
      unknown: 'grant-controls-absent',
    }
  }

  const denials = [...removed, ...added].filter((control) => DENIAL_CONTROLS.has(control.toLowerCase()))
  if (denials.length > 0) {
    return {
      kind: 'UNDETERMINED',
      because:
        `A control that denies access rather than granting it moved (${denials.join(', ')}). It is not an ` +
        'alternative way to satisfy the policy, so the operator semantics do not describe its direction. ' +
        'Change detected; impact unknown.',
      unknown: 'grant-denial-control',
    }
  }

  const controlsUnchanged = removed.length === 0 && added.length === 0
  // ON A SINGLE CONTROL THE OPERATORS ARE EQUIVALENT. "All of [mfa]" and "any of
  // [mfa]" are the same requirement, so the flip changes nothing and must not be
  // reported as a weakening. This is the cell a fix reading "AND to OR is urgent"
  // gets wrong, and it passed before only because no operator comparison happened.
  const operatorFlipIsVacuous = controlsUnchanged && after.grantControls.length === 1

  const reasons: string[] = []
  if (before.grantOperator === 'AND' && after.grantOperator === 'OR' && !operatorFlipIsVacuous) {
    reasons.push(
      `Grant controls that were all required are now alternatives (${after.grantControls.join(', ')}), so any ` +
      'one of them alone satisfies the policy where previously every one was needed.')
  }
  if (removed.length > 0 && before.grantOperator === 'AND') {
    reasons.push(
      `A required grant control was removed (${removed.join(', ')}) from a policy whose controls are ` +
      'combined with AND, so a requirement is gone.')
  }
  if (added.length > 0 && after.grantOperator === 'OR') {
    reasons.push(
      `A grant control was added (${added.join(', ')}) to a policy whose controls are combined with OR, ` +
      'so it is one more way to satisfy the policy without the others.')
  }
  if (reasons.length > 0) return { kind: 'WEAKER', reasons }

  if (operatorFlipIsVacuous) {
    return {
      kind: 'NOT_WEAKER',
      compared:
        `The grant operator changed from AND to OR over a single control (${after.grantControls.join(', ')}), ` +
        'where the two are the same requirement: all of one control is any of one control.',
    }
  }
  if (removed.length > 0 && before.grantOperator === 'OR') {
    return {
      kind: 'NOT_WEAKER',
      compared:
        `A grant control was removed (${removed.join(', ')}) from a policy whose controls are combined ` +
        'with OR. That removes an ALTERNATIVE way to satisfy the policy rather than a requirement, so it ' +
        'does not weaken it.',
    }
  }
  const moved = [
    ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
    ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
    ...(operatorChanged ? [`operator ${before.grantOperator} to ${after.grantOperator}`] : []),
  ]
  return {
    kind: 'NOT_WEAKER',
    compared:
      'The grant controls and the operator combining them were compared in both directions ' +
      `(${moved.join('; ')}) and no change makes the policy easier to satisfy.`,
  }
}

export function classifyConditionalAccessChange(
  before: ConditionalAccessState | null,
  after: ConditionalAccessState | null,
): ClassifiedChange {
  if (before === null || after === null) {
    return unclassified(
      'A conditional access policy changed and usable before/after values were not available. ' +
      'Change detected; impact unknown.',
      'conditional-access-state-missing')
  }

  if (before.enabled && !after.enabled) {
    return urgent('A conditional access policy was disabled. Its protection stops applying immediately.')
  }

  const addedExclusions = after.excludedPrincipals.filter(
    (principal) => !before.excludedPrincipals.includes(principal))
  if (addedExclusions.length > 0) {
    return urgent(
      `A principal was excluded from a conditional access policy (${addedExclusions.length}), ` +
      'so the policy no longer applies to them.')
  }

  const grant = grantChangeVerdict(before, after)
  if (grant !== null && grant.kind === 'WEAKER') {
    // EVERY reason that fired, not the first. A compound change weakened the policy
    // more than once and saying so is the accurate report -- but the reason this is
    // a list rather than an early return is narrower: AND [mfa, cd] -> OR [mfa] is
    // urgent under TWO rules, and an implementation returning whichever it reached
    // first would keep the verdict green while the reason underneath it moved. That
    // is the changed-subject shape, and a list cannot have it.
    return urgent(grant.reasons.join(' '))
  }
  if (grant !== null && grant.kind === 'UNDETERMINED') {
    return unclassified(grant.because, grant.unknown)
  }

  // NOTHING MODELLED WEAKENED. That is not the same as nothing weakened, and this
  // is where the previous version got it wrong: it returned routine here, which
  // caught every change to a dimension the comparison does not model and called
  // them all fine. Unlisted is not harmless and unmodelled is not harmless either —
  // correction 3 surviving one function deeper, written by the same hand that
  // implemented correction 3.
  //
  // Routine now REQUIRES positive evidence that the dimensions which moved are ones
  // this comparison understands. Absence of a modelled change is not that.
  const sessionControlsChanged =
    before.sessionControls.length !== after.sessionControls.length ||
    before.sessionControls.some((control) => !after.sessionControls.includes(control)) ||
    after.sessionControls.some((control) => !before.sessionControls.includes(control))

  if (sessionControlsChanged) {
    return unclassified(
      'A session control changed. Sign-in frequency and persistent browser sessions are where a session ' +
      'is extended from an hour to weeks, and their direction depends on values this comparison does not ' +
      'capture. Change detected; impact unknown.',
      'session-controls')
  }

  if (before.unmodelledFingerprint !== after.unmodelledFingerprint) {
    return unclassified(
      'The policy changed in a dimension this comparison does not model. Change detected; impact unknown.',
      'unmodelled-dimension')
  }

  // SAY WHAT WAS COMPARED, not that nothing weakened it.
  //
  // The previous sentence here was "none of them weakened it", which is a positive
  // safety claim over every dimension at once — including the grant operator, which
  // the function did not compare at all. Three weakenings were filed as records
  // underneath that sentence. A reader cannot audit a claim that does not say what
  // it rests on, so this one names the comparison and stops there.
  return routine(
    `${grant === null
      ? 'The grant controls and their combination operator are unchanged.'
      : grant.compared} Session controls are unchanged, and the digest of every dimension this ` +
    'comparison does not model is identical.')
}
