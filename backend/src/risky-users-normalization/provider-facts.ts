import type { EventOutcome, MicrosoftVerdict, NormalizationSource, OutcomeReachability } from './contract.js';
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

export interface ResultCodeEntry extends CarriesVerdict {
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
    verdict: 'RISK',
    microsoftName: 'ProofUpBlockedDueToRisk',
    claimClass: 'ATTACK_AND_CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    note:
      'Cannot configure MFA due to suspicious activity. NO PRODUCTION EVIDENCE: zero rows, all ' +
      'tenants, all history, so it is exercised by synthetic fixture only and kept because the name ' +
      'ProofUpBlockedDueToRisk is reasonable anticipation from documentation. ' +
      'THE INCONSISTENCY THAT WAS RECORDED HERE IS RESOLVED. The objection was that riskDetail is a ' +
      'SEPARATE field, so an observation is readable there without the verdict, whereas this code IS ' +
      'both statements at once and cannot be split. The answer is that it can: "MFA configuration ' +
      'was blocked for this subject at this time" is the observation, and "due to risk" is the ' +
      'judgement, which travels as a verdict. Nothing about the observation needs Microsoft reasoning ' +
      'to be usable by a rule. The same reading returned the 50053 risk texts, roughly 921 rows for ' +
      'the malicious-IP text alone.',
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
      'to a Microsoft RISK verdict, which travels beside the classification rather than replacing it. ' +
      'Unmatched text keeps the control-block default, which is the confident ' +
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
      'VOLUME MEASURED AT ONE ROW, so the concern that a non-canonical citation might be doing a lot of ' +
      'exclusion work is closed: it excludes exactly one event. Whatever the volume becomes, it is a ' +
      'property of the tenant sign-in-frequency setting rather than of any attacker.',
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

export interface FailureReasonPattern extends CarriesVerdict {
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
  // WHY THESE CLASSIFY AS OBSERVATIONS WHILE CARRYING A VERDICT.
  //
  // The text is one sentence but it is not one fact. "Blocked by built-in
  // protections due to high confidence of risk" decomposes into:
  //   - a sign-in attempt occurred, by this subject, at this time, from this
  //     address                                              OBSERVATION
  //   - it did not succeed                                    OBSERVATION
  //   - it was stopped by a control rather than by a wrong
  //     credential                                           OBSERVATION
  //   - the control fired because Microsoft assessed the
  //     source as risky                                       JUDGEMENT
  //
  // BLOCKED_BY_CONTROL names the first three and no judgement. The fourth
  // travels as a MicrosoftVerdict, which never appears on an event.
  //
  // THE TEST THAT SETTLES IT: would a HawkView finding over these rows be
  // derivable WITHOUT Microsoft's judgement? Yes — repeated failed attempts
  // from one source is a pattern in the attempt data itself, so Microsoft's
  // reason corroborates a finding rather than being its source. If it were
  // not independently derivable, these would belong out of scope.
  //
  // And the split is mechanically available: code 50053 alone is ambiguous
  // across three meanings, so the text is already a separate string doing
  // separate work. The outcome is classified from it and the text itself is
  // never handed on — NormalizedEvent carries no failureReason.
  {
    meaning: 'SUSPICIOUS_ACTIVITY_BLOCK',
    verdict: 'RISK',
    fragments: ['suspicious activity'],
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
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
    verdict: 'RISK',
    // ONE fragment, and the most distinctive one available. This is the only
    // branch here that moves an event OUT of `applies`, so a fragment broad
    // enough to catch a neighbouring meaning would divert real evidence into
    // the Microsoft channel. 'built-in protections' was dropped for that
    // reason: it is not distinctive enough to carry that consequence.
    fragments: ['high confidence of risk'],
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    verification: {
      state: 'NO_PRODUCTION_EVIDENCE',
      why:
        'Zero occurrences. Across all 1,493 rows of code 50053 in all history and all tenants (as of ' +
        '2026-09-10T16:36Z) there are ' +
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
    verdict: 'RISK',
    fragments: ['malicious activity'],
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    verification: {
      state: 'OBSERVED_IN_PRODUCTION',
      evidence:
        'One of exactly two description values observed on code 50053, at 932 of 1,493 rows (62.4%) as of ' +
        '2026-09-10T16:36Z, in a ' +
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
        'The other of exactly two description values observed on code 50053, at 561 of 1,493 rows (37.6%) ' +
        'as of 2026-09-10T16:36Z ' +
        'in a single-instant query. Literal, measured with terminal characters checked: "The account is ' +
        'locked, you\'ve tried to sign in too many times with an incorrect user ID or password." — 100 ' +
        'characters, TRAILING PERIOD PRESENT, and the apostrophe is ASCII 0x27 rather than a Unicode right ' +
        'single quote. The two literals differ in terminal punctuation and that difference survives a paste ' +
        'and fails a comparison, which is why this matcher is substring-based on a distinctive fragment ' +
        'rather than an equality test. It carries unique detection ' +
        'weight: for 94.8% of lockout rows there is NO 50126 for the same user within ±15 minutes ' +
        '(DENOMINATOR NOT RECORDED — see the caveat below; it is not reconstructed from today’s 561, ' +
        'because the figure was measured against whatever the lockout count was then), so ' +
        'Microsoft emits the lockout without the individual attempts alongside it and at the moment of ' +
        'lockout this is the ONLY signal present. A 50126-only detector eventually surfaces the affected ' +
        'users — 100% of them appear in 50126 rows at some point — but misses the lockout events, and ' +
        'misses them when they happen. CAVEAT: one tenant, at most four users, one locale, six weeks, and ' +
        '1,493 blocks against FOUR accounts is not obviously normal traffic, so the 94.8% informs the ' +
        'mapping and does not settle the general case. ' +
        'AND ITS DENOMINATOR WAS NOT RECORDED, which is the sharper limit: 94.8% of an unstated ' +
        'number of lockout rows cannot be checked, cannot be compared against a later measurement, and ' +
        'is the most load-bearing bare percentage in this file. It is kept because the mapping it ' +
        'supports — a lockout is its own outcome rather than a rejected password — rests on the ' +
        'DIRECTION of the finding rather than its magnitude, and the direction is not in doubt. Restate ' +
        'as lockouts-without-a-nearby-50126 over lockouts at the next measurement.',
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

/**
 * Description-text branches with no production evidence behind them.
 *
 * STRONGER THAN IT LOOKS, because the denominator MOVED and the claim held.
 * The 14 rows that arrived between two measurements split into the same two
 * literals and no third text appeared, so "exactly two values" survived a
 * fresh sample rather than only a fixed one. A zero across a growing
 * denominator is better evidence than the same zero across a frozen one.
 */
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
  /**
   * The Graph result code that carries the SAME Microsoft meaning, when there
   * is one.
   *
   * This exists because the two tables encode the same provider semantics in
   * two vocabularies and were built weeks apart, so they can drift without
   * anything failing. They HAD drifted: InvalidReplyTo was held here while
   * 50011 — the same meaning, same provider text — was out of scope with a
   * citation on the Graph side. A test now requires the dispositions to match
   * or the divergence to be stated, so a future edit to one table cannot
   * silently disagree with the other.
   */
  readonly graphCode?: number;
  /** Required when the linked Graph code's disposition differs, and why. */
  readonly divergenceReason?: string;
  readonly note?: string;
}

/** Microsoft's judgement carried by a result code or description, if any. */
export interface CarriesVerdict {
  readonly verdict?: MicrosoftVerdict;
}

export const AUDIT_REASON_NAMES: readonly AuditReasonEntry[] = [
  {
    name: 'InvalidUserNameOrPassword',
    graphCode: 50126,
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' },
    note:
      'Microsoft’s documented name for 50126. VOLUMES WITHDRAWN: the row counts previously cited here ' +
      'were computed from a HawkView-synthesized field and described our own fallback expression rather ' +
      'than Microsoft’s data. The grounds for reading this feed by name are in the comment above and rest ' +
      'on the collector source, not on counts.',
  },
  {
    name: 'IdsLocked',
    graphCode: 50053,
    divergenceReason:
      'Graph maps 50053 to UNKNOWN because the code carries three meanings resolved only by description ' +
      'text. On this feed the NAME is the lockout meaning, so the ambiguity does not arise — the whole ' +
      'reason this feed is keyed on names. 715 rows, measured from managementActivityRecord.LogonError.',
    disposition: { kind: 'APPLIES', outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES' },
    note:
      'Microsoft’s documented name for the smart-lockout meaning of 50053 specifically. A useful ' +
      'consequence of keying on the name: on this feed the name disambiguates what the code cannot, so ' +
      'the three-way ambiguity that needs text parsing on Graph does not arise here.',
  },
  {
    name: 'UserStrongAuthClientAuthNRequiredInterrupt',
    graphCode: 50076,
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' },
    note: 'Microsoft’s documented name for 50076. Post-password challenge issued.',
  },
  {
    name: 'UserStrongAuthEnrollmentRequiredInterrupt',
    graphCode: 50072,
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' },
    note:
      'The audit-path name for 50072, which is mapped identically on Graph. It was MISSING from this ' +
      'table until the interrupt family was counted in both vocabularies, so its rows were landing in ' +
      'UNRECOGNIZED_REASON_NAME — a gap found only because someone measured the same family twice, once ' +
      'per feed.',
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
  {
    name: 'UserUnauthorized',
    graphCode: 50020,
    divergenceReason:
      'Its Graph counterpart is not in RESULT_CODES at all — 50020 is recorded in ' +
      'UNREACHABLE_BY_SUBJECT_RESOLUTION, because it describes an identity from another provider that by ' +
      'definition is not in the tenant. The same is true here: the UPN of an out-of-tenant identity ' +
      'cannot resolve, so this entry is held and is effectively unreachable on both feeds.',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    name: 'DelegationDoesNotExist',
    graphCode: 65001,
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note: 'Matches 65001 on the Graph side, including the consent-grant pointer. 9 rows.',
  },
  {
    name: 'InvalidReplyTo',
    graphCode: 50011,
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'APPLICATION_CONFIGURATION_ERROR' },
    note:
      'ALIGNED WITH 50011, which it had drifted from: the same Microsoft meaning was out of scope with a ' +
      'provider citation on the Graph side while being held here. Found by cross-checking the two tables ' +
      'against a measured list of audit reason names, not by any test failing.',
  },
  {
    name: 'SsoArtifactRevoked',
    graphCode: 50133,
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'SESSION_INVALIDATED_BY_REMEDIATION' },
    note: 'Was MISSING from this table while 50133 was mapped on the Graph side. Same drift, same cause.',
  },
  {
    name: 'MisconfiguredApplicationWithGraphErrorMessage',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    name: 'SsoUserAccountNotFoundInResourceTenant',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'ADDED FROM A MEASURED INVENTORY, 1 row, and it was landing in UNRECOGNIZED_REASON_NAME before ' +
      'that. Found by diffing this table against a measured list of LogonError values rather than by ' +
      'any test — the third entry this table has gained that way, which is why the diff is a standing ' +
      'exchange rather than a one-off. ' +
      'HELD RATHER THAN MAPPED, and the temptation is worth naming: the name reads like an ' +
      'out-of-tenant identity, which would make it a sibling of UserUnauthorized and effectively ' +
      'unreachable behind subject resolution. That is INFERENCE FROM A NAME, not a citation, and ' +
      'reading a disposition off a plausible-sounding name is the specific mistake this table exists ' +
      'to prevent. If the inference is right the entry is unreachable and mapping it changes nothing; ' +
      'if it is wrong, mapping it asserts something false. Held either way.',
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
 *
 * EMPTY, and that is a live claim rather than a placeholder: every name in the
 * measured LogonError inventory is now in AUDIT_REASON_NAMES. It refills the
 * moment a measurement turns up a name this table lacks.
 */
export const AUDIT_REASON_NAMES_OBSERVED_UNMAPPED: readonly { readonly name: string; readonly why: string }[] = [];

/**
 * Names that are NOT provider reason values at all, and must never be mapped.
 *
 * A SEPARATE list from the one above, because that one's name asserts these
 * were OBSERVED as reason names, and they were not. UserLoggedIn sat there
 * with a `why` that correctly said "artefact, never map it" while its
 * membership said "we saw this as a reason and chose not to map it" — a
 * registry entry right about the outcome and wrong about the reason, which is
 * a category every check here was blind to, since all of them look for wrong
 * outcomes. Surfaced by a measurement of the real field: LogonError is
 * ABSENT on all 1,412 UserLoggedIn rows, so the name never appears there.
 */
export const AUDIT_REASON_NAMES_NEVER_PROVIDER_VALUES: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'UserLoggedIn',
    why:
      'An OPERATION name, not a reason. It appears as a "reason" only in the synthesized ' +
      '`raw.status.failureReason`, whose final arm is `?? record.Operation` — so every audit record with ' +
      'no logon error of any kind contributes its own Operation name there. Measured confirmation: ' +
      'managementActivityRecord.LogonError is ABSENT on all 1,412 UserLoggedIn rows, so it is not a ' +
      'Microsoft reason value and nothing should ever map it. This layer reads the original record, ' +
      'where it does not appear; the guard in classifyAuditRecord exists for any reader pointed at the ' +
      'projected field instead. Volumes previously cited came from that same synthesized field and ' +
      'are withdrawn.',
  },
];

// ===========================================================================
// WHICH OUTCOMES EACH FEED CAN SUPPLY.
//
// Built for the evaluation core's feed-capability check, which reports a rule
// INAPPLICABLE rather than RAN when the feed cannot supply an outcome the
// rule's logic reads. That check needs an answer this layer is the only one
// holding, and it is deliberately NOT derived from the tables at runtime.
//
// WHY EXPLICIT RATHER THAN DERIVED. A derived set absorbs new members
// silently: add a mapping for a code and the feed quietly gains a capability,
// which is exactly how isPostPasswordInterrupt would have enrolled
// CREDENTIAL_CONFIRMED_VALID and lent it a claim no control had established.
// So the table is written out, and a test cross-checks it against
// RESULT_CODES, FAILURE_REASON_MEANINGS and AUDIT_REASON_NAMES. A new mapping
// is then a test failure that says "decide what this does to feed capability"
// rather than a silent change of answer.
//
// WHAT THE MEASUREMENTS SAY, and the two findings in them:
//
// (1) The GRAPH feed has NEVER OBSERVED A POST-PASSWORD INTERRUPT. 50076,
//     50072 and 50079 are zero rows across all tenants and all history, while
//     the audit feed carries SIXTEEN, from TWO reason names:
//     UserStrongAuthClientAuthNRequiredInterrupt (13) and
//     UserStrongAuthEnrollmentRequiredInterrupt (3).
//
//     NOT the 4 PasswordResetRegistrationRequiredInterrupt rows. Those are
//     NOT_YET_CITED — held because asserting a credential outcome from an
//     analogy to 50072/50079 is the riskier direction — so they produce no
//     outcome and cannot be part of a claim about what this feed supplies.
//     CORRECTED HERE: an earlier version of this comment listed all three
//     names together and a summary of it reached two other sessions as
//     "13 + 3 + 4 = 16", which mis-sums AND silently re-includes rows this
//     table deliberately declines to act on. The README addendum written
//     when the family was first counted had it right — 16 cited, the 4
//     excluded and why — so this was a later summary contradicting an
//     earlier correct statement, which is the more dangerous direction: the
//     summary travels and the original does not.
//
//     "Password accepted, sign-in did not complete" is the basis of the
//     highest-value detector available without Entra ID P2 — and its
//     evidence is on the feed we treat as the fallback, not the one we treat
//     as primary. That inverts the assumption that Graph is strictly the
//     better source.
//
// (2) The audit feed's successes DO NOT COME FROM THE REASON-NAME TABLE.
//     They come from Operation (UserLoggedIn, 1,412 rows), where no LogonError
//     exists at all. Anything deriving audit capability from AUDIT_REASON_NAMES
//     alone concludes the feed has no successes and declares every
//     failures-then-success rule inapplicable there — which is the original
//     inert-detector bug re-created by the machinery built to detect it. The
//     Operation path is why PASSWORD_ACCEPTED_COMPLETED is present below.
// ===========================================================================

export interface FeedOutcomeCapability {
  readonly source: NormalizationSource;
  readonly outcomes: Readonly<Record<EventOutcome, OutcomeReachability>>;
}

export const FEED_CAPABILITIES: readonly FeedOutcomeCapability[] = [
  {
    source: 'GRAPH_SIGN_INS',
    outcomes: {
      // 50126, 107 rows.
      PASSWORD_REJECTED: 'MAPPED_AND_OBSERVED',
      // Code 0, 1,010 rows.
      PASSWORD_ACCEPTED_COMPLETED: 'MAPPED_AND_OBSERVED',
      // 53003 (5) and 53000 (2), plus 50053's malicious-IP text (932).
      BLOCKED_BY_CONTROL: 'MAPPED_AND_OBSERVED',
      // 50053's smart-lockout text. The CODE is 1,493 rows; the outcome is
      // reached only through the text, which is why this is not derivable
      // from a code's own disposition.
      LOCKED_OUT_AFTER_REPEATED_FAILURES: 'MAPPED_AND_OBSERVED',
      // 50074, 3 rows. The only observed member of the interrupt family here.
      PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED: 'MAPPED_AND_OBSERVED',
      // FINDING (1). Mapped from documentation, zero rows ever.
      PASSWORD_ACCEPTED_CHALLENGE_ISSUED: 'MAPPED_NOT_OBSERVED',
      PASSWORD_ACCEPTED_REGISTRATION_REQUIRED: 'MAPPED_NOT_OBSERVED',
      // 50057 and 50055/50144: mapped, never seen.
      DISABLED_ACCOUNT_ATTEMPT: 'MAPPED_NOT_OBSERVED',
      CREDENTIAL_CONFIRMED_VALID: 'MAPPED_NOT_OBSERVED',
    },
  },
  {
    source: 'M365_AUDIT_STS',
    outcomes: {
      // InvalidUserNameOrPassword, 65 rows.
      PASSWORD_REJECTED: 'MAPPED_AND_OBSERVED',
      // FINDING (2): from Operation, not from a reason name. 1,412 rows.
      PASSWORD_ACCEPTED_COMPLETED: 'MAPPED_AND_OBSERVED',
      // IdsLocked, 715 rows — the largest single outcome on either feed.
      LOCKED_OUT_AFTER_REPEATED_FAILURES: 'MAPPED_AND_OBSERVED',
      // UserStrongAuthClientAuthNRequiredInterrupt, 13 rows.
      PASSWORD_ACCEPTED_CHALLENGE_ISSUED: 'MAPPED_AND_OBSERVED',
      // UserStrongAuthEnrollmentRequiredInterrupt, 3 rows.
      PASSWORD_ACCEPTED_REGISTRATION_REQUIRED: 'MAPPED_AND_OBSERVED',
      // UNREACHABLE, not merely unseen: no entry in AUDIT_REASON_NAMES maps to
      // any of these, so no audit row can produce one however the tenant
      // behaves. A rule needing one cannot run on this feed, and that is the
      // statement the INAPPLICABLE path exists to make.
      PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED: 'UNREACHABLE',
      BLOCKED_BY_CONTROL: 'UNREACHABLE',
      DISABLED_ACCOUNT_ATTEMPT: 'UNREACHABLE',
      CREDENTIAL_CONFIRMED_VALID: 'UNREACHABLE',
    },
  },
];

const BY_FEED: ReadonlyMap<NormalizationSource, FeedOutcomeCapability> = new Map(
  FEED_CAPABILITIES.map(entry => [entry.source, entry]),
);

/**
 * The outcomes a rule may assume this feed can produce.
 *
 * MAPPED_NOT_OBSERVED counts as reachable, deliberately: a quiet window is not
 * an incapable feed, and treating "we have not seen one yet" as "impossible"
 * would make a rule inapplicable on a tenant that simply had a good month.
 * Consumers wanting the stronger claim should read FEED_CAPABILITIES and ask
 * for MAPPED_AND_OBSERVED themselves — the distinction is in the data rather
 * than left to whoever remembers it.
 */
export function reachableOutcomes(source: NormalizationSource): ReadonlySet<EventOutcome> {
  const entry = BY_FEED.get(source);
  if (entry === undefined) return new Set();
  const reachable = new Set<EventOutcome>();
  for (const [outcome, reachability] of Object.entries(entry.outcomes) as [EventOutcome, OutcomeReachability][]) {
    if (reachability !== 'UNREACHABLE') reachable.add(outcome);
  }
  return reachable;
}

/** Exactly what it says, for a consumer that needs the stronger claim. */
export function observedOutcomes(source: NormalizationSource): ReadonlySet<EventOutcome> {
  const entry = BY_FEED.get(source);
  if (entry === undefined) return new Set();
  const observed = new Set<EventOutcome>();
  for (const [outcome, reachability] of Object.entries(entry.outcomes) as [EventOutcome, OutcomeReachability][]) {
    if (reachability === 'MAPPED_AND_OBSERVED') observed.add(outcome);
  }
  return observed;
}

/**
 * ROW COUNTS IN THIS FILE CARRY AN AS-OF, AND COMPARISONS ACROSS STAMPS ARE
 * INVALID. The table is live and grows during a working session: the 50053
 * denominator moved 1,479 → 1,493 inside ninety minutes, and two figures
 * taken at different moments were presented as one snapshot in a document
 * whose purpose was to be a control — which produced a tenant count that
 * exceeded its own all-tenant total. A bare number in a registry invites
 * exactly that, so figures load-bearing enough to argue from are stamped.
 *
 * Microsoft's own assessment of a sign-in, as a CLOSED SET of measured values.
 *
 * Measured across 2,648 Graph rows: exactly three values exist — `none`
 * (2,593), `userPassedMFADrivenByRiskBasedPolicy` (54, riskState
 * `remediated`), and `aiConfirmedSigninSafe` (1, riskState `dismissed`).
 * The control cohort passes and is not empty: 958 ordinary successes carry the
 * explicit string `none` rather than a missing or hidden value, so the field
 * does not default to a verdict on ordinary human traffic.
 *
 * Unmatched values are COUNTED and change nothing, because the verdict cannot
 * reach a detector: it never appears on a NormalizedEvent. 100% of observed is
 * not 100% of possible — `none` may not be the only benign value another
 * tenant emits — so the unrecognised tally is how coverage discloses that
 * Microsoft said something we could not read.
 */
export interface RiskDetailEntry extends CarriesVerdict {
  readonly value: string;
  /**
   * The riskState this detail is observed WITH.
   *
   * Recorded because a consumer groups Microsoft records by STATE — atRisk,
   * remediated and dismissed land in different groups under different
   * headings — while this layer derived its verdict from the DETAIL alone and
   * never read the state at all. That is stable-looking and arbitrary: every
   * grouping would have been correct on observed data and correct by
   * coincidence, with nothing to notice if the two ever disagreed.
   *
   * Measured 1:1 across all 2,648 rows, so requiring agreement costs nothing
   * today and refuses to guess if that changes.
   */
  readonly riskState: string;
  readonly note: string;
}

export const RISK_DETAIL_VALUES: readonly RiskDetailEntry[] = [
  {
    value: 'none',
    riskState: 'none',
    note:
      'The benign value, and the control cohort: 2,593 of 2,648 rows including 958 ordinary successes. ' +
      'Explicitly the string "none" rather than absent or hidden.',
  },
  {
    value: 'userPassedMFADrivenByRiskBasedPolicy',
    riskState: 'remediated',
    verdict: 'REMEDIATED',
    note:
      'Microsoft assessed risk, a risk-based Conditional Access policy challenged the user, and MFA ' +
      'passed. Detected, handled, closed — and delivered on a tenant with no P2, which makes this the ' +
      'THIRD route by which Microsoft risk output reaches us without the risk API, after sign-in log ' +
      'failure reasons and 53004.',
  },
  {
    value: 'aiConfirmedSigninSafe',
    riskState: 'dismissed',
    verdict: 'SAFE',
    note:
      'Microsoft AI concluded the sign-in was safe. A dismissal, not a detection. Microsoft own ' +
      'vocabulary sets a trap here: auto-remediation lands on riskState "dismissed", so this is a ' +
      'machine assessment rather than a human waving it away.',
  },
];

const BY_RISK_DETAIL: ReadonlyMap<string, RiskDetailEntry> = new Map(
  RISK_DETAIL_VALUES.map(entry => [entry.value.toLowerCase(), entry]),
);

/**
 * Microsoft's verdict for a riskDetail value, if it carries one.
 *
 * NOTE what this no longer does: it does not return a disposition, because
 * the verdict does not change classification at all. An unrecognised value
 * is therefore safe to classify normally. The earlier reasoning that it had
 * to route to UNKNOWN rested on the verdict being able to reach a detector,
 * and it cannot: verdicts never appear on NormalizedEvent. An unrecognised
 * value is counted instead, so coverage can disclose that Microsoft said
 * something we could not read.
 *
 * TAKES THE PAIR, not the detail. The state is checked only where a verdict
 * is at stake, and the asymmetry is deliberate: a detail carrying no verdict
 * cannot be turned into one by any state, so demanding agreement there would
 * inflate the unrecognised tally on ordinary traffic for no protection.
 * Where a verdict IS at stake, a disagreeing state means we do not know which
 * half to believe, and saying so is better than picking one.
 */
export function riskDetailVerdict(detail: unknown, state: unknown):
  | { readonly kind: 'NONE' }
  | { readonly kind: 'VERDICT'; readonly verdict: MicrosoftVerdict }
  | { readonly kind: 'UNRECOGNIZED' } {
  if (detail === undefined || detail === null || detail === '') return { kind: 'NONE' };
  if (typeof detail !== 'string' || detail.length > 256) return { kind: 'UNRECOGNIZED' };
  const entry = BY_RISK_DETAIL.get(detail.trim().toLowerCase());
  if (!entry) return { kind: 'UNRECOGNIZED' };
  if (entry.verdict === undefined) return { kind: 'NONE' };
  const observedState = typeof state === 'string' ? state.trim().toLowerCase() : '';
  if (observedState !== entry.riskState.toLowerCase()) return { kind: 'UNRECOGNIZED' };
  return { kind: 'VERDICT', verdict: entry.verdict };
}

/**
 * THE THREE ROLES A FIELD PLAYS IN A PREDICATE, and why only one is `reads`.
 *
 * A static diff of every predicate's `reads` list against the field names in
 * its own evidence prose found one real gap and five explainable mentions.
 * The five are informative rather than noise: the prose cites fields in three
 * distinct roles that this registry does not distinguish.
 *
 *  - SUBJECT: the paths the predicate is about. This is `reads`, and it is
 *    what the disproved-path lists are derived from.
 *  - CONTROL INSTRUMENT: a field used to build the cohort that must not
 *    match. `audit.result-status` is disproved BY LogonError-bearing rows;
 *    LogonError is the instrument, not the subject.
 *  - CONTRAST: a different predicate mentioned to locate this one.
 *    `graph.is-interactive-false` cites signInEventTypes as "same shape,
 *    different cause".
 *
 * Only the SUBJECT belongs in `reads`. Adding fields for the other two was
 * considered and declined: it would be a third registry to keep in step, and
 * the test that runs this diff carries the explanations instead, so a NEW
 * unexplained mention fails rather than every existing one.
 */
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
  | {
      /**
       * A predicate on this WAS or COULD BE built and would be wrong. Do not
       * read these fields for classification.
       */
      readonly state: 'DISPROVED';
      readonly evidence: string;
      /**
       * REQUIRED: the evidence that would overturn this.
       *
       * A negative claim feels cheaper than a positive one — "do not read
       * this" seems to cost nothing — so it gets made more broadly and
       * checked less. It is actually among the strongest claims here: a
       * permanent instruction to every future reader, in a registry they
       * will trust precisely because it exists. Verification material has to
       * be able to fail, and a tombstone with no revival condition is a claim
       * nothing could ever overturn.
       *
       * It also makes disproof and absence unwriteable as the same thing. If
       * the only condition you can state is "revived if the field ever
       * appears", you do not have a disproof — you have a field you did not
       * find, and it belongs in HYPOTHESIS_SUBJECT_ABSENT. Both corrections
       * this mechanism has already needed would have been caught at write
       * time by having to fill this in.
       */
      readonly revivedBy: string;
    }
  | {
      /**
       * The fields the hypothesis was about DO NOT EXIST in the data, so the
       * hypothesis has no subject and nothing was built on it.
       *
       * Distinct from DISPROVED because conflating them makes the tombstone
       * list lie. A disproved predicate names a field that must never be read,
       * because reading it misleads; an absent-subject hypothesis names a field
       * whose reading is merely pointless. Folding the second into the first
       * would put "never read this" against fields that are harmless, and this
       * module has already had to fix that exact collapse once for feed
       * scoping.
       */
      readonly state: 'HYPOTHESIS_SUBJECT_ABSENT';
      readonly evidence: string;
      /** REQUIRED, and for these it is a question of presence, not behaviour. */
      readonly revivedBy: string;
    };

export interface ShapePredicate {
  readonly id: string;
  /** Payload paths the predicate reads. */
  readonly reads: readonly string[];
  readonly claim: string;
  readonly verification: ShapePredicateVerification;
  /**
   * The feed this predicate is about, when it is about only one.
   *
   * This exists because a path can be legitimate on one feed and disproved on
   * another: `raw.status` IS the provider object on Graph and is read
   * normally, while on the audit feed the object of the same name is
   * HawkView-synthesized and must never be read. A tombstone list that
   * conflated the two would tell a future reader never to read a field this
   * layer reads on every Graph row — a wrong claim inside the very mechanism
   * meant to prevent wrong claims.
   */
  readonly feed?: NormalizationSource;
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
      evidence:
        'On the Graph path, errorCode 0 carries "Other." on 100% of code-0 rows — that population is ' +
        '1,010 as of 2026-09-10T16:36Z: no absent, no null, no empty string.',
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
        'Audit rows resolving against directory_users, deleted excluded: 96.9% (1,730/1,786), 97.1% ' +
        '(968/997) and 77.8% (7 of 9) by UPN. THE THIRD IS NOT A RATE and must not be read beside the ' +
        'other two as though it were: nine rows, two of them unbound. Presenting it as a percentage ' +
        'alongside two four-figure samples invites exactly that comparison, and a prediction built on ' +
        'it (that the 997-row tenant would lose ~20% of its rows) would have been wrong by 190 rows. ' +
        'The low-binding tenant is a different, nine-row tenant. ' +
        'across the three fallback-path tenants, versus 15.2% / 0.0% / 0.0% by GUID, over row ' +
        'populations of 1,786 / 997 / 9. ' +
        'THE THIRD COLUMN OF BOTH TRIPLES IS NINE ROWS, so neither the 77.8% nor the 0.0% there is a ' +
        'rate — it is 7 of 9 and 0 of 9. Listing them beside four-figure samples invites a comparison ' +
        'that already cost one wrong prediction: read that way, it forecast a ~20% shortfall on the ' +
        '997-row tenant, which resolves at 97.1%, an error of about 190 rows. Re-measured across ' +
        'two INDEPENDENT tenants with separate MSPs and separate directories — 97.2% vs 12.0% (1,786 ' +
        'rows) and 97.1% vs 0.0% (997 rows) — agreeing within 0.1 percentage points. Those two are the ' +
        'samples large enough for the agreement to mean anything. ' +
        'The UPN-in-record / GUID-in-column split holds ' +
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
        'and the closed set accounts for 100.0% of observed 50053 rows — 932 malicious-IP, 561 lockout, ' +
        'ZERO matching neither.',
      control:
        'Each literal matches exactly ONE fragment set and not the other, and neither reaches the ' +
        'risk-verdict fragment — asserted against the byte-exact strings in normalize.test.ts. THE LIMIT ' +
        'OF THE CLAIM: 100% is true of OBSERVED data — 1,493 rows of code 50053, one tenant, four ' +
        'accounts, one locale, six weeks. It does NOT ' +
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
      evidence:
        'Graph rows bind 100% on both Graph tenants, with zero ambiguous matches. DENOMINATOR NOT ' +
        'RECORDED AT MEASUREMENT TIME, and not reconstructed here: the Graph population is ~2,645 rows ' +
        'but the figure was taken against whatever it was then, and quoting today’s total beside a ' +
        'percentage measured earlier is precisely the two-moments-as-one-snapshot error. Needs a ' +
        're-measurement stating bound/considered. The claim is strong and cheap to re-verify.',
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
      revivedBy:
        'A distribution in which the field takes MORE THAN ONE value — specifically rows carrying ' +
        'false alongside a 50126 control cohort carrying true. That would make it discriminating ' +
        'rather than inert. Fixing the collector filter is the likely route, and until then the ' +
        'predicate cannot be revived by argument.',
    },
  },
  {
    id: 'audit.result-status',
    reads: ['managementActivityRecord.ResultStatus'],
    claim: 'DISPROVED. ResultStatus "Succeeded" on an STS logon event means the logon succeeded.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'CONFIRMED AGAINST OUR OWN DATA rather than taken from documentation: 141 rows with LogonError ' +
        'IdsLocked — locked-out accounts — carry ResultStatus "Success", along with 232 ' +
        'UnclassifiedAuthenticationError and 13 UserStrongAuthClientAuthNRequiredInterrupt. For STS logon ' +
        'events ResultStatus is HTTP-level, not logon-level. It fails silently in the direction of calling ' +
        'failed sign-ins successful, which is the worst available direction. Read Operation instead, which ' +
        'passes the same control cleanly.',
      revivedBy:
        'A control cohort in which NO failure-bearing row carries Success — i.e. zero rows with a ' +
        'LogonError and ResultStatus Success. Today that cohort has 141 IdsLocked rows in it. This is a ' +
        'genuine disproof rather than an absence: the field is present on every row and says the wrong ' +
        'thing.',
    },
  },
  {
    id: 'signin.synthesized-status-object',
    feed: 'M365_AUDIT_STS',
    reads: ['raw.status.errorCode', 'raw.status.failureReason'],
    claim:
      'DISPROVED FOR THE AUDIT FEED. raw.status on an audit row is provider data that can be read like ' +
      'the Graph status object of the same name.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'It is HawkView-synthesized rather than provider data, and it is INCONSISTENT FOR IDENTICAL ' +
        'INPUTS: for the same LogonError and the same Operation, the projected failureReason is ' +
        'sometimes populated and sometimes not — IdsLocked 578 populated against 137 not, ' +
        'UserStrongAuthClientAuthNRequiredInterrupt 1 against 12. An ingest-date boundary was checked as ' +
        'an explanation and ruled out; the ranges overlap. CAUSE UNRESOLVED and reported as unresolved. ' +
        'Its failureReason also falls back to record.Operation, and a distribution computed from it was ' +
        'already withdrawn for describing our own fallback rather than Microsoft. This layer reads ' +
        'raw.managementActivityRecord instead — a choice made before there was a reason, which now has ' +
        'one. NOTE: on the GRAPH feed raw.status IS the provider object and is read normally; only the ' +
        'audit projection of the same name is disproved.',
      revivedBy:
        'The projection becoming deterministic for identical inputs AND dropping its Operation fallback. ' +
        'Even then it would be a derived field rather than provider data, so reviving it would need a ' +
        'reason to prefer it over reading the record directly.',
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
      revivedBy:
        'The column matching directory_users on a meaningful share of rows AND being no more granular ' +
        'than the real user. Both clauses matter: matching alone would not rescue an identifier that ' +
        'splits one person into six.',
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
        'whole provider row, and redaction replaces values without dropping keys. HONEST NOTE ON WHICH ' +
        'DEFECT THIS IS: the primary one is ABSENCE, not a field that was found to lie — nobody ever ' +
        'tested whether it discriminates. It is kept as a tombstone rather than an absent-subject ' +
        'hypothesis because a predicate on it actually shipped and was reported as a fix, so the value ' +
        'of the entry is stopping it coming back.',
      revivedBy:
        'BOTH clauses, and the second has never been tested: the field appearing in collected rows, AND ' +
        'a control cohort of ordinary human sign-ins that does NOT carry servicePrincipal or ' +
        'managedIdentity. Presence alone would revive only the question, not the predicate.',
    },
  },
  {
    id: 'graph.service-principal-id',
    reads: ['raw.servicePrincipalId', 'raw.servicePrincipalName'],
    claim: 'DISPROVED. A non-empty servicePrincipalId marks a non-human actor.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'Non-empty on 100% of Graph rows — 2,645 as of the re-measurement — INCLUDING ordinary human ' +
        'sign-ins that resolve to real directory ' +
        'users, and servicePrincipalName always empty. Neither discriminates anything. It was confirmed ' +
        'present on 60/60 rows of the tenant someone wanted to exclude; the query nobody ran was whether ' +
        'it was also present on humans, and it was, on all of them. The control is not optional and it is ' +
        'not the same query.',
      revivedBy:
        'A control cohort of ordinary human sign-ins in which the field is EMPTY. That is the query ' +
        'nobody ran the first time, and it is the only thing that could overturn this.',
    },
  },
  {
    id: 'graph.risk-detail',
    reads: ['raw.riskDetail', 'raw.riskState', 'raw.conditionalAccessStatus', 'raw.appliedConditionalAccessPolicies'],
    claim:
      'raw.riskDetail carries Microsoft’s own verdict about a sign-in, so a row bearing one belongs in ' +
      'the Microsoft channel rather than in HawkView’s findings — and the verdict KIND (risky versus ' +
      'safe) can be read from its value.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence:
        'Measured across 2,648 Graph rows. Exactly three values exist: none (2,593), ' +
        'userPassedMFADrivenByRiskBasedPolicy / remediated (54), aiConfirmedSigninSafe / dismissed (1). ' +
        'The detail and the state are 1:1 on every row, and the closed set is keyed on the PAIR rather ' +
        'than the detail alone: a consumer groups Microsoft records by STATE, so a verdict derived from ' +
        'the detail while never reading the state would have been right by coincidence. ' +
        'See RISK_DETAIL_VALUES for the closed set and the verdicts.',
      control:
        'PASSES and is NOT EMPTY, which is what makes it usable: 958 ordinary successes (result code 0) ' +
        'carry the explicit string "none" with riskState "none" — not absent, not hidden — so the field ' +
        'does not default to a verdict on ordinary human traffic. Only 52 successes carry a ' +
        'verdict-shaped value. Documentation had suggested the field would be hidden without P2, and it ' +
        'is not; that expectation is exactly what needed checking rather than assuming.',
    },
  },
  {
    id: 'audit.operation-as-outcome',
    feed: 'M365_AUDIT_STS',
    // LogonError ADDED by the reads-versus-evidence diff. The claim below
    // names it, the evidence is a JOINT fact about the partition of the two
    // fields, and the classifier reads both — so declaring only Operation
    // understated the predicate's scope. Same species as the riskState gap,
    // with one honest difference worth keeping straight: there the CODE read
    // half the fact, so the conclusion rested on half; here the code already
    // read both and only the declaration was short. Documentation, not
    // behaviour. It still matters, because `reads` is what another reader
    // diffs and what the disproved-path lists are derived from.
    reads: ['managementActivityRecord.Operation', 'managementActivityRecord.LogonError'],
    claim:
      'On the audit feed, Operation carries the sign-in outcome: UserLoggedIn is a success and ' +
      'UserLoginFailed is a failure whose reason is named in LogonError.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence:
        'A clean partition present on EVERY row in both collection eras: Operation UserLoggedIn on 1,412 ' +
        'rows, all of them with no LogonError at all; UserLoginFailed on the remainder, essentially all ' +
        'of which carry a LogonError naming the reason. This is the field the audit path now reads for ' +
        'the outcome, because the result code fields do not exist in the data at all.',
      control:
        'PASSES: no UserLoggedIn row carries a LogonError, so the two halves of the partition do not ' +
        'overlap. Contrast ResultStatus, which fails the same control badly — 141 IdsLocked rows are ' +
        'marked ResultStatus Success — and is recorded as disproved.',
    },
  },
  {
    id: 'audit.result-code-vocabulary',
    reads: ['managementActivityRecord.LoginStatus', 'managementActivityRecord.ErrorCode'],
    claim:
      'The audit result code is a single vocabulary, so pooling LoginStatus and ErrorCode into one ' +
      'numeric space and requiring them to agree is a sound reading.',
    verification: {
      state: 'HYPOTHESIS_SUBJECT_ABSENT',
      evidence:
        'THE QUESTION DISSOLVED RATHER THAN BEING ANSWERED: neither LoginStatus nor ErrorCode exists ' +
        'anywhere in the audit records — not at top level, not in ExtendedProperties, which carry only ' +
        'ResultStatusDetail, RequestType, UserAuthenticationMethod, UserAgent and KeepMeSignedIn. So ' +
        'there is no two-vocabulary merge to check for and nothing to restructure. The provenance of ' +
        'result code 1 remains unexplained under every account offered — it is not Microsoft LoginStatus ' +
        'surfaced into the wrong field, because the field is not there — and RESULT_CODE_NOT_AN_AZURE_CODE ' +
        'stays the right name precisely because it is true without knowing where the value came from. ' +
        'Retired; this layer reads Operation for the outcome and LogonError for the reason. NOT a ' +
        'tombstone: these two fields are absent rather than misleading, so reading them is pointless ' +
        'rather than dangerous, and this layer still checks them cheaply in case a projector change ' +
        'starts supplying one. The superseded hypothesis, for the record: if LoginStatus is ' +
        'a success/failure flag while ErrorCode carries AADSTS codes, then the two are different ' +
        'vocabularies sharing one field, a 1 and a 50126 are not comparable numbers, and requiring them ' +
        'to agree numerically would discard rows that agree semantically (LoginStatus 1 and ErrorCode ' +
        '50126 both mean failure). Nothing is built on the hypothesis: this layer keys on the reason name ' +
        'and uses the code only as corroboration, and disagreement routes to UNKNOWN, which is the ' +
        'conservative direction either way. WHAT REMAINS OPEN: where result code 1 came from at all. ' +
        'It cannot be produced by the current projector, and neither field it would have been read from ' +
        'exists in the data, so the 613 rows carrying it predate the current code and their provenance ' +
        'is unexplained. Nothing depends on the answer — this layer neither keys on nor corroborates ' +
        'with that value. NOTE FOR STORAGE, kept because it outlives this predicate: if two vocabularies ' +
        'merging them rather than to read them more ' +
        'cleverly.',
      revivedBy:
        'Either field appearing in an audit record at all — again a question of PRESENCE. If one does, ' +
        'the two-vocabulary question becomes live again and needs the disjoint-range check that could ' +
        'not be run against absent fields.',
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
      state: 'HYPOTHESIS_SUBJECT_ABSENT',
      evidence:
        'KILL CONDITION MET, as stated in advance. Absent from all 2,648 Graph rows — the key is not ' +
        'present, not empty — and authenticationRequirement is absent too. SAME CAUSE AS A WHOLE FAMILY: ' +
        'incomingTokenType, tokenIssuerName and tokenIssuerType are absent from every row as well, so ' +
        'ONE collector change (an explicit $select) governs all five rather than there being several ' +
        'separate bugs. SEQUENCING MATTERS: the redaction regex matches any key containing "token", so it ' +
        'WOULD destroy three of those fields the moment they start arriving — a latent bug, not an active ' +
        'one, and the fix has to land before the $select or the $select creates it. Since raw is the full payload ' +
        'post-redaction and redaction preserves keys, Microsoft did not send these fields. Both are ' +
        'documented on the v1.0 signIn resource, so the likely cause is omission from the default list ' +
        'projection, needing an explicit $select — which would make this a fixable COLLECTION gap rather ' +
        'than a licensing wall. That needs one Graph call to settle and is not asserted here. Retired ' +
        'rather than left pending: the hypothesis as stated is dead, and reviving it is a collection ' +
        'question rather than a classification one.',
      revivedBy:
        'The keys appearing in collected rows at all — a question of PRESENCE, which is what makes this ' +
        'an absent subject rather than a disproof. Most likely route: an explicit $select on the sign-in ' +
        'request. If they appear, the hypothesis returns as untested rather than as confirmed, and needs ' +
        'its own control cohort.',
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

/**
 * Payload paths no classification path may read ON ANY FEED. Asserted
 * behaviourally in tests.
 *
 * Feed-scoped disproved predicates are deliberately NOT here — see
 * `disprovedPathsForFeed`. Folding them in would assert that a path is dead
 * everywhere when it is dead in one place, which is the same
 * collapse-two-facts-into-one defect this list exists to guard against.
 */
export const DISPROVED_PREDICATE_PATHS: readonly string[] = SHAPE_PREDICATES
  .filter(entry => entry.verification.state === 'DISPROVED' && entry.feed === undefined)
  .flatMap(entry => entry.reads);

/** Paths disproved for one feed only, and legitimate on the other. */
export function disprovedPathsForFeed(feed: NormalizationSource): readonly string[] {
  return SHAPE_PREDICATES
    .filter(entry => entry.verification.state === 'DISPROVED' && entry.feed === feed)
    .flatMap(entry => entry.reads);
}

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
  // An absent subject cannot exclude anything: there is no field to read.
  // It does not throw, because reading it is harmless rather than forbidden.
  return verification.state === 'PRODUCTION_VERIFIED';
}
