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
  readonly claimClass: ClaimClass;
  readonly disposition: CodeDisposition;
  /**
   * Required when `disposition.kind === 'DOES_NOT_APPLY'`: the documented
   * statement establishing that this code can never be credential-attack
   * evidence. Enforced by a test, not by convention.
   */
  readonly exclusionCitation?: string;
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
    microsoftName: 'UserStrongAuthClientAuthNRequired (did not pass MFA)',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' },
    note:
      'The single highest-value code in the catalogue: the code that says the second factor stopped ' +
      'someone. One digit from 50076 and NOT the same thing.',
  },
  {
    code: 50076,
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
    microsoftName: 'Authentication failed during strong authentication request',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' },
    note:
      'SOURCING CAVEAT: not in Microsoft’s canonical error reference, documented only in the secops ' +
      'guides. In Microsoft’s own spray code set. Carried with that caveat rather than silently.',
  },
  {
    code: 50072,
    microsoftName: 'UserStrongAuthEnrollmentRequiredInterrupt',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' },
    note: 'In Microsoft’s own spray code set.',
  },
  {
    code: 50079,
    microsoftName: 'UserStrongAuthEnrollmentRequired (security info registration)',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' },
    note: 'In Microsoft’s own spray code set.',
  },
  {
    code: 53003,
    microsoftName: 'BlockedByConditionalAccess',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    note: 'Also worth watching: a success paired with 53003 means auth worked and the session was blocked.',
  },
  {
    code: 530032,
    microsoftName: 'BlockedByConditionalAccessOnSecurityPolicy',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53000,
    microsoftName: 'DeviceNotCompliant',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53001,
    microsoftName: 'DeviceNotDomainJoined',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 50097,
    microsoftName: 'DeviceAuthenticationRequired',
    claimClass: 'CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
  },
  {
    code: 53004,
    microsoftName: 'ProofUpBlockedDueToRisk',
    claimClass: 'ATTACK_AND_CONTROL',
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    note:
      'Cannot configure MFA due to suspicious activity. FLAGGED, NOT DECIDED: the "DueToRisk" naming means ' +
      'this is Microsoft’s own risk judgement, which by the channel-separation rule would put it in ' +
      'MICROSOFT_RISK_VERDICT alongside 50053’s risk text and 50131’s suspicious-activity variant. It is ' +
      'left as a control block pending that decision, because further variants are to be flagged rather ' +
      'than settled case by case here.',
  },
  {
    code: 50131,
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
    microsoftName: 'UserDisabled',
    claimClass: 'ATTACK_IN_AGGREGATE',
    disposition: { kind: 'APPLIES', outcome: 'DISABLED_ACCOUNT_ATTEMPT' },
    note: 'Microsoft: "Could indicate someone trying to access an account after they left."',
  },

  // ---- The only two codes that clear the exclusion standard. ----
  {
    code: 50140,
    microsoftName: 'InterruptedKMSI',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'KEEP_ME_SIGNED_IN' },
    exclusionCitation: 'Microsoft: "This is an expected part of the sign in flow."',
    note: 'Naive implementations inflate failure counts with this code.',
  },
  {
    code: 50058,
    microsoftName: 'UserUnauthenticated (session insufficient for SSO)',
    claimClass: 'NEITHER',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN' },
    exclusionCitation: 'Microsoft: "a common error that’s expected."',
  },

  // ---- Recognized, but no citation supports excluding them. ----
  {
    code: 50158,
    microsoftName: 'ExternalSecurityChallengeNotSatisfied',
    claimClass: 'NEITHER',
    disposition: { kind: 'UNKNOWN', observation: 'AMBIGUOUS_BY_PROVIDER_STATEMENT' },
    note: 'Microsoft: "This code alone doesn’t indicate a failure." Do not read a failure into it.',
  },
  {
    code: 50055,
    microsoftName: 'InvalidPasswordExpiredPassword',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note: 'Password hygiene. No citation establishes it can never be attack evidence, so it is not excluded.',
  },
  {
    code: 50144,
    microsoftName: 'InvalidPasswordExpiredOnPremPassword',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    code: 50056,
    microsoftName: 'InvalidOrNullPassword',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    code: 50133,
    microsoftName: 'SsoArtifactInvalidOrExpired (password change)',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note: 'Useful as remediation-took-effect confirmation, which is a different product surface.',
  },
  {
    code: 50173,
    microsoftName: 'FreshTokenNeeded (grant expired)',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
  },
  {
    code: 65001,
    microsoftName: 'ConsentRequired',
    claimClass: 'NEITHER',
    disposition: { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
    note:
      'Previously mapped out of scope here on no citation, which is the 50076 mistake in miniature. It is ' +
      'also one of only three codes observed in more than one tenant, so it is high-volume: a citation ' +
      'either way is worth having.',
  },

  // ---- Meaning lives in free text. ----
  {
    code: 50053,
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
    microsoftName: '(not a Microsoft code)',
    claimClass: 'NEITHER',
    disposition: { kind: 'UNKNOWN', observation: 'HAWKVIEW_SYNTHETIC_ERROR_CODE' },
    note:
      'Verified: "1" is a value HawkView itself invents on the audit-fallback path, with eight distinct ' +
      'description variants. Its instability is ours. Microsoft result-code logic must never be extended ' +
      'onto it.',
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
export const UNREACHABLE_BY_SUBJECT_RESOLUTION: readonly { readonly code: number; readonly microsoftName: string }[] = [
  { code: 50034, microsoftName: 'UserAccountNotFound' },
  { code: 51004, microsoftName: 'UserAccountNotInDirectory' },
];

const BY_CODE: ReadonlyMap<number, ResultCodeEntry> = new Map(
  RESULT_CODES.map(entry => [entry.code, entry]),
);

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
    disposition: { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' },
    verification: {
      state: 'OBSERVED_IN_PRODUCTION',
      evidence: 'One of exactly two description values observed on code 50053, in one tenant over six weeks.',
    },
    note: 'Microsoft blocked the sign-in because the address had known malicious activity. A control that worked.',
  },
  {
    meaning: 'SMART_LOCKOUT',
    fragments: ['too many times with an incorrect user id or password', 'idslocked'],
    disposition: { kind: 'APPLIES', outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES' },
    verification: {
      state: 'OBSERVED_IN_PRODUCTION',
      evidence:
        'The other of exactly two description values observed on code 50053. It carries unique detection ' +
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
        'Audit rows resolving against directory_users, deleted excluded: 96.8% / 97.1% / 77.8% by UPN ' +
        'across the three fallback-path tenants, versus 15.2% / 0.0% / 0.0% by GUID.',
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
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort:
        'This is now the highest-volume predicate in the layer: code 50053 is 1,477 of 2,635 Graph rows, ' +
        '56% of everything collected. The two production description values are known to EXIST but their ' +
        'literal text has not been supplied, so the fragments here are rendered from Microsoft’s ' +
        'documented phrasing rather than from our rows. If they do not match, 56% of traffic lands in ' +
        'UNKNOWN — safe, but a large and avoidable coverage loss.',
      controlCohort:
        'The two values must match one fragment set EACH and not the other, and neither may match the ' +
        'risk-verdict fragment. Multi-match already routes to UNKNOWN rather than picking, so a ' +
        'too-broad fragment costs coverage rather than misclassifying — except for the risk-verdict ' +
        'branch, which is the one disposition that removes an event from `applies`, and which is ' +
        'therefore held to a single distinctive fragment.',
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
