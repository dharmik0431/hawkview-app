import type { EventOutcome } from './contract.js';
import type { OutOfScopeReason, UnknownObservation } from './reasons.js';

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
 *    carries a particular value across real traffic. It is an empirical claim
 *    about a data distribution and it is worth nothing until it has been
 *    checked against real rows INCLUDING A CONTROL COHORT THAT MUST NOT
 *    MATCH. Synthetic tests structurally cannot validate one of these.
 *
 * The safety rule this module enforces: an unverified payload-shape predicate
 * has NO effect on classification. It is observed and counted, never acted on.
 * Not "routes to UNKNOWN" either — an event moved to UNKNOWN is just as
 * absent from evaluation as one moved out of scope, so routing an unconfirmed
 * predicate's matches to UNKNOWN is the same failure in a politer wrapper.
 * That is the `servicePrincipalId` failure mode — a predicate that passed
 * review and synthetic tests and would have excluded every human sign-in
 * while reporting tenants clean — made structurally unavailable rather than
 * merely reviewed against.
 */

export type CodeDisposition =
  | { readonly kind: 'APPLIES'; readonly outcome: EventOutcome }
  | { readonly kind: 'DOES_NOT_APPLY'; readonly reason: OutOfScopeReason }
  | { readonly kind: 'UNKNOWN'; readonly observation: UnknownObservation };

export interface ResultCodeEntry {
  readonly code: number;
  /** Microsoft's published name for the code, for traceability. */
  readonly microsoftName: string;
  readonly disposition: CodeDisposition;
  readonly note?: string;
}

/**
 * Documented sign-in result codes.
 *
 * Mapping rule for DOES_NOT_APPLY: a code may be mapped out of scope only if
 * its documented meaning contains NO verdict about whether a credential was
 * correct. Every entry below is an interrupt, a policy decision or a session
 * condition. A code whose meaning includes a credential verdict must never be
 * mapped out of scope, because that silently removes exactly the evidence the
 * sanctioned rules exist to find.
 *
 * A code that is absent from this table is UNKNOWN. That is the third bucket
 * doing its job, not a fallback: an unrecognized code reduces stated coverage
 * and blocks nothing. Extending this table is a mapping change and wants the
 * real code distribution in hand, not a list of codes someone could name.
 */
export const RESULT_CODES: readonly ResultCodeEntry[] = [
  {
    code: 0,
    microsoftName: 'None',
    disposition: { kind: 'APPLIES', outcome: 'SUCCESS' },
    note: 'Gated on failureReason: verified in production to be empty, absent, or the literal "Other." on genuine successes.',
  },
  {
    code: 50126,
    microsoftName: 'InvalidUserNameOrPassword',
    disposition: { kind: 'APPLIES', outcome: 'INVALID_CREDENTIAL' },
  },
  {
    code: 50053,
    microsoftName: 'IdsLocked',
    disposition: { kind: 'UNKNOWN', observation: 'AMBIGUOUS_DOCUMENTED_CODE' },
    note:
      'Observed carrying TWO meanings distinguished only by failureReason free text: smart lockout after ' +
      'repeated failures, and blocked-from-malicious-IP. One tenant, one locale, six weeks is not a durable ' +
      'text contract, so this code is neither split on text nor guessed at. See README: this is the highest-' +
      'value mapping decision still open, because a lockout is downstream evidence of repeated invalid ' +
      'credentials and the failures that caused it normally also appear as 50126 rows in the same window.',
  },
  {
    code: 50074,
    microsoftName: 'UserStrongAuthClientAuthNRequired',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MFA_INTERRUPT' },
  },
  {
    code: 50076,
    microsoftName: 'UserStrongAuthClientAuthNRequiredInterrupt',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MFA_INTERRUPT' },
  },
  {
    code: 50072,
    microsoftName: 'UserStrongAuthEnrollmentRequiredInterrupt',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MFA_INTERRUPT' },
  },
  {
    code: 50079,
    microsoftName: 'UserStrongAuthEnrollmentRequired',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'MFA_INTERRUPT' },
  },
  {
    code: 50140,
    microsoftName: 'InterruptedKMSI',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'KEEP_ME_SIGNED_IN' },
  },
  {
    code: 50058,
    microsoftName: 'UserUnauthenticated',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN' },
  },
  {
    code: 53003,
    microsoftName: 'BlockedByConditionalAccess',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'CONDITIONAL_ACCESS_INTERRUPT' },
  },
  {
    code: 65001,
    microsoftName: 'ConsentRequired',
    disposition: { kind: 'DOES_NOT_APPLY', reason: 'CONSENT_REQUIRED' },
  },
  {
    code: 1,
    microsoftName: '(not a Microsoft code)',
    disposition: { kind: 'UNKNOWN', observation: 'HAWKVIEW_SYNTHETIC_ERROR_CODE' },
    note:
      'Verified: "1" is a value HawkView itself invents on the audit-fallback path, with eight distinct ' +
      'failureReason variants. Its instability is ours. Graph result-code logic must never be extended onto it.',
  },
];

const BY_CODE: ReadonlyMap<number, ResultCodeEntry> = new Map(
  RESULT_CODES.map(entry => [entry.code, entry]),
);

/**
 * Disposition for a result code.
 *
 * Returning UNKNOWN for an unlisted code is NOT the forbidden default arm.
 * The forbidden default arm is on the reason vocabularies — mapping a reason
 * to a label — and there is none: see `reasons.ts`, where every label comes
 * from an exhaustive `Record<Reason, string>`. An unrecognized provider code
 * genuinely is an unrecognized provider code, and saying so is the entire
 * purpose of the third bucket.
 */
export function dispositionForCode(code: number): CodeDisposition {
  return BY_CODE.get(code)?.disposition ?? { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_ERROR_CODE' };
}

export type ShapePredicateVerification =
  | { readonly state: 'PRODUCTION_VERIFIED'; readonly evidence: string }
  | {
      readonly state: 'PENDING_DISTRIBUTION_CHECK';
      /** Rows the predicate is expected to match. */
      readonly cohort: string;
      /** Rows that MUST NOT match, or the predicate is wrong or inert. */
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
 * they are the record of two predicates that were plausible, reviewed, and
 * false about what they meant, and `normalize.test.ts` asserts behaviourally
 * that classification is unchanged by the fields they read.
 */
export const SHAPE_PREDICATES: readonly ShapePredicate[] = [
  {
    id: 'graph.success-failure-reason-empty',
    reads: ['raw.status.errorCode', 'raw.status.failureReason'],
    claim: 'errorCode 0 with failureReason absent, empty, or the literal "Other." is a genuine success.',
    verification: {
      state: 'PRODUCTION_VERIFIED',
      evidence:
        'Verified against production: errorCode 0 appears with failureReason either empty/absent or the ' +
        'literal "Other.", and both are successes. The predecessor treated "Other." as a failure reason and ' +
        'demoted real successes to UNKNOWN.',
    },
  },
  {
    id: 'graph.is-interactive-false',
    reads: ['raw.isInteractive'],
    claim: 'isInteractive === false marks a non-interactive sign-in (token refresh or background request).',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort: 'Graph rows for background/token-refresh traffic, which routinely outnumbers interactive traffic.',
      controlCohort:
        'Graph rows carrying result code 50126. Those are unambiguously human interactive password failures. ' +
        'If they report isInteractive false, or the field is absent from them, this predicate is wrong or ' +
        'inert and must not exclude anything. Until that check returns the predicate has NO effect on ' +
        'classification: matches are counted in shapeObservations and nothing else. Routing them to UNKNOWN ' +
        'instead would also remove them from evaluation, which is the same failure in a politer wrapper.',
    },
  },
  {
    id: 'graph.application-actor',
    reads: [],
    claim:
      'RESERVED AND CURRENTLY UNREACHABLE. No verified field distinguishes an application actor from a user ' +
      'missing from the collected directory, so app-only sign-ins currently land as unprocessable subject ' +
      'failures, which is counted and visible. The DOES_NOT_APPLY reason APPLICATION_ACTOR therefore reports ' +
      'zero. Activating it needs a discriminator with a passing control cohort; servicePrincipalId is not one.',
    verification: {
      state: 'PENDING_DISTRIBUTION_CHECK',
      cohort: 'Unassigned: no candidate discriminator has survived a control cohort yet.',
      controlCohort: 'Ordinary human sign-ins, which must not match any candidate.',
    },
  },
  {
    id: 'graph.sign-in-event-types',
    reads: ['raw.signInEventTypes'],
    claim: 'DISPROVED. signInEventTypes containing servicePrincipal or managedIdentity marks a non-human actor.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'signInEventTypes is ABSENT from every row in the dataset. Any predicate on it matches nothing, so it ' +
        'would have shipped as a verified fix that changed nothing at all.',
    },
  },
  {
    id: 'graph.service-principal-id',
    reads: ['raw.servicePrincipalId', 'raw.servicePrincipalName'],
    claim: 'DISPROVED. A non-empty servicePrincipalId marks a non-human actor.',
    verification: {
      state: 'DISPROVED',
      evidence:
        'servicePrincipalId is non-empty on 100% of Graph rows INCLUDING ordinary human sign-ins, and ' +
        'servicePrincipalName is always empty. Neither discriminates anything. This predicate passed review ' +
        'and synthetic tests and would have excluded every human sign-in while reporting tenants clean.',
    },
  },
];

/** Payload paths no classification path may read. Asserted behaviourally in tests. */
export const DISPROVED_PREDICATE_PATHS: readonly string[] = SHAPE_PREDICATES
  .filter(predicate => predicate.verification.state === 'DISPROVED')
  .flatMap(predicate => predicate.reads);

function predicate(id: string): ShapePredicate {
  const found = SHAPE_PREDICATES.find(entry => entry.id === id);
  if (!found) throw new Error(`RISKY_USERS_NORMALIZATION_UNKNOWN_PREDICATE:${id}`);
  return found;
}

/**
 * Whether a shape predicate is allowed to place an event outside evaluation.
 * Only a predicate confirmed against a real distribution with a passing
 * control cohort may. Everything else routes to UNKNOWN.
 */
export function mayExclude(id: string): boolean {
  const { verification } = predicate(id);
  if (verification.state === 'DISPROVED') {
    throw new Error(`RISKY_USERS_NORMALIZATION_DISPROVED_PREDICATE:${id}`);
  }
  return verification.state === 'PRODUCTION_VERIFIED';
}
