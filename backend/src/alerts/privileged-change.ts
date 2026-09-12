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

/** WHICH RULE FIRED — a stable identifier, and a wire contract from now on.
 *
 * MSPs choose what they are alerted on; HawkView's tiering is the default rather
 * than the law. The classifier states an opinion and routing maps that opinion onto
 * a channel, so an MSP disagreeing with the routing does not change the opinion.
 *
 * THE CONFIGURABLE GRAIN IS THIS LIST, NOT THE SEVEN CATALOGUE IDS. Without it the
 * finest choice available would be `security.privileged_directory_change` entire —
 * every privileged change collapsed into one switch, so "page me for a role grant
 * but not for an authentication method" is unexpressible. That coarseness would have
 * been discovered by the first person who tried to configure it.
 *
 * THESE ARE STABLE STRINGS AND THEY ARE NEVER RENAMED TO READ BETTER. Once a
 * preference row points at one, changing it is a schema migration and a conversation
 * about somebody's saved settings. A test pins the exact list for that reason.
 *
 * The type is DERIVED from the array rather than declared beside it. Two lists that
 * must agree is the coupling shape that produced three defects here in a week; one
 * list cannot drift from itself. */
export const CHANGE_RULES = [
  // Application permission grants
  'directory.hawkview_onboarding_grant',
  'directory.sensitive_permission_granted',
  'directory.permission_unrecognised',
  'directory.read_scope_granted',
  // Credentials
  'directory.application_credential_added',
  // Role assignment
  'directory.privileged_role_assigned',
  'directory.role_unidentified',
  'directory.role_not_privileged',
  // Other directory activity
  'directory.auth_method_registered',
  'directory.admin_password_reset',
  // Conditional access
  'conditional_access.state_unavailable',
  'conditional_access.policy_disabled',
  // ADDED rather than folded into policy_disabled. That id now means exactly
  // enforcing-to-off; a policy that stops ENFORCING while still evaluating is a
  // different event and an MSP may reasonably want to hear about one and not the
  // other. Renaming an existing id is forbidden; adding is a line.
  'conditional_access.policy_stopped_enforcing',
  'conditional_access.policy_stopped_reporting',
  'conditional_access.policy_state_unrecognised',
  'conditional_access.policy_state_unavailable',
  'conditional_access.list_partially_unreadable',
  // REPLACES 'conditional_access.principal_excluded', which became unreachable when
  // the exclude lists stopped being merged. A deletion rather than a rename, and
  // permitted only because nothing is wired and no preference row exists yet — after
  // wiring this would be a migration and a conversation about saved settings.
  'conditional_access.user_excluded',
  'conditional_access.group_excluded',
  'conditional_access.role_excluded',
  'conditional_access.grant_weakened',
  'conditional_access.grant_operator_unknown',
  'conditional_access.grant_operator_absent',
  'conditional_access.grant_controls_absent',
  'conditional_access.grant_denial_control',
  'conditional_access.session_control_changed',
  'conditional_access.unmodelled_dimension',
  'conditional_access.no_modelled_weakening',
] as const

export type ChangeRule = typeof CHANGE_RULES[number]

export type ChangeClassification = 'URGENT' | 'ROUTINE' | 'UNCLASSIFIED'

export interface ClassifiedChange {
  readonly classification: ChangeClassification
  /** Which rule produced this verdict. Required, so every branch names itself and
   * the compiler enumerates them — see `CHANGE_RULES`. */
  readonly rule: ChangeRule
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

/** A list of identifiers read from a collected policy, WITH A COUNT OF WHAT IT COULD
 * NOT READ.
 *
 * A plain `readonly string[]` cannot say "there was more here than I captured", and the
 * helper that built one silently dropped any entry that was not a string — in four
 * places, all of them excluded from `unmodelledFingerprint`. So if Microsoft ever sent
 * a structured entry where a string used to be, it vanished: unreadable by the
 * comparison and excluded from the digest as "modelled". Four copies of a silent drop
 * is a shape rather than an instance.
 *
 * `unreadable` is what makes those four paths eligible to leave the digest at all —
 * see `CanSayUnread` in `conditional-access-model.ts`. A non-zero count means this list
 * is not a complete account of what was collected, and the classifier treats that the
 * same way it treats an unrecognised policy state: impact unknown, never a record. */
export interface ReadList {
  readonly values: readonly string[]
  /** Entries present in the collected policy that were not strings and so were not
   * read. Zero is the normal case and the only one that permits a verdict. */
  readonly unreadable: number
}

/** Enough of a conditional access policy to compare two of them. */
export interface ConditionalAccessState {
  /** Enforcing, evaluating-but-not-enforcing, or off.
   *
   * THREE VALUES, NOT A BOOLEAN, and the boolean it replaces produced a WRONG
   * SENTENCE rather than merely a lossy one. Microsoft's `state` is
   * `enabled | enabledForReportingButNotEnforced | disabled`; projecting it onto
   * `enabled: boolean` made enabled-to-report-only read as "the policy was
   * disabled". It was not — it still evaluates and still logs, it just stops
   * enforcing. Saying more than the evidence shows is the thing this file refuses
   * everywhere else.
   *
   * And report-only to disabled read as false-to-false, no change at all, while
   * being a real loss: the policy stops even logging. Both transitions now have a
   * verdict of their own.
   *
   * The vocabulary is the product's already — `tenant-sync.service.ts` maps this
   * field to exactly these three words.
   *
   * UNRECOGNISED AND UNAVAILABLE ARE DIFFERENT FACTS AND THEY WERE ONE VALUE, which
   * produced a false sentence: an absent field reported as "a state we do not
   * recognise" when the truth is "we did not get the state". Same class as reporting
   * report-only as disabled. The product already refuses this conflation everywhere
   * else — EXACT 0 versus NOT_AVAILABLE is the same distinction and one of the oldest
   * rules here.
   *
   * They also differ in consequence. An unrecognised vocabulary is MICROSOFT changing
   * and is an engineering signal. An absent field is OUR COLLECTION degrading, which is
   * a monitoring fact somebody should hear about in its own right rather than as a
   * modifier on a security verdict.
   *
   * UNRECOGNISED is what keeps the exclusion honest. This
   * field is modelled losslessly and therefore excluded from
   * `unmodelledFingerprint`, so if a state Microsoft has not sent before were mapped
   * to OFF, that guess would be the ONLY thing said about it — an assertion of "not
   * enforcing" about something we do not understand, with the safety net switched off
   * for exactly that case. */
  readonly state: 'ON' | 'REPORT_ONLY' | 'OFF' | 'UNRECOGNISED' | 'UNAVAILABLE'
  /** How the grant controls combine. Microsoft's model: OR means any one control
   * satisfies the policy, AND means all of them must. */
  /** How the grant controls combine.
   *
   * FOUR VALUES, AND THE LAST TWO WERE ONE `null`. That conflation is the same one
   * `state` had, and it blocked the distinguished-value rule from being applied here at
   * all: ABSENT means the policy has no grant controls — normal, and correct, for a
   * session-controls-only policy — while UNRECOGNISED means Microsoft sent an operator we
   * could not read. Forcing impact-unknown on the conflated value would have fired on
   * every legitimate session-controls-only policy, which is noise generated by a safety
   * rule, and that is how safety rules get removed.
   *
   * ABSENT is a fact about the POLICY and carries no verdict of its own. UNRECOGNISED is a
   * fact about OUR READ and forces impact-unknown, exactly as an unreadable state does. */
  readonly grantOperator: 'OR' | 'AND' | 'ABSENT' | 'UNRECOGNISED'
  readonly grantControls: ReadList
  /** Excluded principals, kept apart BY KIND rather than merged.
   *
   * Merging them lost the blast radius, not a label. Excluding one named account
   * and excluding a group are different sizes of event, and this is the tier that
   * rings a phone: "a group was excluded from this policy" tells an MSP the scope
   * is potentially large and unknown, and "a principal was excluded" does not.
   *
   * A ROLE exclusion is worse still and HawkView cannot fully see it — see the
   * blind spot recorded in `docs/alerting-lifecycle.md`: role membership changes
   * alter who the exclusion covers with no policy edit at all, so there is no
   * change for us to collect. */
  readonly excludedUsers: ReadList
  readonly excludedGroups: ReadList
  readonly excludedRoles: ReadList
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

// The rule comes FIRST in each signature, so a branch cannot be written without
// naming itself and a reader sees which rule a verdict belongs to before the prose.
const urgent = (rule: ChangeRule, because: string): ClassifiedChange =>
  ({ classification: 'URGENT', rule, because, severity: URGENT_SEVERITY })
const routine = (rule: ChangeRule, because: string): ClassifiedChange =>
  ({ classification: 'ROUTINE', rule, because, severity: ROUTINE_SEVERITY })
const unclassified = (
  rule: ChangeRule, because: string, unknown: string, severity: Severity = REVIEW_SEVERITY,
): ClassifiedChange => ({ classification: 'UNCLASSIFIED', rule, because, severity, unknown })

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
        return routine('directory.hawkview_onboarding_grant',
          'HawkView onboarding: every permission in this grant is one HawkView requests.')
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
        return urgent('directory.sensitive_permission_granted',
          `A sensitive permission was granted. ${reasons.join(' ')}${amplifier}`)
      }

      // Not sensitive — but "not on the list" is not "read-only".
      const unrecognised = change.permissions.filter((permission) => !KNOWN_ROUTINE_PERMISSIONS.has(permission))
      if (unrecognised.length > 0) {
        return unclassified(
          'directory.permission_unrecognised',
          'A permission was granted that is on neither the sensitive nor the known-routine list. ' +
          'Unrecognised is not the same as established-harmless, so it is recorded as unclassified rather ' +
          'than downgraded. Nobody has decided what this permission is; that is the finding.',
          unrecognised.join(', '))
      }

      return routine('directory.read_scope_granted', 'Every permission in this grant is a known read scope.')
    }

    case 'APPLICATION_CREDENTIAL_ADDED':
      // Including to HawkView's own registration. The onboarding exemption covers
      // permissions we request; a credential is not a permission, so it is never in
      // that set and is evaluated like anyone else's.
      return urgent(
        'directory.application_credential_added',
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
          'directory.role_unidentified',
          'A directory role was assigned and the role could not be identified. The activity is a privilege ' +
          'grant regardless — only its magnitude is unknown, which is not a reason to wait.',
          change.roleTemplateId ?? 'unresolved-role',
          URGENT_SEVERITY)
      }
      return change.roleIsPrivileged
        ? urgent('directory.privileged_role_assigned', 'A role granting administrative access was assigned.')
        : routine('directory.role_not_privileged', 'A directory role with no administrative privilege was assigned.')
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
        'directory.auth_method_registered',
        'An authentication method was registered. Ordinarily unremarkable; it is also how an attacker ' +
        'holding stolen credentials establishes persistence, so it is recorded rather than dismissed.')

    case 'ADMIN_PASSWORD_RESET':
      // Same treatment and the same reason. An earlier version asserted this case
      // was "caught by the credential-attack detector, not here" — a claim about
      // another component's coverage that was never checked. No such claim is made
      // anywhere in this file.
      return routine(
        'directory.admin_password_reset',
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
  | Readonly<{ kind: 'UNDETERMINED'; rule: ChangeRule; because: string; unknown: string }>
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
  const beforeControls = before.grantControls.values
  const afterControls = after.grantControls.values
  const beforeSet = lowercased(beforeControls)
  const afterSet = lowercased(afterControls)
  const removed = beforeControls.filter((control) => !afterSet.has(control.toLowerCase()))
  const added = afterControls.filter((control) => !beforeSet.has(control.toLowerCase()))
  const operatorChanged = before.grantOperator !== after.grantOperator

  // "DID ANYTHING CHANGE" IS THE WRONG QUESTION WHEN SOMETHING IS UNREADABLE, and asking it
  // in projection space is how the second instance of this defect happened.
  //
  // `operatorChanged` compares the MAPPED operator, and two different unreadable operators
  // both map to UNRECOGNISED — so this guard answered "nothing changed" and the
  // grant_operator_unknown branch below, written for exactly that input, was unreachable.
  // A correct branch that nothing could reach.
  //
  // The honest predicate is "did anything change, OR is anything unreadable". Those are
  // different questions: an unreadable value means the first cannot be answered, not that
  // it is answered no. The same distinction as absent versus unavailable, one level up in
  // the control flow.
  //
  // THE RULE THIS HAS NOW COST TWICE, and the thing to grep for rather than the instance to
  // patch: A DISTINGUISHED-VALUE CHECK MUST NOT SIT BEHIND A CHANGE PREDICATE. I swept the
  // rest of this file — the two state checks and the unreadable-list check are
  // unconditional and were never affected; this was the only gated one. Wherever a mapping
  // collapses distinct sources onto one member, a change predicate over that mapping cannot
  // see the collapse.
  // ONLY WHERE THE UNREADABLE VALUE COULD BE HIDING SOMETHING, which is narrower than
  // "unreadable" and the narrowing is not tidiness. My first version of this let every
  // unreadable operator through, including on a policy with no grant controls at all — and
  // that reached the empty-set branch, which says "grant controls changed and one side has
  // none". Both sides were empty and nothing had changed, so the sentence was false. The
  // fix for a comparison that hid a change would have produced a verdict that misdescribed
  // one. My own test caught it.
  //
  // ABSENT is deliberately excluded. Absent is absent — there is no hidden variation behind
  // it, so "nothing changed" is knowable and true. UNRECOGNISED is the value that cannot
  // support that claim, which is the entire reason the two were split.
  const unreadableOperatorCouldHideAChange =
    (before.grantOperator === 'UNRECOGNISED' || after.grantOperator === 'UNRECOGNISED')
    && (beforeControls.length > 0 || afterControls.length > 0)

  if (!operatorChanged && !unreadableOperatorCouldHideAChange
    && removed.length === 0 && added.length === 0) return null

  // AN OPERATOR IS ONLY NEEDED WHERE THERE ARE CONTROLS TO COMBINE, and that is what
  // makes the split safe. My first version of it checked UNRECOGNISED alone and let every
  // ABSENT case through — which reported a control removal from an operator-less policy as
  // ROUTINE, because no weakening rule matches when the operator is neither AND nor OR.
  // Four tests caught it. ABSENT does not mean harmless; it means "no operator stated",
  // and with controls present that is as undirectable as an unreadable one.
  //
  // WHAT THE controls.length GUARD ACTUALLY BUYS, stated precisely because my first
  // comment here overclaimed and a mutation caught it. Dropping the guard does not make a
  // session-controls-only policy start reporting — a policy whose grant dimension did not
  // move returns before reaching this at all. What the guard prevents is a FALSE SENTENCE:
  // without it, a policy gaining its first grant controls would be reported as "states
  // grant controls but no operator" about the side that has neither. With it, that
  // transition falls to the empty-set rule below, which describes it correctly.
  //
  // Same discipline as report-only versus disabled, and as absent versus unrecognised: the
  // verdict was never the thing at risk, the sentence was.
  //
  // Two rules rather than one, because the sentences are different facts in the same way
  // absent and unrecognised are for the state: one is the policy not saying, the other is
  // us not reading.
  const undirectable = (operator: ConditionalAccessState['grantOperator'], controls: readonly string[]) =>
    controls.length > 0 && operator !== 'AND' && operator !== 'OR'

  if (undirectable(before.grantOperator, beforeControls) || undirectable(after.grantOperator, afterControls)) {
    const unreadable = before.grantOperator === 'UNRECOGNISED' || after.grantOperator === 'UNRECOGNISED'
    return unreadable
      ? {
        kind: 'UNDETERMINED',
        rule: 'conditional_access.grant_operator_unknown',
        because:
          'A grant-control operator could not be read, so whether a requirement or an alternative moved ' +
          'cannot be determined. Change detected; impact unknown.',
        unknown: 'grant-operator-unknown',
      }
      : {
        kind: 'UNDETERMINED',
        rule: 'conditional_access.grant_operator_absent',
        because:
          'A policy states grant controls but no operator combining them, so whether they are all ' +
          'required or any one suffices is not stated and a change to them cannot be directed. Change ' +
          'detected; impact unknown.',
        unknown: 'grant-operator-absent',
      }
  }

  if (beforeControls.length === 0 || afterControls.length === 0) {
    // AND over no controls requires nothing; OR over no controls admits nothing. The
    // operators invert at the empty set, so every rule below would read the wrong way.
    // Microsoft does not permit a policy with neither grant nor session controls, which
    // makes this a state to report rather than interpret.
    //
    // This is also where an ABSENT operator lands when the grant dimension genuinely
    // moved — a policy gaining or losing its grant controls entirely. It is reported
    // rather than directed, for the same reason: with no controls on one side there is no
    // operator semantics to compare against.
    return {
      kind: 'UNDETERMINED',
      rule: 'conditional_access.grant_controls_absent',
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
      rule: 'conditional_access.grant_denial_control',
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
  const operatorFlipIsVacuous = controlsUnchanged && afterControls.length === 1

  const reasons: string[] = []
  if (before.grantOperator === 'AND' && after.grantOperator === 'OR' && !operatorFlipIsVacuous) {
    reasons.push(
      `Grant controls that were all required are now alternatives (${afterControls.join(', ')}), so any ` +
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
        `The grant operator changed from AND to OR over a single control (${afterControls.join(', ')}), ` +
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
      'conditional_access.state_unavailable',
      'A conditional access policy changed and usable before/after values were not available. ' +
      'Change detected; impact unknown.',
      'conditional-access-state-missing')
  }

  // THE SAME RULE, APPLIED TO THE LISTS. An entry the mapper could not read is a
  // distinguished value exactly as UNRECOGNISED is, and these four paths are excluded
  // from the fingerprint — so if an unread entry did not stop a verdict here, nothing
  // would report it. That was the silent drop: four copies of a filter that discarded
  // whatever was not a string, on four paths with no backstop.
  //
  // Counting rather than naming, because what was dropped is by definition something
  // this comparison could not interpret, and printing it would be guessing at a shape.
  const unreadable = [
    ['grant controls', before.grantControls, after.grantControls],
    ['excluded users', before.excludedUsers, after.excludedUsers],
    ['excluded groups', before.excludedGroups, after.excludedGroups],
    ['excluded roles', before.excludedRoles, after.excludedRoles],
  ] as const
  const incomplete = unreadable.filter(([, left, right]) => left.unreadable > 0 || right.unreadable > 0)
  if (incomplete.length > 0) {
    return unclassified(
      'conditional_access.list_partially_unreadable',
      `A policy list contained entries this comparison could not read (${incomplete.map(([name]) => name).join(', ')}), ` +
      'so it is not a complete account of what the policy contains and no comparison over it can be ' +
      'trusted. Change detected; impact unknown.',
      'policy-list')
  }

  // ENFORCING TO ANYTHING ELSE is the weakening, and the two destinations are not
  // the same event. Reported separately so the record says what actually happened.
  if (before.state === 'ON' && after.state === 'OFF') {
    return urgent('conditional_access.policy_disabled',
      'A conditional access policy was disabled. Its protection stops applying immediately, and it no ' +
      'longer evaluates or logs.')
  }
  if (before.state === 'ON' && after.state === 'REPORT_ONLY') {
    return urgent('conditional_access.policy_stopped_enforcing',
      'A conditional access policy was switched to report-only. It still evaluates and still logs, and it ' +
      'no longer enforces — so access it previously blocked is now allowed.')
  }
  if (before.state === 'REPORT_ONLY' && after.state === 'OFF') {
    // NOT A WEAKENING UNDER THE POLICY SEMANTICS, and saying otherwise would be the
    // overreach this file refuses: a report-only policy already allowed every session
    // and a disabled one allows the same set, so nobody's access changed. What is lost
    // is OUR visibility — the evaluation log that tells an MSP what the policy would
    // have done. Routine by default, and now configurable on its own rule if an MSP
    // decides losing that signal matters more to them than it does to us.
    return routine('conditional_access.policy_stopped_reporting',
      'A report-only conditional access policy was disabled. No session\'s access changes — report-only ' +
      'was not enforcing either — but the policy stops evaluating, so the log of what it would have done ' +
      'ends here.')
  }

  // BY KIND, because the kinds are different sizes of event on the tier that pages.
  // A role exclusion first: its reach is the largest and the least knowable.
  const addedRoles = after.excludedRoles.values.filter((role) => !before.excludedRoles.values.includes(role))
  if (addedRoles.length > 0) {
    return urgent('conditional_access.role_excluded',
      `A directory role was excluded from a conditional access policy (${addedRoles.length}), so the ` +
      'policy no longer applies to anybody holding that role. Who that covers changes as role ' +
      'assignments change, with no further edit to the policy.')
  }
  const addedGroups = after.excludedGroups.values.filter((group) => !before.excludedGroups.values.includes(group))
  if (addedGroups.length > 0) {
    return urgent('conditional_access.group_excluded',
      `A group was excluded from a conditional access policy (${addedGroups.length}), so the policy no ` +
      'longer applies to its members. The number of accounts that covers is not visible from the policy ' +
      'itself.')
  }
  const addedUsers = after.excludedUsers.values.filter((user) => !before.excludedUsers.values.includes(user))
  if (addedUsers.length > 0) {
    return urgent('conditional_access.user_excluded',
      `An account was excluded from a conditional access policy (${addedUsers.length}), so the policy no ` +
      'longer applies to it.')
  }

  const grant = grantChangeVerdict(before, after)
  if (grant !== null && grant.kind === 'WEAKER') {
    // EVERY reason that fired, not the first. A compound change weakened the policy
    // more than once and saying so is the accurate report -- but the reason this is
    // a list rather than an early return is narrower: AND [mfa, cd] -> OR [mfa] is
    // urgent under TWO rules, and an implementation returning whichever it reached
    // first would keep the verdict green while the reason underneath it moved. That
    // is the changed-subject shape, and a list cannot have it.
    return urgent('conditional_access.grant_weakened', grant.reasons.join(' '))
  }
  if (grant !== null && grant.kind === 'UNDETERMINED') {
    return unclassified(grant.rule, grant.because, grant.unknown)
  }

  // STATE READABILITY IS CHECKED HERE, BELOW EVERY RULE THAT DOES NOT READ STATE.
  //
  // IT USED TO RUN FIRST AND THAT WAS A SAFETY PROPERTY POINTING THE WRONG WAY. The
  // reasoning for putting it first was sound about the rules that DO read state — no
  // state rule should treat an unreadable value as one of the three it understands — and
  // I applied it to the whole function, which preempted the exclusion rules and the
  // grant verdict. Neither of those looks at state at all.
  //
  // QA's headline is the right way to say it: THE WORSE COLLECTION GETS, THE QUIETER
  // ALERTING GETS. A role exclusion that is urgent on its own came back impact-unknown
  // the moment it co-occurred with an unreadable state — and because an ABSENT field
  // mapped to the same value, a merely truncated snapshot was enough to do it. No
  // Microsoft vocabulary change required. That is absence of evidence quietly becoming
  // evidence of absence, which is the defect this entire feature exists to remove.
  //
  // THE RULE THAT SETTLES ORDERING, and it is sharper than "a weakening outranks an
  // unknown": AN UNKNOWN IN THE SAME DIMENSION AS A VERDICT INVALIDATES THAT VERDICT;
  // AN UNKNOWN IN A DIFFERENT DIMENSION DOES NOT. An unreadable grant list sits above
  // the grant rules because those rules read it and their conclusion would be computed
  // over incomplete data. An unreadable STATE sits below them because they never touch
  // it, and the exclusion they found is as real as it was before the state went missing.
  if (before.state === 'UNAVAILABLE' || after.state === 'UNAVAILABLE') {
    return unclassified(
      'conditional_access.policy_state_unavailable',
      'A conditional access policy was compared without its state field, so whether it is enforcing was ' +
      'not read rather than not understood. This is a gap in what was collected, not a finding about the ' +
      'policy. Change detected; impact unknown.',
      'policy-state-absent')
  }
  if (before.state === 'UNRECOGNISED' || after.state === 'UNRECOGNISED') {
    return unclassified(
      'conditional_access.policy_state_unrecognised',
      'A conditional access policy reported a state this comparison does not recognise, so whether it is ' +
      'enforcing cannot be determined — and two states we cannot read are not thereby the same state. ' +
      'Change detected; impact unknown.',
      'policy-state')
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
      'conditional_access.session_control_changed',
      'A session control changed. Sign-in frequency and persistent browser sessions are where a session ' +
      'is extended from an hour to weeks, and their direction depends on values this comparison does not ' +
      'capture. Change detected; impact unknown.',
      'session-controls')
  }

  if (before.unmodelledFingerprint !== after.unmodelledFingerprint) {
    return unclassified(
      'conditional_access.unmodelled_dimension',
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
    'conditional_access.no_modelled_weakening',
    `${grant === null
      ? 'The grant controls and their combination operator are unchanged.'
      : grant.compared} Session controls are unchanged, and the digest of every dimension this ` +
    'comparison does not model is identical.')
}
