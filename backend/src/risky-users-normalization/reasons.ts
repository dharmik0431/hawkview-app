/**
 * Reason vocabularies for the Risky Users normalization layer.
 *
 * FOUR SEPARATE VOCABULARIES THAT ARE NEVER SUMMED. A malformed row and an
 * expected keep-me-signed-in interrupt are different claims about what a
 * result is worth, and one counter for both destroys the distinction:
 *
 *   OutOfScopeReason      the event was understood, and there is a documented
 *                         basis for saying it is not evidence our detectors
 *                         act on. Does NOT reduce stated coverage.
 *   UncitedReason         the event was understood, and OUR basis for
 *                         excluding it is missing. Disclosed, never gates.
 *                         Unfinished homework, not a limit on the data.
 *   UnknownObservation    we cannot interpret the event. Reduces stated
 *                         coverage. Blocks nothing, ever.
 *   UnprocessableReason   we could not read the row at all. Reduces stated
 *                         coverage. Blocks nothing, ever.
 *
 * NO DEFAULT ARM. Every reason's technician-facing label comes from a
 * `Record<Reason, string>` below, so adding a reason without a label is a
 * compile error rather than a fallback string. The predecessor fell back to a
 * label meaning "incomplete collection window", which told technicians to go
 * chase a collection failure that did not exist.
 *
 * THE EXCLUSION STANDARD, which is why the out-of-scope vocabulary is short. A
 * result code may be mapped out of scope only with a positive documented
 * citation for why it can NEVER be credential-attack evidence. Absence of a
 * reason to include is not a reason to exclude — that is precisely how the
 * predecessor classified 50076 as "not a credential event", when 50076 means a
 * post-password MFA challenge was issued and sits one digit from 50074, the
 * highest-value code in the catalogue. A confident-but-wrong exclusion walks
 * straight past the unverified-predicate guard, because it is not unverified;
 * it is just wrong. Only two codes currently clear the standard.
 */

/**
 * Understood, and out of scope on a documented basis.
 *
 * Each member names the citation that admits it. A member with no citation
 * does not belong here; it belongs in `UncitedReason`.
 */
export type OutOfScopeReason =
  /** 50140. Microsoft: "This is an expected part of the sign in flow." */
  | 'KEEP_ME_SIGNED_IN'
  /** 50058. Microsoft: "a common error that's expected." */
  | 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN'
  /**
   * Microsoft judged the sign-in RISKY.
   *
   * Excluded from HawkView's findings on the owner's product rule, not on a
   * Microsoft citation: our findings and Microsoft's reported risk are two
   * channels that are never merged or summed, and Microsoft's detections must
   * never be presented as our own. A doc says what a code means; the brief
   * says what we are permitted to assert, which is the stronger citation here.
   * Surfaced via `batch.microsoftRiskVerdicts` so the signal is not lost.
   *
   * ATTRIBUTION RULE, in its sharpened form: attribute by whose judgement
   * GENERATED the finding, not by whose machinery responded to it. A
   * risk-based Conditional Access policy is the tenant's machinery responding
   * to Microsoft's judgement — the finding is still "Microsoft judged this
   * risky", and the MFA challenge that followed is remediation, which is
   * context on that finding rather than a finding of ours.
   */
  | 'MICROSOFT_RISK_VERDICT'
  /**
   * Microsoft judged the sign-in SAFE. A dismissal, not a detection.
   *
   * Separate from MICROSOFT_RISK_VERDICT because conflating them is actively
   * misleading in the one direction that matters: Microsoft's AI concluding
   * "we looked and this is fine" must never render as "this user is at risk".
   * Microsoft's channel carries both verdict kinds, so the state is modelled
   * rather than the mere presence of a risk field.
   *
   * RESERVED and currently unreachable: reaching it means reading `riskDetail`,
   * which is a payload-shape predicate with no control cohort yet. See
   * provider-facts.
   */
  | 'MICROSOFT_SAFETY_VERDICT'
  /**
   * RESERVED, currently unreachable. No confirmed field marks a non-interactive
   * sign-in: `isInteractive` is true on 100% of collected Graph rows, so the
   * predicate discriminates nothing. See provider-facts.
   */
  | 'NON_INTERACTIVE_SIGN_IN'
  /**
   * RESERVED, currently unreachable. No confirmed field distinguishes an
   * application actor from a user missing from the collected directory.
   */
  | 'APPLICATION_ACTOR';

/**
 * We know exactly what the event is; what is missing is OUR documented basis
 * for ruling it out of scope.
 *
 * Its own classification rather than a reason code inside UNKNOWN, because
 * folding it there is the same collapse this module keeps removing, one layer
 * down: "our vocabulary has a hole" and "our paperwork has a hole" warrant
 * different urgency, and a technician reading a coverage statement deserves to
 * know which one they are looking at.
 *
 * It also makes the safe reading the default one. A consumer that gates a
 * clean claim on "anything unknown" would let a handful of well-understood
 * consent prompts withhold a tenant's claim indefinitely — the veto pattern in
 * a better label. As a sibling of UNKNOWN, a `switch` over the classification
 * forces that consumer to decide about this case rather than sweeping it in.
 *
 * These events are DISCLOSED and never gate. The fix is a citation, not a
 * weaker gate: once cited, each moves to its proper bucket. Treat a non-zero
 * count as unfinished homework, not as a property of the design.
 */
export type UncitedReason = 'EXCLUSION_NOT_YET_CITED';

/** We cannot interpret the event. Costs stated coverage only. */
export type UnknownObservation =
  | 'ERROR_CODE_ABSENT'
  | 'ERROR_CODE_SHAPE_UNRECOGNIZED'
  | 'UNRECOGNIZED_ERROR_CODE'
  /**
   * 50158. Microsoft: "This code alone doesn't indicate a failure."
   *
   * This stays here rather than moving to `UncitedReason`: no citation will
   * ever resolve it, because the ambiguity is Microsoft's own statement about
   * the code. A permanent hole in the vocabulary, not unfinished homework.
   */
  | 'AMBIGUOUS_BY_PROVIDER_STATEMENT'
  /** A code whose meaning lives in free text, where the text matched nothing known. */
  | 'AMBIGUOUS_FAILURE_REASON_TEXT'
  | 'HAWKVIEW_SYNTHETIC_ERROR_CODE'
  | 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON'
  /** Audit path: Microsoft's own name for the result says it is unclassified. */
  | 'PROVIDER_DECLARED_UNCLASSIFIED'
  /** Audit path: the reason name is not one this layer recognises. */
  | 'UNRECOGNIZED_REASON_NAME'
  /** Audit path: the operation and the result code describe different outcomes. */
  | 'INCONSISTENT_OPERATION_AND_CODE';

/**
 * Why a row was not part of the assessed scope at all.
 *
 * Its own vocabulary rather than a bare number, so a consumer can decide per
 * reason instead of guessing whether "we never looked" was a feed boundary or
 * a scope narrowing. There is exactly one member today, and that is the
 * answer: nothing is excluded from the covered feed by a predicate.
 */
export type UnselectedRowReason = 'ROW_FROM_OTHER_FEED';

/** The row could not be read. Never merged with OutOfScopeReason. */
export type UnprocessableReason =
  | 'RAW_PAYLOAD_MALFORMED'
  | 'SCOPE_MISMATCH'
  | 'SOURCE_UNRECOGNIZED'
  | 'TENANT_BINDING_MISMATCH'
  | 'EVENT_ID_ABSENT_OR_MALFORMED'
  | 'EVENT_TIMESTAMP_INVALID'
  | 'INGESTION_TIMESTAMP_INVALID'
  | 'INGESTION_PRECEDES_EVENT'
  | 'INTEGRITY_DISPUTED'
  | 'UNSUPPORTED_AUDIT_OPERATION'
  | 'SUBJECT_ID_ABSENT_OR_MALFORMED'
  | 'SUBJECT_NOT_IN_DIRECTORY'
  | 'SUBJECT_AMBIGUOUS_IN_DIRECTORY'
  | 'SUBJECT_UPN_ABSENT_OR_MALFORMED'
  | 'SUBJECT_UPN_NOT_IN_DIRECTORY'
  | 'SUBJECT_UPN_AMBIGUOUS_IN_DIRECTORY'
  | 'APPLICATION_ID_ABSENT_OR_MALFORMED'
  | 'REFERENCE_UNAVAILABLE'
  | 'REFERENCE_BUDGET_EXCEEDED'
  | 'BATCH_LIMIT_EXCEEDED';

/**
 * What the collector actually ASKED THE PROVIDER FOR.
 *
 * This exists because coverage is computed over rows handed to this layer, so
 * a feed that was never requested is indistinguishable from a feed that was
 * requested and came back empty. Without this, the layer reports full coverage
 * of a partial view and cannot tell the difference — an honest 100% that is
 * compatible with never having asked for most of the traffic, which is exactly
 * the class of true-but-misleading number this rebuild exists to remove.
 *
 * It is a REQUIRED input, and `UNDECLARED` is a real option: a caller that
 * genuinely does not know what was requested must say so rather than have a
 * default quietly assert something on its behalf.
 *
 * Known today, from the collector source: the Graph sign-in request filters on
 * `createdDateTime` only and applies no `signInEventTypes` filter, so Graph
 * returns its default set, which is interactive user sign-ins.
 */
export type CollectionScope =
  | 'GRAPH_INTERACTIVE_ONLY'
  | 'GRAPH_INTERACTIVE_AND_NON_INTERACTIVE'
  | 'AUDIT_STS_LOGON_EVENTS'
  | 'UNDECLARED';

export const COLLECTION_SCOPE_LABELS: Readonly<Record<CollectionScope, string>> = {
  GRAPH_INTERACTIVE_ONLY:
    'Interactive sign-ins only. Background and token-refresh sign-ins were not requested from Microsoft, so they are outside this assessment entirely',
  GRAPH_INTERACTIVE_AND_NON_INTERACTIVE:
    'Interactive and background sign-ins were both requested from Microsoft',
  AUDIT_STS_LOGON_EVENTS:
    'Sign-in events from the unified audit log, which is the feed used where Microsoft sign-in logs are unavailable',
  UNDECLARED:
    'HawkView cannot state which kinds of sign-in were requested from Microsoft, so coverage below is a share of what was collected and not of the tenant’s traffic',
};

export function describeCollectionScope(scope: CollectionScope): string {
  return COLLECTION_SCOPE_LABELS[scope];
}

/** Unprocessable reasons that mean the subject could not be bound to a person. */
export const SUBJECT_RESOLUTION_FAILURES: readonly UnprocessableReason[] = [
  'SUBJECT_ID_ABSENT_OR_MALFORMED',
  'SUBJECT_NOT_IN_DIRECTORY',
  'SUBJECT_AMBIGUOUS_IN_DIRECTORY',
  'SUBJECT_UPN_ABSENT_OR_MALFORMED',
  'SUBJECT_UPN_NOT_IN_DIRECTORY',
  'SUBJECT_UPN_AMBIGUOUS_IN_DIRECTORY',
];

/**
 * Technician-facing labels. Exhaustive by construction.
 *
 * Wording rule: an out-of-scope label says what the event WAS. It must never
 * suggest that collection is incomplete or that anything needs chasing.
 */
export const OUT_OF_SCOPE_LABELS: Readonly<Record<OutOfScopeReason, string>> = {
  KEEP_ME_SIGNED_IN: 'Keep-me-signed-in prompt, which Microsoft documents as an expected part of the sign-in flow',
  INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN: 'Existing session was insufficient for silent sign-in, which Microsoft documents as expected',
  MICROSOFT_RISK_VERDICT: 'Microsoft judged this sign-in risky; shown under Microsoft-reported risk, not as a HawkView finding',
  MICROSOFT_SAFETY_VERDICT: 'Microsoft assessed this sign-in and judged it safe; shown under Microsoft-reported risk as a dismissal, never as a HawkView finding',
  NON_INTERACTIVE_SIGN_IN: 'Background sign-in rather than a person entering a credential',
  APPLICATION_ACTOR: 'The actor was an application or service principal, not a person',
};

/**
 * Wording rule: an uncited label makes clear the gap is ours, not the data's,
 * and that the event is neither acted on nor dismissed.
 */
export const UNCITED_LABELS: Readonly<Record<UncitedReason, string>> = {
  EXCLUSION_NOT_YET_CITED:
    'HawkView recognises this sign-in result but has not yet established whether it can be ruled out of scope, so it is neither acted on nor dismissed',
};

/**
 * Wording rule: an unknown label says HawkView does not recognise the event,
 * and says so as a limit on what we can claim. It must never read as a
 * collection fault, because it is not one.
 */
export const UNKNOWN_LABELS: Readonly<Record<UnknownObservation, string>> = {
  ERROR_CODE_ABSENT: 'The record carried no sign-in result code, so HawkView cannot say what the result was',
  ERROR_CODE_SHAPE_UNRECOGNIZED: 'The sign-in result code was not in a form HawkView reads',
  UNRECOGNIZED_ERROR_CODE: 'HawkView does not recognise this sign-in result code',
  AMBIGUOUS_BY_PROVIDER_STATEMENT: 'Microsoft states this code alone does not indicate a failure, so HawkView will not read one into it',
  AMBIGUOUS_FAILURE_REASON_TEXT: 'This code carries several meanings in its description text, and the text did not match any meaning HawkView knows',
  HAWKVIEW_SYNTHETIC_ERROR_CODE: 'Result code was generated by HawkView’s own fallback path, not by Microsoft',
  SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON: 'Reported as a success but carried an unrecognised description, so HawkView will not call it a success',
  PROVIDER_DECLARED_UNCLASSIFIED: 'Microsoft recorded this sign-in result as unclassified, so there is nothing for HawkView to read from it',
  UNRECOGNIZED_REASON_NAME: 'HawkView does not recognise the name Microsoft gave this sign-in result',
  INCONSISTENT_OPERATION_AND_CODE: 'The recorded operation and the result code describe different outcomes, so HawkView will not pick one',
};

/**
 * Wording rule: an unprocessable label describes the row defect, and is the
 * ONLY vocabulary that may point at collection or data quality.
 */
export const UNPROCESSABLE_LABELS: Readonly<Record<UnprocessableReason, string>> = {
  RAW_PAYLOAD_MALFORMED: 'The stored record was not a readable object',
  SCOPE_MISMATCH: 'The record belonged to a different organisation or customer tenant',
  SOURCE_UNRECOGNIZED: 'The record did not identify which collection feed produced it',
  TENANT_BINDING_MISMATCH: 'The record named a different Microsoft tenant than the one being assessed',
  EVENT_ID_ABSENT_OR_MALFORMED: 'The record carried no usable event identifier',
  EVENT_TIMESTAMP_INVALID: 'The record carried no usable event timestamp',
  INGESTION_TIMESTAMP_INVALID: 'The row carried no usable ingestion timestamp',
  INGESTION_PRECEDES_EVENT: 'The row was recorded as ingested before the event it describes',
  INTEGRITY_DISPUTED: 'Collection flagged this record’s integrity as disputed',
  UNSUPPORTED_AUDIT_OPERATION: 'The audit record was not a sign-in operation HawkView reads',
  SUBJECT_ID_ABSENT_OR_MALFORMED: 'The record carried no directory object id for the signing-in user',
  SUBJECT_NOT_IN_DIRECTORY: 'The directory object id on the record is not present in the collected directory',
  SUBJECT_AMBIGUOUS_IN_DIRECTORY: 'The directory object id on the record matched more than one directory record',
  SUBJECT_UPN_ABSENT_OR_MALFORMED: 'The record carried no usable user name for the signing-in user',
  SUBJECT_UPN_NOT_IN_DIRECTORY: 'The user name on the record matches no user in the collected directory',
  SUBJECT_UPN_AMBIGUOUS_IN_DIRECTORY: 'The user name on the record matched more than one directory user, so HawkView will not choose between them',
  APPLICATION_ID_ABSENT_OR_MALFORMED: 'The record carried no usable application id',
  REFERENCE_UNAVAILABLE: 'A protected reference for the user or application could not be produced',
  REFERENCE_BUDGET_EXCEEDED: 'This evaluation reached its limit on distinct protected references',
  BATCH_LIMIT_EXCEEDED: 'This evaluation reached its per-run row limit before reaching this row',
};

export const UNSELECTED_ROW_LABELS: Readonly<Record<UnselectedRowReason, string>> = {
  ROW_FROM_OTHER_FEED:
    'Collected by the other sign-in feed, which is not the one this assessment reads; the two are never pooled',
};

/**
 * Zero-filled counters keyed by every reason in a vocabulary.
 *
 * Deriving the keys from the label map is what keeps counters and labels from
 * drifting: a reason that exists has a label and a counter, or this module
 * does not compile.
 */
export function zeroCounts<Key extends string>(labels: Readonly<Record<Key, string>>): Record<Key, number> {
  return Object.fromEntries(Object.keys(labels).map(key => [key, 0])) as Record<Key, number>;
}

/** Exhaustiveness guard. Reachable only if a union gained a member without a branch. */
export function unreachable(value: never): never {
  throw new Error(`RISKY_USERS_NORMALIZATION_UNREACHABLE:${String(value)}`);
}

export function describeOutOfScope(reason: OutOfScopeReason): string {
  return OUT_OF_SCOPE_LABELS[reason];
}
export function describeUncited(reason: UncitedReason): string {
  return UNCITED_LABELS[reason];
}
export function describeUnknown(observation: UnknownObservation): string {
  return UNKNOWN_LABELS[observation];
}
export function describeUnprocessable(reason: UnprocessableReason): string {
  return UNPROCESSABLE_LABELS[reason];
}
export function describeUnselectedRow(reason: UnselectedRowReason): string {
  return UNSELECTED_ROW_LABELS[reason];
}
