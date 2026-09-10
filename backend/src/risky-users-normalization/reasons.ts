/**
 * Reason vocabularies for the Risky Users normalization layer.
 *
 * THREE SEPARATE VOCABULARIES THAT ARE NEVER SUMMED. A malformed row and an
 * expected keep-me-signed-in interrupt are different claims about what a
 * result is worth, and one counter for both destroys the distinction:
 *
 *   OutOfScopeReason      the event was understood, and there is a documented
 *                         basis for saying it is not evidence our detectors
 *                         act on. Does NOT reduce stated coverage.
 *   UnknownObservation    we cannot interpret the event, or we can interpret
 *                         it but cannot defend excluding it. Reduces stated
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
 * THE EXCLUSION STANDARD, which is why this vocabulary is short. A result code
 * may be mapped out of scope only with a positive documented citation for why
 * it can NEVER be credential-attack evidence. Absence of a reason to include
 * is not a reason to exclude — that is precisely how the predecessor
 * classified 50076 as "not a credential event", when 50076 means a
 * post-password MFA challenge was issued and sits one digit from 50074, the
 * highest-value code in the catalogue. A confident-but-wrong exclusion walks
 * straight past the unverified-predicate guard, because it is not unverified;
 * it is just wrong. Only two codes currently clear the standard.
 */

/**
 * Understood, and out of scope on a documented basis.
 *
 * Each member names the citation that admits it. A member with no citation
 * does not belong here; it belongs in `RECOGNIZED_BUT_EXCLUSION_UNCITED`.
 */
export type OutOfScopeReason =
  /** 50140. Microsoft: "This is an expected part of the sign in flow." */
  | 'KEEP_ME_SIGNED_IN'
  /** 50058. Microsoft: "a common error that's expected." */
  | 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN'
  /**
   * Microsoft's own high-confidence risk verdict. Excluded from HawkView's
   * findings on the owner's product rule, not on a Microsoft citation: our
   * findings and Microsoft's reported risk are two channels that are never
   * merged or summed. Surfaced via `batch.microsoftRiskVerdicts`.
   */
  | 'MICROSOFT_RISK_VERDICT'
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

/** We cannot interpret it, or cannot defend excluding it. Costs coverage only. */
export type UnknownObservation =
  | 'ERROR_CODE_ABSENT'
  | 'ERROR_CODE_SHAPE_UNRECOGNIZED'
  | 'UNRECOGNIZED_ERROR_CODE'
  /**
   * We know what the code means and have no documented basis for ruling it out
   * of scope. Costs coverage, blocks nothing, and is recoverable the moment a
   * citation exists. This is the exclusion standard's designated landing spot.
   */
  | 'RECOGNIZED_BUT_EXCLUSION_UNCITED'
  /** 50158. Microsoft: "This code alone doesn't indicate a failure." */
  | 'AMBIGUOUS_BY_PROVIDER_STATEMENT'
  /** A code whose meaning lives in free text, where the text matched nothing known. */
  | 'AMBIGUOUS_FAILURE_REASON_TEXT'
  | 'HAWKVIEW_SYNTHETIC_ERROR_CODE'
  | 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON'
  /** Audit path: the operation and the result code describe different outcomes. */
  | 'INCONSISTENT_OPERATION_AND_CODE';

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
 * Technician-facing labels. Exhaustive by construction.
 *
 * Wording rule: an out-of-scope label says what the event WAS. It must never
 * suggest that collection is incomplete or that anything needs chasing.
 */
export const OUT_OF_SCOPE_LABELS: Readonly<Record<OutOfScopeReason, string>> = {
  KEEP_ME_SIGNED_IN: 'Keep-me-signed-in prompt, which Microsoft documents as an expected part of the sign-in flow',
  INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN: 'Existing session was insufficient for silent sign-in, which Microsoft documents as expected',
  MICROSOFT_RISK_VERDICT: 'Microsoft blocked this sign-in as high-confidence risk; shown under Microsoft-reported risk, not as a HawkView finding',
  NON_INTERACTIVE_SIGN_IN: 'Background sign-in rather than a person entering a credential',
  APPLICATION_ACTOR: 'The actor was an application or service principal, not a person',
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
  RECOGNIZED_BUT_EXCLUSION_UNCITED: 'HawkView recognises this result code but has no documented basis for ruling it out of scope, so it is neither acted on nor dismissed',
  AMBIGUOUS_BY_PROVIDER_STATEMENT: 'Microsoft states this code alone does not indicate a failure, so HawkView will not read one into it',
  AMBIGUOUS_FAILURE_REASON_TEXT: 'This code carries several meanings in its description text, and the text did not match any meaning HawkView knows',
  HAWKVIEW_SYNTHETIC_ERROR_CODE: 'Result code was generated by HawkView’s own fallback path, not by Microsoft',
  SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON: 'Reported as a success but carried an unrecognised description, so HawkView will not call it a success',
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
export function describeUnknown(observation: UnknownObservation): string {
  return UNKNOWN_LABELS[observation];
}
export function describeUnprocessable(reason: UnprocessableReason): string {
  return UNPROCESSABLE_LABELS[reason];
}
