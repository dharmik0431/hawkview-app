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
    'Reads and writes mailbox contents tenant-wide, which is exfiltration and forgery in one permission.',
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
          'Unrecognised is not harmless, and this is recorded as unclassified rather than downgraded.',
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

  const removed = before.grantControls.filter((control) => !after.grantControls.includes(control))
  if (removed.length > 0) {
    if (before.grantOperator === 'AND') {
      return urgent(
        `A required grant control was removed (${removed.join(', ')}) from a policy whose controls are ` +
        'combined with AND, so a requirement is gone.')
    }
    if (before.grantOperator === 'OR') {
      return routine(
        `A grant control was removed (${removed.join(', ')}) from a policy whose controls are combined ` +
        'with OR. That removes an ALTERNATIVE way to satisfy the policy rather than a requirement, so ' +
        'it does not weaken it.')
    }
    return unclassified(
      'A grant control was removed from a policy whose combination operator is unknown, so whether a ' +
      'requirement or an alternative was removed cannot be determined. Change detected; impact unknown.',
      'grant-operator-unknown')
  }

  return routine('A conditional access policy changed without removing a control, adding an exclusion, or being disabled.')
}
