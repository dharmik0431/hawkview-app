import type { EventOutcome } from './contract.js';
import type { OutOfScopeReason, UncitedReason, UnknownObservation } from './reasons.js';

/**
 * What HawkView is willing to claim about Microsoft's payloads, and on what
 * evidence.
 *
 * Two kinds of claim live here and they are NOT interchangeable:
 *
 *  - A RESULT-CODE claim reads a documented Azure AD sign-in error code and
 *    states what Microsoft documents it to mean. It is a semantic contract
 *    published by the provider.
 *
 *  - A PAYLOAD-SHAPE claim asserts that some field is present, absent, or
 *    carries a particular value across real traffic. It is empirical and worth
 *    nothing until checked against real rows INCLUDING A CONTROL COHORT THAT
 *    MUST NOT MATCH. Synthetic tests structurally cannot validate one.
 *
 * TWO RULES ENFORCED HERE, and they close different holes:
 *
 *  1. An unverified payload-shape predicate has NO effect on classification.
 *     It is observed and counted, never acted on. Not "routes to UNKNOWN"
 *     either — an event moved to UNKNOWN is just as absent from evaluation as
 *     one moved out of scope, so that is the same failure in a politer
 *     wrapper. This is the `servicePrincipalId` failure mode made structurally
 *     unavailable rather than merely reviewed against.
 *
 *  2. A result code may be mapped DOES_NOT_APPLY only with a positive
 *     documented citation for why it can NEVER be credential-attack evidence.
 *     Rule 1 does not reach this case: a wrong exclusion is a CONFIDENT
 *     classification, not an unverified one, so it walks straight past the
 *     guard. The predecessor confidently classified 50076 — a post-password
 *     MFA challenge, one digit from the highest-value code in the catalogue —
 *     as "not a credential event". Absence of a reason to include is not a
 *     reason to exclude. Codes without a citation land in UNKNOWN, which costs
 *     coverage, blocks nothing, and is recoverable the moment one exists.
 */

/**
 * The complete set of Graph `status.errorCode` values ever observed, across
 * all tenants and all history. Fourteen values.
 *
 * A code mapped in RESULT_CODES but absent from here is ANTICIPATION from
 * documentation, not observation, and carries `graphObservation: 'NOT_OBSERVED'`
 * so it cannot read as a working path. That distinction has already caught two
 * mistakes in this workstream — the third 50053 text variant and code 53004 —
 * both of which were sound readings of Microsoft's documentation for events we
 * have never once seen.
 */
export const OBSERVED_GRAPH_ERROR_CODES: readonly number[] = [
  0, 16003, 50011, 50020, 50053, 50074, 50126, 50140, 53000, 53003, 65001, 70044, 90094, 500121,
];

export type CodeDisposition =
  | { readonly kind: 'APPLIES'; readonly outcome: EventOutcome }
  | { readonly kind: 'DOES_NOT_APPLY'; readonly reason: OutOfScopeReason }
  | { readonly kind: 'NOT_YET_CITED'; readonly reason: UncitedReason }
  | { readonly kind: 'UNKNOWN'; readonly observation: UnknownObservation };

/** Microsoft's three claim classes. Every mapping states which it makes. */
export type ClaimClass =
  /** Supportable from failure distributions, in aggregate only. */
  | 'ATTACK_IN_AGGREGATE'
  /** Supportable from block and interrupt codes. */
  | 'CONTROL'
  /** Both at once. */
  | 'ATTACK_AND_CONTROL'
  /** Neither: hygiene, expected flow, or remediation confirmation. */
  | 'NEITHER';

export interface ResultCodeEntry {
  readonly code: number;
  readonly microsoftName: string;
  /**
   * Whether this code has ever been seen on the Graph feed. `NOT_OBSERVED`
   * means the mapping is anticipation from documentation: keep it, because a
   * documented meaning is worth anticipating, but it is exercised only by
   * synthetic fixture and must not read as a working path.
   */
  readonly graphObservation: 'OBSERVED' | 'NOT_OBSERVED';
  readonly claimClass: ClaimClass;
  readonly disposition: CodeDisposition;
  /**
   * Required when `disposition.kind === 'DOES_NOT_APPLY'`: the grounds for
   * saying this code can never be credential-attack evidence. Enforced by a
   * test, not by convention.
   *
   * The KIND is carried separately because the two kinds age differently and
   * would otherwise be read as the same strength. A provider statement is a
   * fact about the world and stays true until Microsoft changes it; a product
   * decision is a choice we made and can revisit. Anyone auditing an exclusion
   * needs to know which one they are looking at.
   */
  readonly exclusionCitation?: {
    readonly kind: 'PROVIDER_STATEMENT' | 'PRODUCT_DECISION';
    readonly text: string;
  };
  /**
   * The text meanings this code's description may resolve to, when its meaning
   * lives in free text. Declared PER CODE rather than matching every fragment
   * against every code, so one code's phrasing can never be read as another
   * code's meaning.
   */
  readonly textMeanings?: readonly FailureReasonMeaning[];
  readonly note?: string;
}

/**
 * Documented sign-in result codes.
 *
 * "An account is compromised" is NOT supportable from error codes alone, ever,
 * so no code maps to anything asserting it. The strongest available claim is
 * "the password was accepted and the sign-in did not complete", which is an
 * outcome, not a verdict.
 *
 * A code absent from this table is UNKNOWN. That is the third bucket doing its
 * job, not a fallback.
 */
export const RESULT_CODES: readonly ResultCodeEntry[] = [
  {
    code: 0,
    graphObservation: 'OBSERVED',
    microsoftName: 'None (success)',
    claimClass: 'NEITHER',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' },
    note:
      'Value is contextual, not benign: a 0 from an attacker address after a 50126 storm is the most ' +
      'important record in an incident. Gated on the description text, which differs by feed — see ' +
      'SHAPE_PREDICATES, and do not mix the two paths.',
  },
  {
    code: 50126,
    graphObservation: 'OBSERVED',
    microsoftName: 'InvalidUserNameOrPassword',
    claimClass: 'ATTACK_IN_AGGREGATE',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' },
    note:
      'Microsoft: "Expect to see some number of these in your logs due to users making mistakes." Never ' +
      'assert an attack from one event. Microsoft’s own password-spray code set EXCLUDES 50126: the ' +
      'failure storm identifies the attack, the post-password interrupts identify the victims.',
  },
  {
    code: 50074,
    graphObservation: 'OBSERVED',
    microsoftName: 'UserStrongAuthClientAuthNRequired (did not pass MFA)',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' },
    note:
      'The single highest-value code in the catalogue: the code that says the second factor stopped ' +
      'someone. One digit from 50076 and NOT the same thing.',
  },
  {
    code: 50076,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'UserStrongAuthClientAuthNRequiredInterrupt (challenge issued)',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' },
    note:
      'The predecessor classified this as NON_QUALIFYING, i.e. "not a credential event". It is a control ' +
      'signal: the password was accepted and a challenge was issued. Inheriting that mapping would route ' +
      'the evidence for our best detector into does-not-apply, where nothing would ever see it.',
  },
  {
    code: 500121,
    graphObservation: 'OBSERVED',
    microsoftName: 'Authentication failed during strong authentication request',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' },
    note:
      'SOURCING CAVEAT: not in Microsoft’s canonical error reference, documented only in the secops ' +
      'guides. In Microsoft’s own spray code set. Carried with that caveat rather than silently.',
  },
  {
    code: 50072,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'UserStrongAuthEnrollmentRequiredInterrupt',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' },
    note: 'In Microsoft’s own spray code set.',
  },
  {
    code: 50079,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'UserStrongAuthEnrollmentRequired (security info registration)',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' },
    note: 'In Microsoft’s own spray code set.',
  },
  {
    code: 53003,
    graphObservation: 'OBSERVED',
    microsoftName: 'BlockedByConditionalAccess',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    note: 'Also worth watching: a success paired with 53003 means auth worked and the session was blocked.',
  },
  {
    code: 530032,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'BlockedByConditionalAccessOnSecurityPolicy',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53000,
    graphObservation: 'OBSERVED',
    microsoftName: 'DeviceNotCompliant',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53001,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'DeviceNotDomainJoined',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 50097,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'DeviceAuthenticationRequired',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53004,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'ProofUpBlockedDueToRisk',
    claimClass: 'ATTACK_AND_CONTROL',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' },
    exclusionCitation: {
      kind: 'PRODUCT_DECISION',
      text:
        'The owner’s channel-separation rule: our findings and Microsoft-reported risk are two channels ' +
        'that are never merged or summed. Microsoft’s own name for this code is ProofUpBlockedDueToRisk — ' +
        'a block Microsoft’s intelligence decided on, not a control the tenant configured. A CHOICE we ' +
        'made, revisitable, unlike a provider statement.',
    },
    note:
      'Cannot configure MFA due to suspicious activity. Placed in the Microsoft channel on the standing ' +
      'whose-judgement test, which is sound — but NO PRODUCTION EVIDENCE: zero rows, all tenants, all ' +
      'history. Same shape as the third 50053 text variant. The branch is kept because ' +
      'ProofUpBlockedDueToRisk naming a risk-driven block is reasonable anticipation from documentation, ' +
      'and it is exercised by synthetic fixture only.',
  },
  {
    code: 50131,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'ConditionalAccessFailed',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    textMeanings: ['SUSPICIOUS_ACTIVITY_BLOCK', 'HIGH_CONFIDENCE_RISK_BLOCK'],
    note:
      'A Conditional Access failure is the TENANT’S OWN control working, which is ours to report. But this ' +
      'code also carries a "request blocked due to suspicious activity" variant in its description, and ' +
      'that is Microsoft’s judgement rather than a control the tenant configured — so the text can move it ' +
      'to MICROSOFT_RISK_VERDICT. Unmatched text keeps the control-block default, which is the confident ' +
      'reading of the code itself.',
  },
  {
    code: 50057,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'UserDisabled',
    claimClass: 'ATTACK_IN_AGGREGATE',
    disposition: { kind: 'APPLIES', outcome: 'DISABLED_ACCOUNT_ATTEMPT' },
    note: 'Microsoft: "Could indicate someone trying to access an account after they left."',
  },

  {
    code: 50011,
    graphObservation: 'OBSERVED',
    microsoftName: 'InvalidReplyTo',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'APPLICATION_CONFIGURATION_ERROR' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text:
        'Microsoft: "InvalidReplyTo - The reply address is missing, misconfigured, or doesn\'t match reply ' +
        'addresses configured for the app." The text locates the failure in the application\'s ' +
        'configuration, making no claim about the user in either direction.',
    },
  },
  {
    code: 70044,
    graphObservation: 'OBSERVED',
    microsoftName: 'The session has expired or is invalid (sign-in frequency)',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'SIGN_IN_FREQUENCY_POLICY_EXPIRY' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text:
        'Microsoft (Conditional Access troubleshooting guidance): the session has expired or is invalid due ' +
        'to sign-in frequency checks by Conditional Access. Same trap as 50140 and 50058 — a control ' +
        'working exactly as configured, which a naive implementation counts as failures. SOURCING CAVEAT: ' +
        'this is the CA troubleshooting documentation, NOT the canonical error reference, so it is carried ' +
        'with the same caveat as 500121.',
    },
    note:
      'VOLUME UNKNOWN, and it matters here more than elsewhere: if this code is high-volume then a ' +
      'non-canonical citation is doing a lot of exclusion work. Worth a row count before anyone relies on ' +
      'the exclusion. Whatever the volume is, it is a property of the tenant’s sign-in-frequency setting ' +
      'rather than of any attacker.',
  },
  // ---- The codes that clear the exclusion standard. ----
  {
    code: 50140,
    graphObservation: 'OBSERVED',
    microsoftName: 'InterruptedKMSI',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'KEEP_ME_SIGNED_IN' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text: 'Microsoft: "This is an expected part of the sign in flow."',
    },
    note: 'Naive implementations inflate failure counts with this code.',
  },
  {
    code: 50058,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'UserUnauthenticated (session insufficient for SSO)',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text: 'Microsoft: "a common error that’s expected."',
    },
  },

  // ---- Recognized, but no citation supports excluding them. ----
  {
    code: 50158,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'ExternalSecurityChallengeNotSatisfied',
    claimClass: 'NEITHER',
    disposition: { kind: 'UNKNOWN', observation: 'AMBIGUOUS_BY_PROVIDER_STATEMENT' },
    note: 'Microsoft: "This code alone doesn’t indicate a failure." Do not read a failure into it.',
  },
  {
    code: 50055,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'InvalidPasswordExpiredPassword',
    claimClass: 'ATTACK_IN_AGGREGATE',
    disposition: { kind: 'APPLIES', outcome: 'CREDENTIAL_CONFIRMED_VALID' },
    note:
      'RESEARCHED: the password IS validated before the expiry ends the session. Microsoft\'s ' +
      'troubleshooting guidance describes the credentials as "correct and validated" with the password ' +
      'expired; the canonical text says the "login or session was ended", which presupposes a login that ' +
      'got far enough to end; a wrong password produces 50126 instead; and the user is offered a reset, ' +
      'which is not offered to someone who failed authentication. SOURCING CAVEAT, same class as 70044 ' +
      'and 500121: the explicit "password step succeeds" phrasing is troubleshooting and support ' +
      'guidance, not the canonical error reference, which supports it by implication only. NOT in the ' +
      'interrupt family — see CREDENTIAL_CONFIRMED_VALID for why a password policy is not an ' +
      'attacker-resistant control.',
  },
  {
    code: 50144,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'InvalidPasswordExpiredOnPremPassword',
    claimClass: 'ATTACK_IN_AGGREGATE',
    disposition: { kind: 'APPLIES', outcome: 'CREDENTIAL_CONFIRMED_VALID' },
    note: 'The on-premises counterpart of 50055, same reasoning and same sourcing caveat.',
  },
  {
    code: 50056,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'InvalidOrNullPassword',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'Microsoft: "Invalid or null password: password doesn\'t exist in the directory for this user." ' +
      'Stronger than plain hygiene: it suggests a password authentication attempt against a federated or ' +
      'passwordless account, which is mildly attack-adjacent. Held, not excluded.',
  },
  {
    code: 50133,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'SsoArtifactInvalidOrExpired (password change)',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'SESSION_INVALIDATED_BY_REMEDIATION' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text:
        'Microsoft: "SsoArtifactRevoked - The session isn\'t valid due to password expiration or recent ' +
        'password change." The text attributes the failure to remediation having happened, which is the ' +
        'opposite of an attack signal.',
    },
    note: 'Useful as remediation-took-effect confirmation, which is a different product surface.',
  },
  {
    code: 50173,
    graphObservation: 'NOT_OBSERVED',
    microsoftName: 'FreshTokenNeeded (grant revoked)',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'SESSION_INVALIDATED_BY_REMEDIATION' },
    exclusionCitation: {
      kind: 'PROVIDER_STATEMENT',
      text:
        'Microsoft: "The provided grant has expired due to it being revoked... The grant was issued on ' +
        '\'{authTime}\' and the TokensValidFrom date is \'{validDate}\'." Attributes the failure to a ' +
        'revocation, and carries the remediation timestamp with it.',
    },
    note:
      'The strongest of the remediation-confirmation codes, because the message carries an actual ' +
      'timestamp — so it can corroborate that a session revocation genuinely took effect rather than ' +
      'being asserted. Out of scope for detection, valuable to a different surface.',
  },
  {
    code: 65001,
    graphObservation: 'OBSERVED',
    microsoftName: 'ConsentRequired',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'Previously mapped out of scope here on no citation, which is the 50076 mistake in miniature. It is ' +
      'also one of only three codes observed in more than one tenant, so it is high-volume: a citation ' +
      'either way is worth having.',
  },

  {
    code: 90094,
    graphObservation: 'OBSERVED',
    microsoftName: 'AdminConsentRequired',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'Microsoft: "AdminConsentRequired - Administrator consent is required." Recommended to me as ' +
      '"Neither", and NOT excluded on that basis — the same recommendation also noted that repeated ' +
      'admin-consent-required against one user is adjacent to the illicit-consent-grant gap Microsoft ' +
      'names in its own compromised-account remediation. A reason it MIGHT be evidence is not a citation ' +
      'that it can never be, so it is held rather than excluded. Same treatment and same pointer as 65001; ' +
      'both become relevant if consent-grant collection lands.',
  },
  // ---- Meaning lives in free text. ----
  {
    code: 50053,
    graphObservation: 'OBSERVED',
    microsoftName: 'IdsLocked / IP blocked / built-in protection block',
    claimClass: 'ATTACK_AND_CONTROL',
    disposition: { kind: 'UNKNOWN', observation: 'AMBIGUOUS_FAILURE_REASON_TEXT' },
    textMeanings: ['SMART_LOCKOUT', 'MALICIOUS_IP_BLOCK', 'HIGH_CONFIDENCE_RISK_BLOCK'],
    note:
      'THREE documented meanings, resolved from the description text via FAILURE_REASON_MEANINGS. This ' +
      'entry is the fallback for text matching none of them, or more than one.',
  },

  // ---- Not a Microsoft code at all. ----
  {
    code: 1,
    // Observed on the AUDIT feed, never on Graph. This marker describes the
    // Graph feed, so NOT_OBSERVED is correct and is not a claim it is unseen.
    graphObservation: 'NOT_OBSERVED',
    microsoftName: '(not a Microsoft code)',
    claimClass: 'NEITHER',
    disposition: { kind: 'UNKNOWN', observation: 'RESULT_CODE_NOT_AN_AZURE_CODE' },
    note:
      'PROVENANCE IS AN OPEN QUESTION and the earlier claim here was too strong. I was told "1" is a ' +
      'value HawkView invents on the audit-fallback path. Reading the collector, ' +
      'reportedAuthenticationErrorCode() sources it from the record’s own LoginStatus/ErrorCode fields ' +
      'and their extended properties — so a 1 appears to be Microsoft’s LoginStatus surfaced into a field ' +
      'that otherwise carries Azure AD error codes, which is a category confusion rather than an ' +
      'invention. That distinction matters: an invented value is unstable and ours to fix, whereas ' +
      'Microsoft’s LoginStatus in a mislabelled field is stable data we are reading wrongly. Flagged for ' +
      're-verification. Either way the treatment is the same and is not affected by the answer: 1 is not ' +
      'an Azure sign-in error code, so it is used neither as a key nor as corroboration. If the ' +
      'LoginStatus reading holds, the defect is in our STORAGE SCHEMA rather than in Microsoft\'s data — ' +
      'a success/failure flag and an AADSTS code space merged into one column — and the fix is to stop ' +
      'merging them, which is a schema change and not a classifier change. Logged separately.',
  },
];

/**
 * Codes this layer recognizes but can never classify, because subject
 * resolution runs first and these codes describe a subject that is not in the
 * directory.
 *
 * A KNOWN BLIND SPOT, recorded rather than hidden: Microsoft names clusters of
 * these from one address as username enumeration, and requiring a resolved
 * directory user means the enumeration signal lands in SUBJECT_NOT_IN_DIRECTORY
 * with the code discarded. Detecting enumeration needs a path for unresolved
 * subjects, which is a scope decision and not this layer's to make.
 */
export const UNREACHABLE_BY_SUBJECT_RESOLUTION: readonly {
  readonly code: number;
  readonly microsoftName: string;
  /** Whether this code actually occurs in our data. */
  readonly graphObservation: 'OBSERVED' | 'NOT_OBSERVED';
  readonly citation?: string;
}[] = [
  { code: 50034, microsoftName: 'UserAccountNotFound', graphObservation: 'NOT_OBSERVED' },
  { code: 51004, microsoftName: 'UserAccountNotInDirectory', graphObservation: 'NOT_OBSERVED' },
  {
    code: 16003,
    microsoftName: 'SsoUserAccountNotFoundInResourceTenant',
    graphObservation: 'OBSERVED',
    citation:
      'Microsoft: "SsoUserAccountNotFoundInResourceTenant - Indicates that the user hasn\'t been ' +
      'explicitly added to the tenant." Same family as 50034/51004: clusters from one source are ' +
      'enumeration.',
  },
  {
    code: 50020,
    microsoftName: 'UserUnauthorized',
    graphObservation: 'OBSERVED',
    citation:
      'Microsoft: "UserUnauthorized - Users are unauthorized to call this endpoint. User account from ' +
      'identity provider does not exist in tenant and cannot access the application." Specifically an ' +
      'identity from ANOTHER identity provider, which makes it cross-tenant or guest enumeration — a ' +
      'different story to tell a technician than same-tenant enumeration.',
  },
];

const BY_CODE: ReadonlyMap<number, ResultCodeEntry> = new Map(
  RESULT_CODES.map(entry => [entry.code, entry]),
);

/**
 * Codes that DO occur in our data and that this table does not map, so they
 * classify as UNRECOGNIZED_ERROR_CODE and cost stated coverage.
 *
 * Five of the fourteen observed codes. That is the honest state, not a bug —
 * mapping them from a half-remembered meaning is exactly the error this module
 * exists to prevent — but it is a real coverage gap and each wants a documented
 * meaning plus a volume before it moves anywhere. Unlike the anticipated
 * entries above, these are the reverse problem: rows with no mapping rather
 * than mappings with no rows.
 */
export const OBSERVED_BUT_UNMAPPED_GRAPH_CODES: readonly number[] = OBSERVED_GRAPH_ERROR_CODES
  .filter(code =>
    !BY_CODE.has(code) && !UNREACHABLE_BY_SUBJECT_RESOLUTION.some(entry => entry.code === code))
  .sort((left, right) => left - right);

/**
 * Disposition for a result code, before any description-text refinement.
 *
 * Returning UNKNOWN for an unlisted code is NOT the forbidden default arm.
 * The forbidden default arm is on the reason vocabularies — mapping a reason
 * to a label — and there is none: see `reasons.ts`. An unrecognized provider
 * code genuinely is an unrecognized provider code.
 */
export function dispositionForCode(code: number): CodeDisposition {
  return BY_CODE.get(code)?.disposition ?? { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_ERROR_CODE' };
}

export function resultCodeEntry(code: number): ResultCodeEntry | undefined {
  return BY_CODE.get(code);
}

/**
 * Meanings that live in a result code's description text rather than in the
 * code, as a CLOSED SET.
 *
 * The earlier decision was to give 50053 one reason code and parse no text, so
 * thin single-tenant evidence never became a contract. That was reversed on
 * documentation research: 50053 has three documented meanings, and the third —
 * "Sign-in was blocked by built-in protections due to high confidence of risk"
 * — is a Microsoft high-confidence RISK VERDICT delivered regardless of
 * licence, existing only in this string. Bucketing on the code alone makes it
 * invisible, and for a tenant without Entra ID P2 it is the only Microsoft
 * risk verdict that tenant will ever see.
 *
 * The original durability concern is answered structurally rather than by
 * avoidance: text matching nothing, or matching more than one meaning, routes
 * to UNKNOWN. A reworded or localised string costs stated coverage and cannot
 * silently misclassify. The hazard was never "parse text", it was "guess from
 * text".
 */
export type FailureReasonMeaning =
  | 'SMART_LOCKOUT'
  | 'MALICIOUS_IP_BLOCK'
  | 'HIGH_CONFIDENCE_RISK_BLOCK'
  | 'SUSPICIOUS_ACTIVITY_BLOCK';

export interface FailureReasonPattern {
  readonly meaning: FailureReasonMeaning;
  /** Distinctive lowercase fragments. Deliberately punctuation-light. */
  readonly fragments: readonly string[];
  readonly disposition: CodeDisposition;
  /**
   * Whether this branch has ever been seen in real data. A branch with no
   * production evidence is present in code and exercised only by a synthetic
   * fixture; it must not read as a working path.
   */
  readonly verification:
    | { readonly state: 'OBSERVED_IN_PRODUCTION'; readonly evidence: string }
    | { readonly state: 'NO_PRODUCTION_EVIDENCE'; readonly why: string };
  readonly note: string;
}

export const FAILURE_REASON_MEANINGS: readonly FailureReasonPattern[] = [
  {
    meaning: 'SUSPICIOUS_ACTIVITY_BLOCK',
    fragments: ['suspicious activity'],
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' },
    verification: {
      state: 'NO_PRODUCTION_EVIDENCE',
      why:
        'Code 50131 is not among the codes observed with volume, so this branch has no rows behind it. ' +
        'Synthetic fixture only, and recorded as such.',
    },
    note:
      'Microsoft’s judgement, not a control the tenant configured, so it goes to the Microsoft-reported ' +
      'risk channel for the same reason as the high-confidence-risk text.',
  },
  {
    meaning: 'HIGH_CONFIDENCE_RISK_BLOCK',
    // ONE fragment, and the most distinctive one available. This is the only
    // branch here that moves an event OUT of `applies`, so a fragment broad
    // enough to catch a neighbouring meaning would divert real evidence into
    // the Microsoft channel. 'built-in protections' was dropped for that
    // reason: it is not distinctive enough to carry that consequence.
    fragments: ['high confidence of risk'],
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' },
    verification: {
      state: 'NO_PRODUCTION_EVIDENCE',
      why:
        'Zero occurrences. Across all 1,479 rows of code 50053 in all history and all tenants there are ' +
        'exactly TWO distinct description values — lockout and malicious-IP — and this is neither of them. ' +
        'It is a documented Microsoft string and anticipating it is reasonable, but it is exercised only by ' +
        'a synthetic fixture, exactly like the Graph subject-binding failure path. Present in code, no data ' +
        'behind it. Its practical value is also lower than it first appeared: the code only has volume in ' +
        'one tenant, and that tenant is the one that holds Entra ID P2 and can already see Microsoft’s risk ' +
        'signal directly. The tenants that would need this string are the ones where the code does not appear.',
    },
    note:
      'Microsoft’s own verdict, not ours. Held out of HawkView findings because our findings and ' +
      'Microsoft-reported risk are two channels that are never merged or summed, and surfaced separately ' +
      'as batch.microsoftRiskVerdicts so the signal is not lost to a counter.',
  },
  {
    meaning: 'MALICIOUS_IP_BLOCK',
    fragments: ['malicious activity'],
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' },
    verification: {
      state: 'OBSERVED_IN_PRODUCTION',
      evidence:
        'One of exactly two description values observed on code 50053, at 921 of 1,479 rows (62.3%) in a ' +
        'single-instant query. Literal, measured with terminal characters checked: ' +
        '"Sign-in was blocked because it came from an IP address with malicious activity" — 78 characters, ' +
        'no trailing period, all ASCII.',
    },
    note:
      'Microsoft blocked the sign-in because ITS OWN threat intelligence flagged the address. That is ' +
      'Microsoft’s judgement, not a control the tenant configured, so it goes to the Microsoft channel on ' +
      'the standing whose-judgement test. These 921 rows were misfiled as HawkView findings the whole time ' +
      'they sat in the sign-in log; moving them fills that tenant’s Microsoft-risk channel with no API ' +
      'call, no consent grant and no purchase.',
  },
  {
    meaning: 'SMART_LOCKOUT',
    fragments: ['too many times with an incorrect user id or password'],
    disposition: { kind: 'APPLIES', outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES' },
    verification: {
      state: 'OBSERVED_IN_PRODUCTION',
      evidence:
        'The other of exactly two description values observed on code 50053, at 558 of 1,479 rows (37.7%) ' +
        'in a single-instant query. Literal, measured with terminal characters checked: "The account is ' +
        'locked, you\'ve tried to sign in too many times with an incorrect user ID or password." — 100 ' +
        'characters, TRAILING PERIOD PRESENT, and the apostrophe is ASCII 0x27 rather than a Unicode right ' +
        'single quote. The two literals differ in terminal punctuation and that difference survives a paste ' +
        'and fails a comparison, which is why this matcher is substring-based on a distinctive fragment ' +
        'rather than an equality test. It carries unique detection ' +
        'weight: for 94.8% of lockout rows there is NO 50126 for the same user within ±15 minutes, so ' +
        'Microsoft emits the lockout without the individual attempts alongside it and at the moment of ' +
        'lockout this is the ONLY signal present. A 50126-only detector eventually surfaces the affected ' +
        'users — 100% of them appear in 50126 rows at some point — but misses the lockout events, and ' +
        'misses them when they happen. CAVEAT: one tenant, at most four users, one locale, six weeks, and ' +
        '1,479 blocks against four accounts is not obviously normal traffic, so the 94.8% informs the ' +
        'mapping and does not settle the general case.',
    },
    note:
      'Smart lockout "tracks the last three bad password hashes to avoid incrementing the lockout counter ' +
      'for the same password", so a lockout implies VARIED password attempts. A misconfigured client ' +
      'replaying one stale credential will NOT lock out, which removes the main false-positive objection ' +
      'to treating a lockout as attack evidence. It gets its OWN outcome rather than being folded into ' +
      'PASSWORD_REJECTED: a lockout is a refusal, not a credential that was validated and found wrong, and ' +
      'calling it an invalid-credential attempt would assert something that did not happen on that event.',
  },
];

/** Description-text branches with no production evidence behind them. */
export const UNVALIDATED_FAILURE_REASON_MEANINGS: readonly FailureReasonMeaning[] = FAILURE_REASON_MEANINGS
  .filter(pattern => pattern.verification.state === 'NO_PRODUCTION_EVIDENCE')
  .map(pattern => pattern.meaning);

/** Lowercase, curly apostrophes folded, whitespace collapsed. Never fuzzy. */
export function normalizeFailureReason(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The single meaning a description text establishes, or null when it
 * establishes none or more than one. Returning null on multiple matches is
 * deliberate: choosing between them would be the guess this closed set exists
 * to avoid.
 */
export function failureReasonMeaning(
  value: unknown,
  allowed?: readonly FailureReasonMeaning[],
): FailureReasonPattern | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  const text = normalizeFailureReason(value);
  const candidates = allowed
    ? FAILURE_REASON_MEANINGS.filter(pattern => allowed.includes(pattern.meaning))
    : FAILURE_REASON_MEANINGS;
  const matched = candidates.filter(pattern => pattern.fragments.some(fragment => text.includes(fragment)));
  return matched.length === 1 ? matched[0]! : null;
}

/**
 * Audit-path reason names, matched exactly (case-insensitively, trimmed).
 *
 * THE TWO FEEDS INVERT ON WHICH FIELD IS TRUSTWORTHY, and treating them
 * symmetrically is wrong. On Graph the result code is a clean number on 100%
 * of rows and the description is free prose. On the AUDIT feed the code is the
 * unreliable half and the reason NAME is the stable identifier.
 *
 * GROUNDS, all from reading the collector rather than from volumes. An earlier
 * version of this comment cited row counts across two tenants; those were
 * computed from `raw.status.failureReason`, a field HawkView synthesizes with
 * `?? record.Operation` as its final arm, so they described our own fallback
 * expression rather than Microsoft's data and have been withdrawn. What stands:
 *
 *  1. The audit outcome is a UNION OF TWO VOCABULARIES with no discriminator.
 *     `reportedAuthenticationErrorCode()` pools `LoginStatus` and `ErrorCode`
 *     into one numeric space, and those are not the same kind of value — a
 *     LoginStatus flag and an AADSTS error code cannot share a field and stay
 *     readable. Keying on the name sidesteps that entirely.
 *  2. On this feed the NAME disambiguates what the code cannot: `IdsLocked` is
 *     Microsoft's own name for the smart-lockout meaning of 50053
 *     specifically, so the three-way ambiguity that requires text parsing on
 *     Graph does not arise here at all.
 *  3. The outcome can appear in at least four places — `LoginStatus`,
 *     `ErrorCode`, and extended properties of either name, case-insensitively.
 *     A reader that checks fewer than all of them disagrees with the collector
 *     about where the outcome lives.
 *
 * These names are Microsoft error identifiers rather than prose, which is why
 * exact matching is appropriate here and substring matching is appropriate for
 * Graph's descriptions. A name absent from this table is
 * UNRECOGNIZED_REASON_NAME, which costs stated coverage and blocks nothing.
 */
export interface AuditReasonEntry {
  readonly name: string;
  readonly disposition: CodeDisposition;
  readonly note?: string;
}

export const AUDIT_REASON_NAMES: readonly AuditReasonEntry[] = [
  {
    name: 'InvalidUserNameOrPassword',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' },
    note:
      'Microsoft’s documented name for 50126. VOLUMES WITHDRAWN: the row counts previously cited here ' +
      'were computed from a HawkView-synthesized field and described our own fallback expression rather ' +
      'than Microsoft’s data. The grounds for reading this feed by name are in the comment above and rest ' +
      'on the collector source, not on counts.',
  },
  {
    name: 'IdsLocked',
    disposition: { kind: 'APPLIES', outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES' },
    note:
      'Microsoft’s documented name for the smart-lockout meaning of 50053 specifically. A useful ' +
      'consequence of keying on the name: on this feed the name disambiguates what the code cannot, so ' +
      'the three-way ambiguity that needs text parsing on Graph does not arise here.',
  },
  {
    name: 'UserStrongAuthClientAuthNRequiredInterrupt',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' },
    note: 'Microsoft’s documented name for 50076. Post-password challenge issued.',
  },
  {
    name: 'UnclassifiedAuthenticationError',
    disposition: { kind: 'UNKNOWN', observation: 'PROVIDER_DECLARED_UNCLASSIFIED' },
    note:
      'Microsoft’s own name says it is unclassified, so there is nothing to read — an honest coverage ' +
      'cost rather than a gap in this table. Share-of-traffic figures previously noted here were computed ' +
      'from a synthesized field and are withdrawn.',
  },
  // Recognised names with no documented basis for excluding them. Each is a
  // singleton in observed data, and each is held rather than guessed at.
  { name: 'UserUnauthorized', disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' } },
  { name: 'DelegationDoesNotExist', disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' } },
  { name: 'InvalidReplyTo', disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' } },
  {
    name: 'MisconfiguredApplicationWithGraphErrorMessage',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    name: 'PasswordResetRegistrationRequiredInterrupt',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'Probably a post-password registration interrupt by analogy with 50072/50079, which would make it ' +
      'APPLIES. Not claimed: asserting a credential outcome from an analogy is the riskier direction, and ' +
      'a wrong APPLIES asserts something about a password that may not have happened.',
  },
];

const BY_AUDIT_REASON: ReadonlyMap<string, AuditReasonEntry> = new Map(
  AUDIT_REASON_NAMES.map(entry => [entry.name.toLowerCase(), entry]),
);

export function auditReasonEntry(name: string): AuditReasonEntry | undefined {
  return BY_AUDIT_REASON.get(name.trim().toLowerCase());
}

/**
 * Reason names seen in production and deliberately NOT mapped, with why.
 * Recorded so the gap is a decision on the record rather than an oversight.
 */
export const AUDIT_REASON_NAMES_OBSERVED_UNMAPPED: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'UserLoggedIn',
    why:
      'CONFIRMED AN ARTEFACT, not a provider value. It appears as a "reason" only in the synthesized ' +
      '`raw.status.failureReason`, whose final arm is `?? record.Operation` — so every audit record with ' +
      'no logon error of any kind contributes its own Operation name there. It is not a Microsoft reason ' +
      'value at all, and nothing should ever map it. This layer reads the original record, where it does ' +
      'not appear; the guard in classifyAuditRecord exists for any reader that is pointed at the ' +
      'projected field instead. Volumes previously cited here came from that same synthesized field and ' +
      'are withdrawn.',
  },
];

export type ShapePredicateVerification
  = | {
      readonly state: 'PRODUCTION_VERIFIED';
      readonly evidence: string;
      /** The cohort that must NOT match, and what it actually returned. */
      readonly control: string;
    }
  | {
      /**
       * The positive cohort was confirmed, but the control cohort does not
       * exist in observed data, so the negative path is UNTESTED against
       * production and must not be recorded as passing. Treated as
       * not-verified for exclusion purposes.
       */
      readonly state: 'CONTROL_COHORT_UNAVAILABLE';
      readonly evidence: string;
      readonly why: string;
    }
  | {
      readonly state: 'PENDING_DISTRIBUTION_CHECK';
      readonly cohort: string;
      readonly controlCohort: string;
    }
  | { readonly state: 'DISPROVED'; readonly evidence: string };

export interface ShapePredicate {
  readonly id: string;
  /** Payload paths the predicate reads. */
  readonly reads: readonly string[];
  readonly claim: string;
  readonly verification: ShapePredicateVerification;
}

/**
 * Every payload-shape predicate this layer knows about, including the ones
 * that must never be used again. The disproved entries are kept deliberately:
 * they are the record of claims that were plausible, reviewed, and false about
 * what they meant, and `normalize.test.ts` asserts behaviourally that
 * classification is unchanged by the fields they read.
 */
export const SHAPE_PREDICATES: readonly ShapePredicate[] = [
  {
    id: 'graph.error-code-is-number',
    reads: ['raw.status.errorCode'],
    claim: 'On the Graph feed, status.errorCode is a JSON number.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence: 'number on 100% of 2,635 Graph rows: zero string, zero null, zero absent.',
      control:
        'Rows where `status` itself is absent, which would risk being misread as 0: zero such rows exist, ' +
        'so nothing can be misread as a success. A numeric requirement is safe.',
    },
  },
  {
    id: 'graph.success-description-other',
    reads: ['raw.status.errorCode', 'raw.status.failureReason'],
    claim: 'On the GRAPH feed, errorCode 0 carries the literal description "Other." and that is a genuine success.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence: 'On the Graph path, errorCode 0 carries "Other." on 100% of rows: no absent, no null, no empty string.',
      control:
        'The empty-description successes observed earlier are all AUDIT rows, a different feed. The two ' +
        'paths are verified separately and never mixed; the predecessor’s emptiness test treated ' +
        '"Other." as a failure reason and demoted real Graph successes to UNKNOWN.',
    },
  },
  {
    id: 'audit.success-description-empty',
    reads: ['managementActivityRecord.LogonError'],
    claim: 'On the AUDIT feed, a success carries an empty or absent logon error.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence: 'The empty/absent-description successes measured in production are all audit-path rows.',
      control: 'Graph-path successes carry "Other." instead, so this predicate is never applied to Graph rows.',
    },
  },
  {
    id: 'audit.subject-normalized-upn',
    reads: ['managementActivityRecord.UserId'],
    claim:
      'On the AUDIT feed, managementActivityRecord.UserId is a UPN resolving to exactly one non-deleted ' +
      'directory user by exact normalized match.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence:
        'PROVENANCE CHECKED, and this is the audit figure that survives: it was computed from ' +
        'lower(raw->\'managementActivityRecord\'->>\'UserId\') — Microsoft’s own field in Microsoft’s own ' +
        'record — unlike the reason|code counts that were withdrawn for being computed from a field we ' +
        'synthesize. ' +
        'Holding as one tenant backfills: UPN resolution 97.0% at 1,773 rows against the other tenant’s ' +
        '97.1%, essentially unmoved as volume grew from 1,385 rows. Two-tenant agreement surviving contact ' +
        'with more data is the test that matters. ' +
        'Audit rows resolving against directory_users, deleted excluded: 96.8% / 97.1% / 77.8% by UPN ' +
        'across the three fallback-path tenants, versus 15.2% / 0.0% / 0.0% by GUID. Re-measured across ' +
        'two INDEPENDENT tenants with separate MSPs and separate directories — 97.2% vs 12.0% and 97.1% ' +
        'vs 0.0% — agreeing within 0.1 percentage points. The UPN-in-record / GUID-in-column split holds ' +
        'in all three audit tenants. Previously labelled thin evidence; it is now the best-corroborated ' +
        'finding in the workstream.',
      control:
        'The hazard is AMBIGUITY, not naming: two directory users normalizing to one UPN. Handled by ' +
        'requiring EXACTLY ONE non-deleted match, with zero and multiple both unprocessable, and by ' +
        'recording the binding method on the event so a UPN binding is visibly weaker than a GUID one. ' +
        'A UPN can be reassigned after a user is deleted, so a historical event can bind to the wrong ' +
        'person; that residual risk is disclosed rather than hidden.',
    },
  },
  {
    id: 'graph.failure-reason-fragments',
    reads: ['raw.status.failureReason', 'managementActivityRecord.LogonError'],
    claim:
      'The literal fragments in FAILURE_REASON_MEANINGS are the text Microsoft actually emits for code ' +
      '50053, so a matching row is correctly resolved to that meaning.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence:
        'The highest-volume predicate in the layer: code 50053 is 1,479 of 2,645 Graph rows, 55.9% of ' +
        'everything collected. Both literals were measured with terminal characters checked explicitly, ' +
        'and the closed set accounts for 100.0% of observed 50053 rows — 921 malicious-IP, 558 lockout, ' +
        'ZERO matching neither.',
      control:
        'Each literal matches exactly ONE fragment set and not the other, and neither reaches the ' +
        'risk-verdict fragment — asserted against the byte-exact strings in normalize.test.ts. THE LIMIT ' +
        'OF THE CLAIM: 100% is true of OBSERVED data, one tenant, one locale, six weeks. It does NOT ' +
        'establish that Microsoft emits no third string, and we know it does, because the documented ' +
        'high-confidence-risk variant appears zero times here. The honest claim is "these two literals ' +
        'account for every 50053 row we have ever collected", never "these are the only values 50053 ' +
        'takes" — and unmatched-text-to-UNKNOWN is what makes that distinction safe rather than merely ' +
        'stated.',
    },
  },
  {
    id: 'graph.subject-directory-object-id',
    reads: ['raw.userId'],
    claim: 'On the Graph feed, raw.userId is a directory object id matching exactly one non-deleted directory user.',
    verification: {
      state: 'CONTROL_COHORT_UNAVAILABLE',
      evidence: 'Graph rows bind 100% on both Graph tenants, with zero ambiguous matches.',
      why:
        'The control cohort is EMPTY: zero observed rows carry a well-formed GUID absent from the ' +
        'directory. Guests, deleted users and cross-tenant sign-ins do not appear in observed data, so ' +
        'the unprocessable path cannot be validated against production and is NOT recorded as passing. ' +
        'It is covered by synthetic fixtures instead, which is weaker, and is stated as such.',
    },
  },
  {
    id: 'graph.is-interactive-false',
    reads: ['raw.isInteractive'],
    claim: 'DISPROVED AS INERT. isInteractive === false marks a non-interactive sign-in.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'isInteractive is `true` on 100% of 2,635 Graph rows. The 50126 control cohort passes — all ' +
        '107 interactive password failures are correctly marked interactive — but a predicate true on ' +
        'every row discriminates nothing, because there is nothing for it to exclude. Same inert shape as ' +
        'signInEventTypes, different cause. ROOT CAUSE, confirmed in the collector source: the sign-in ' +
        'request in tenant-sync.service.ts filters on createdDateTime only and applies no ' +
        'signInEventTypes filter, so Graph returns its default set, which is interactive user sign-ins. ' +
        'That is a collection-scope gap, not a classification one.',
    },
  },
  {
    id: 'audit.result-status',
    reads: ['managementActivityRecord.ResultStatus'],
    claim: 'DISPROVED. ResultStatus "Succeeded" on an STS logon event means the logon succeeded.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'For STS logon events a ResultStatus of "Succeeded" means HTTP success, NOT logon success — it ' +
        'describes audit processing. Key off ErrorCode and Operation, never ResultStatus. This one fails ' +
        'silently in the direction of calling failed sign-ins successful.',
    },
  },
  {
    id: 'signin.user-id-column',
    reads: ['sign_in_logs.user_id'],
    claim: 'DISPROVED. The user_id COLUMN identifies the signing-in user.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'GUID-shaped on essentially every row, matching no directory user on any row, and MORE granular ' +
        'than the real user: one tenant carries 6 distinct column GUIDs against 2 distinct real users ' +
        'across 950 rows. It appears synthesized rather than sourced. Subjects bind from the raw payload.',
    },
  },
  {
    id: 'graph.sign-in-event-types',
    reads: ['raw.signInEventTypes'],
    claim: 'DISPROVED. signInEventTypes containing servicePrincipal or managedIdentity marks a non-human actor.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'Absent from every row in the dataset, so a predicate on it matches nothing and would have shipped ' +
        'as a verified fix that changed nothing at all. Storage is not the cause: raw is persisted as the ' +
        'whole provider row, and redaction replaces values without dropping keys.',
    },
  },
  {
    id: 'graph.service-principal-id',
    reads: ['raw.servicePrincipalId', 'raw.servicePrincipalName'],
    claim: 'DISPROVED. A non-empty servicePrincipalId marks a non-human actor.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'Non-empty on 100% of Graph rows INCLUDING ordinary human sign-ins that resolve to real directory ' +
        'users, and servicePrincipalName always empty. Neither discriminates anything. It was confirmed ' +
        'present on 60/60 rows of the tenant someone wanted to exclude; the query nobody ran was whether ' +
        'it was also present on humans, and it was, on all of them. The control is not optional and it is ' +
        'not the same query.',
    },
  },
  {
    id: 'graph.risk-detail',
    reads: ['raw.riskDetail', 'raw.conditionalAccessStatus', 'raw.appliedConditionalAccessPolicies'],
    claim:
      'raw.riskDetail carries Microsoft’s own verdict about a sign-in, so a row bearing one belongs in ' +
      'the Microsoft channel rather than in HawkView’s findings — and the verdict KIND (risky versus ' +
      'safe) can be read from its value.',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort:
        'Measured on one tenant: 55 rows carry a riskDetail alongside conditionalAccessStatus success and ' +
        'grant controls ["Mfa"] — 54 userPassedMFADrivenByRiskBasedPolicy and 1 aiConfirmedSigninSafe. ' +
        'Those 55 rows currently classify as ordinary successes (errorCode 0, description "Other.") and ' +
        'therefore sit in the applies list, so the channel mixing this predicate would fix is live rather than ' +
        'hypothetical.',
      controlCohort:
        'MISSING, and it is the whole question: what does riskDetail contain on rows that are NOT ' +
        'risk-driven? Documentation says it is P2-only and otherwise hidden, so plausible values include ' +
        '"none", "hidden", or absent — but reading a verdict out of an unconfirmed field would remove 55 ' +
        'real successes from evaluation if the field means something else. Needed: every Graph row ' +
        'bucketed by riskDetail value, with the ordinary-human-success rows as the cohort that must NOT ' +
        'carry a verdict-shaped value. Until then this predicate has NO effect and ' +
        'MICROSOFT_SAFETY_VERDICT is unreachable.',
    },
  },
  {
    id: 'audit.result-code-vocabulary',
    reads: ['managementActivityRecord.LoginStatus', 'managementActivityRecord.ErrorCode'],
    claim:
      'The audit result code is a single vocabulary, so pooling LoginStatus and ErrorCode into one ' +
      'numeric space and requiring them to agree is a sound reading.',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort:
        'SUSPECTED FALSE, and this is the ground for reading the feed by name instead. If LoginStatus is ' +
        'a success/failure flag while ErrorCode carries AADSTS codes, then the two are different ' +
        'vocabularies sharing one field, a 1 and a 50126 are not comparable numbers, and requiring them ' +
        'to agree numerically would discard rows that agree semantically (LoginStatus 1 and ErrorCode ' +
        '50126 both mean failure). Nothing is built on the hypothesis: this layer keys on the reason name ' +
        'and uses the code only as corroboration, and disagreement routes to UNKNOWN, which is the ' +
        'conservative direction either way.',
      controlCohort:
        'Needed: LoginStatus values paired with ErrorCode values on the same records. Rows where ONLY ' +
        'LoginStatus is present must be distinguishable from rows where only ErrorCode is. If the two ' +
        'fields draw from disjoint value ranges, that settles it. NOTE FOR STORAGE, separate from ' +
        'classification: two vocabularies in one column is a schema defect whose fix is to stop merging ' +
        'them, not to read them more cleverly.',
    },
  },
  {
    id: 'graph.authentication-details',
    reads: ['raw.authenticationDetails', 'raw.authenticationRequirement'],
    claim:
      'raw.authenticationDetails carries per-step outcomes, so "the password step succeeded and the ' +
      'second-factor step did not" is readable WITHIN a single event rather than inferred from the ' +
      'presence of an interrupt error code.',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort:
        'HYPOTHESIS, nothing built on it. The sign-in request issues no $select, so Graph returns the ' +
        'full default signIn payload and the collector stores it whole — which should include ' +
        'authenticationDetails. If it is populated, the post-password interrupt detector stops depending ' +
        'on sparse error codes and would also work on successful-looking rows where no interrupt code was ' +
        'ever emitted. REDACTION IS NOT THE OBSTACLE: redactSensitiveValues matches KEY names against ' +
        '/password|secret|token|authorization|credential|private.?key|client.?secret|assertion|certificate/i, ' +
        'and none of the documented keys inside authenticationDetails matches, so the array survives ' +
        'storage intact. (Sibling fields DO get redacted — tokenIssuerName, tokenIssuerType and ' +
        'incomingTokenType all contain "token" — which is a separate fact about what we retain.)',
      controlCohort:
        'Ordinary SINGLE-FACTOR successes must look DIFFERENT from multi-factor ones. What would kill the ' +
        'hypothesis: the array absent or empty on rows we know required MFA, which Microsoft documents as ' +
        'possible. No row has been looked at, so this is unverified in the strongest sense and has no ' +
        'effect on classification.',
    },
  },
  {
    id: 'graph.application-actor',
    reads: [],
    claim:
      'RESERVED AND CURRENTLY UNREACHABLE. No confirmed field distinguishes an application actor from a ' +
      'user missing from the collected directory, so app-only sign-ins land as unprocessable subject ' +
      'failures — counted and visible, but understating coverage. APPLICATION_ACTOR reports zero.',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort: 'Unassigned: no candidate discriminator has survived a control cohort yet.',
      controlCohort: 'Ordinary human sign-ins, which must not match any candidate. servicePrincipalId is not one.',
    },
  },
];

/** Payload paths no classification path may read. Asserted behaviourally in tests. */
export const DISPROVED_PREDICATE_PATHS: readonly string[] = SHAPE_PREDICATES
  .filter(entry => entry.verification.state === 'DISPROVED')
  .flatMap(entry => entry.reads);

function predicate(id: string): ShapePredicate {
  const found = SHAPE_PREDICATES.find(entry => entry.id === id);
  if (!found) throw new Error(`RISKY_USERS_NORMALIZATION_UNKNOWN_PREDICATE:${id}`);
  return found;
}

/**
 * Whether a shape predicate is allowed to place an event outside evaluation.
 * Only a predicate confirmed against a real distribution with a PASSING
 * control cohort may. `CONTROL_COHORT_UNAVAILABLE` is not good enough, which
 * is the point of having it as a distinct state.
 */
export function mayExclude(id: string): boolean {
  const { verification } = predicate(id);
  if (verification.state === 'DISPROVED') {
    throw new Error(`RISKY_USERS_NORMALIZATION_DISPROVED_PREDICATE:${id}`);
  }
  return verification.state === 'PRODUCTION_VERIFIED';
}
