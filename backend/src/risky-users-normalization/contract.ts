import type {
  OutOfScopeReason,
  UnknownObservation,
  UnprocessableReason,
} from './reasons.js';

/**
 * The seam between collection/storage and the Risky Users evaluation core.
 *
 * Input:  raw `sign_in_logs` rows plus `directory_users` rows.
 * Output: normalized events, each classified into exactly one of three
 *         buckets, plus three independent tallies.
 *
 * Two invariants are expressed in the types rather than in comments:
 *
 *  1. `outcome` is reachable only inside `APPLIES`. You cannot read a
 *     credential verdict off an event that is out of scope or unrecognized;
 *     that is a type error, not a convention. The predecessor's single
 *     `AuthOutcome` union mixed 'SUCCESS' with 'NON_QUALIFYING' and
 *     'UNKNOWN', which is how "out of scope" and "unrecognized" became
 *     indistinguishable.
 *
 *  2. There is no aggregate readiness flag and no `gapCount`. Nothing in this
 *     batch is a state the evaluation core can branch on to skip a rule.
 *     Unknown and unprocessable rows reduce stated coverage and do nothing
 *     else. That is the whole reason the feature produced 1,054 evaluation
 *     runs and zero findings: a single unrecognized event vetoed a rule.
 */

export type NormalizationSource = 'GRAPH_SIGN_INS' | 'M365_AUDIT_STS';

/** Credential facts only. Anything that is not a credential verdict is not an outcome. */
export type EventOutcome = 'INVALID_CREDENTIAL' | 'SUCCESS';

/**
 * Client-source qualification. Only the two values this layer can actually
 * substantiate are declared: an address that canonicalises, or one that does
 * not. 'AMBIGUOUS' and 'PROXY_ONLY' existed in the predecessor contract with
 * no grounded predicate behind them and are deliberately absent.
 */
export type ClientQualification = 'QUALIFIED' | 'MISSING';

export type EventClassification =
  | { readonly kind: 'APPLIES'; readonly outcome: EventOutcome }
  | { readonly kind: 'DOES_NOT_APPLY'; readonly reason: OutOfScopeReason }
  | { readonly kind: 'UNKNOWN'; readonly observation: UnknownObservation };

export interface NormalizationScope {
  readonly organizationId: string;
  readonly customerTenantId: string;
  readonly microsoftTenantId: string;
}

export interface NormalizedEvent extends NormalizationScope {
  readonly source: NormalizationSource;
  readonly eventId: string;
  /** ISO-8601 UTC, millisecond precision. */
  readonly eventAt: string;
  readonly ingestedAt: string;
  /** Protected reference to the resolved directory user. Never a raw identifier. */
  readonly subjectRef: string;
  readonly applicationRef: string;
  readonly errorCode: number | null;
  readonly clientSource: {
    readonly qualification: ClientQualification;
    readonly address: string | null;
  };
  readonly classification: EventClassification;
}

/** One stored `sign_in_logs` row, as read by the loader. */
export interface SignInRow {
  readonly organizationId: string;
  readonly customerTenantId: string;
  readonly raw: unknown;
  readonly ingestedAt: Date;
}

/** One collected `directory_users` row. Binding is by `microsoftUserId` only. */
export interface DirectoryUserRow {
  readonly organizationId: string;
  readonly customerTenantId: string;
  readonly microsoftUserId: string;
  readonly userPrincipalName: string;
  readonly userType: string | null;
}

/**
 * Produces the protected reference for a resolved identifier. Injected rather
 * than optional: making it required is what keeps a raw customer GUID from
 * reaching the evaluation core through an accidentally-unpseudonymised path.
 */
export type ReferenceResolver = (
  kind: 'subject' | 'application',
  identifier: string,
) => Promise<string>;

/** Observed JSON shape of `raw.status.errorCode` on Graph rows. */
export type ErrorCodeShape =
  | 'NUMBER'
  | 'NUMERIC_STRING'
  | 'OTHER_STRING'
  | 'NULL'
  | 'ABSENT'
  | 'OTHER_TYPE';

/** Observed JSON shape of `raw.isInteractive` on Graph rows. */
export type IsInteractiveShape =
  | 'TRUE'
  | 'FALSE'
  | 'NULL'
  | 'ABSENT'
  | 'OTHER_TYPE';

/**
 * Distributions for the payload-shape predicates this layer has NOT yet had
 * confirmed against real provider data, emitted as a by-product of a normal
 * run so the required distribution check is a run of this code rather than a
 * bespoke production query.
 *
 * `graphIsInteractiveAmongCredentialFailures` is the CONTROL COHORT for the
 * `isInteractive === false` predicate: rows carrying a documented
 * invalid-credential code are unambiguously human interactive sign-ins, so if
 * they report FALSE or ABSENT then the predicate is wrong or inert and must
 * not be used to exclude anything.
 */
export interface ShapeObservations {
  readonly graphErrorCodeShape: Readonly<Record<ErrorCodeShape, number>>;
  readonly graphIsInteractive: Readonly<Record<IsInteractiveShape, number>>;
  readonly graphIsInteractiveAmongCredentialFailures: Readonly<Record<IsInteractiveShape, number>>;
}

export interface NormalizationCounts {
  /** Rows handed to this layer, including rows from the unselected feed. */
  readonly rows: number;
  readonly applies: number;
  readonly doesNotApplyByReason: Readonly<Record<OutOfScopeReason, number>>;
  readonly unknownByObservation: Readonly<Record<UnknownObservation, number>>;
  readonly unprocessableByReason: Readonly<Record<UnprocessableReason, number>>;
  /**
   * Rows belonging to the feed that was not selected for this evaluation.
   * Independent feeds are never pooled, so these rows are not evaluated — but
   * they are neither a defect nor a scope decision, so they get their own
   * counter instead of being silently skipped (the predecessor's `continue`)
   * or folded into either reason vocabulary.
   */
  readonly unselectedSourceRows: number;
}

/**
 * Coverage is three counts, not a ratio and not a gate.
 *
 * `recognizedRows / consideredRows` is the honest stated coverage: the share
 * of the selected feed HawkView could actually say something about. A zero
 * finding count is only honest when reported against this scope.
 */
export interface NormalizationCoverage {
  /** Rows from the selected feed. Excludes `unselectedSourceRows`. */
  readonly consideredRows: number;
  /** Rows that produced an event, i.e. applies + does-not-apply + unknown. */
  readonly normalizedRows: number;
  /** Rows HawkView could name the meaning of, i.e. applies + does-not-apply. */
  readonly recognizedRows: number;
}

export interface NormalizationBatch {
  readonly scope: NormalizationScope;
  readonly source: NormalizationSource;
  /** Every normalized row, in all three classifications, sorted by `eventAt` then `eventId`. */
  readonly events: readonly NormalizedEvent[];
  /** The subset the detectors act on. Same ordering. */
  readonly applies: readonly NormalizedEvent[];
  /** Reference-to-identifier mapping for subjects that resolved, kept off the events. */
  readonly resolvedSubjects: readonly { readonly subjectRef: string; readonly microsoftUserId: string }[];
  readonly counts: NormalizationCounts;
  readonly coverage: NormalizationCoverage;
  readonly shapeObservations: ShapeObservations;
}

/** Per-run bounds. Exceeding one costs the excess rows, never the run. */
export const MAX_ROWS_PER_RUN = 10_000;
export const MAX_DISTINCT_REFERENCES = 4_000;
