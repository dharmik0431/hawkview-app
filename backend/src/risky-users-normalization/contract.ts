import type {
  CollectionScope,
  OutOfScopeReason,
  UncitedReason,
  UnknownObservation,
  UnprocessableReason,
  UnselectedRowReason,
} from './reasons.js';

/**
 * The seam between collection/storage and the Risky Users evaluation core.
 *
 * In:  raw `sign_in_logs` rows plus `directory_users` rows, and one selected feed.
 * Out: normalized events, each classified into exactly one of four buckets,
 *      plus independent tallies and a coverage statement.
 *
 * Two invariants are expressed in the types rather than in comments:
 *
 *  1. `outcome` is reachable only inside `APPLIES`. You cannot read a
 *     credential verdict off an event that is out of scope or unrecognized;
 *     that is a type error, not a convention.
 *
 *  2. There is no aggregate readiness flag and no `gapCount`. Nothing in this
 *     batch is a state the evaluation core can branch on to skip a rule.
 *     Unknown and unprocessable rows reduce stated coverage and do nothing
 *     else. That is the whole reason the predecessor produced 1,054
 *     evaluation runs and zero findings: a single unrecognized event vetoed
 *     a rule.
 */

export type NormalizationSource = 'GRAPH_SIGN_INS' | 'M365_AUDIT_STS';

/**
 * What happened to the credential.
 *
 * The three-state shape the predecessor had — invalid / success /
 * everything-else — cannot express "the password was accepted and the sign-in
 * did not complete", which is the basis of the highest-value detector
 * available without Entra ID P2. Microsoft states the inference itself: "the
 * password is correct, but that strong authentication is required… could
 * indicate the user's password is compromised and the bad actor is unable to
 * fulfil MFA." Microsoft's own password-spray code set notably EXCLUDES 50126
 * for this reason: the failure storm identifies the attack, the post-password
 * interrupts identify the victims whose passwords are now known.
 *
 * The interrupt family is split three ways rather than collapsed, because
 * 50076 (challenge issued) and 50074 (challenge NOT passed) are one digit
 * apart and mean different things, and 50074 is the single highest-value code
 * in the catalogue. Detectors that want the whole family should call
 * `isPostPasswordInterrupt` rather than re-encode the distinction.
 */
export type EventOutcome =
  /** 50126. The password was not accepted. Attack evidence in aggregate only. */
  | 'PASSWORD_REJECTED'
  /** 0. Accepted, and the sign-in completed. */
  | 'PASSWORD_ACCEPTED_COMPLETED'
  /** 50076. Accepted; a second-factor challenge was issued. */
  | 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED'
  /** 50074, 500121. Accepted; the second factor was NOT passed. */
  | 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED'
  /** 50072, 50079. Accepted; the account has no usable second factor registered. */
  | 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED'
  /** Conditional Access, device and policy blocks. A control stopped the sign-in. */
  | 'BLOCKED_BY_CONTROL'
  /** 50053 smart lockout. Implies VARIED wrong passwords — see provider-facts. */
  | 'LOCKED_OUT_AFTER_REPEATED_FAILURES'
  /** 50057. An attempt against an account that is disabled. */
  | 'DISABLED_ACCOUNT_ATTEMPT';

/** True when Microsoft's result code establishes that the password itself was accepted. */
export function passwordWasAccepted(outcome: EventOutcome): boolean {
  return (
    outcome === 'PASSWORD_ACCEPTED_COMPLETED' ||
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' ||
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' ||
    outcome === 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED'
  );
}

/**
 * The post-password interrupt family: the password was accepted and the
 * sign-in did not complete. Provided so a detector groups the family by
 * calling this rather than by listing result codes of its own.
 */
export function isPostPasswordInterrupt(outcome: EventOutcome): boolean {
  return passwordWasAccepted(outcome) && outcome !== 'PASSWORD_ACCEPTED_COMPLETED';
}

/**
 * How the event was bound to a directory user. Recorded explicitly so a
 * technician can see that a UPN-bound finding rests on weaker evidence than a
 * GUID-bound one, rather than having the two implied to be equivalent: a UPN
 * can be reassigned after a user is deleted, so a historical event can bind to
 * the wrong person.
 */
export type SubjectBindingMethod = 'DIRECTORY_OBJECT_ID' | 'NORMALIZED_UPN';

/**
 * Client-source qualification.
 *
 * THREE values, not two. 'MISSING' previously collapsed two different facts:
 * the provider did not report an address, and the provider reported something
 * this layer could not read. That is the same
 * unknown-folded-into-a-definite-answer shape found three times elsewhere in
 * this workstream — coverage booleans, the classification table, and the
 * collector's own success flag — and it was in my own layer, found only by
 * deliberately looking for it after the third instance.
 *
 * The distinction is not cosmetic for a consumer: 'NOT_REPORTED' is a limit on
 * what Microsoft gave us, while 'UNREADABLE' is a data-quality signal about
 * what it gave us. Any detector keyed on client address needs to tell those
 * apart before treating an absent address as a coverage gap.
 *
 * 'AMBIGUOUS' and 'PROXY_ONLY' existed in the predecessor contract with no
 * grounded predicate behind them and remain deliberately absent.
 */
export type ClientQualification = 'QUALIFIED' | 'NOT_REPORTED' | 'UNREADABLE';

/**
 * Exactly one per event.
 *
 * `NOT_YET_CITED` is a sibling of `UNKNOWN` rather than a reason inside it,
 * because "our vocabulary has a hole" and "our paperwork has a hole" are
 * different facts with different urgency — and because a `switch` over these
 * four forces a consumer to decide about the paperwork case rather than
 * sweeping it into a gate by default.
 */
export type EventClassification =
  | { readonly kind: 'APPLIES'; readonly outcome: EventOutcome }
  | { readonly kind: 'DOES_NOT_APPLY'; readonly reason: OutOfScopeReason }
  | { readonly kind: 'NOT_YET_CITED'; readonly reason: UncitedReason }
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
  readonly subjectBinding: SubjectBindingMethod;
  readonly applicationRef: string;
  /**
   * Microsoft's result code, as reported, or null.
   *
   * DO NOT RENDER GRAPH AND AUDIT CODES AS ONE CODE SPACE. On the Graph feed
   * this is an AADSTS sign-in error code. On the audit feed it is whatever the
   * record carried in `LoginStatus` or `ErrorCode`, and whether those are one
   * vocabulary or two is an open question — see the `audit.result-code-vocabulary`
   * predicate. Until it is settled, `source` is the field that tells a consumer
   * which reading applies, and a "1" beside a "50126" may not be the same kind
   * of number.
   *
   * Classification does not depend on this: the audit path keys on the reason
   * name and uses the code only as corroboration.
   */
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

/**
 * One collected `directory_users` row.
 *
 * NOTE the deliberate absence of the `sign_in_logs.user_id` COLUMN anywhere in
 * this layer. Measured in production, that column is GUID-shaped on
 * essentially every row, matches no directory user on any row, and is MORE
 * granular than the actual user (one tenant: 6 distinct column GUIDs against 2
 * distinct real users across 950 rows). It looks synthesized rather than
 * sourced. Subjects bind from the raw payload only.
 */
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
 * Distributions for payload-shape claims, emitted as a by-product of a normal
 * run so a distribution check is a run of this code rather than a bespoke
 * production query, and so a shape that has been confirmed once is watched for
 * drift rather than assumed forever.
 *
 * `graphIsInteractiveAmongCredentialFailures` is the CONTROL COHORT for the
 * `isInteractive === false` predicate: rows carrying a documented
 * invalid-credential code are unambiguously human interactive sign-ins.
 */
export interface ShapeObservations {
  readonly graphErrorCodeShape: Readonly<Record<ErrorCodeShape, number>>;
  readonly graphIsInteractive: Readonly<Record<IsInteractiveShape, number>>;
  readonly graphIsInteractiveAmongCredentialFailures: Readonly<Record<IsInteractiveShape, number>>;
  /**
   * Rows that failed subject resolution while carrying a documented
   * username-enumeration code (50034, 51004).
   *
   * A KNOWN BLIND SPOT made visible rather than left as a comment. Those codes
   * describe a subject that is by definition not in the directory, so subject
   * resolution discards the row before classification runs and the code is
   * lost. Microsoft names clusters of them from one address as directory
   * probing — a tenant-level finding, where this whole model is user-scoped —
   * so detecting it is a different detector shape and not this layer's to
   * build. This counter is what keeps its absence from being invisible.
   */
  readonly enumerationCodesOnUnresolvedSubjects: number;
}

export interface NormalizationCounts {
  /** Rows handed to this layer, including rows from the unselected feed. */
  readonly rows: number;
  readonly applies: number;
  readonly doesNotApplyByReason: Readonly<Record<OutOfScopeReason, number>>;
  /** Understood, exclusion not yet established. Disclosed; never a gate. */
  readonly notYetCitedByReason: Readonly<Record<UncitedReason, number>>;
  readonly unknownByObservation: Readonly<Record<UnknownObservation, number>>;
  readonly unprocessableByReason: Readonly<Record<UnprocessableReason, number>>;
  /** How the events that did bind were bound, so weaker bindings are visible. */
  readonly bindingMethods: Readonly<Record<SubjectBindingMethod, number>>;
  /**
   * Rows that were never part of the assessed scope, BY REASON.
   *
   * Independent feeds are never pooled, so these rows are not evaluated — and
   * they are neither a defect nor a scope decision, so they get their own
   * vocabulary rather than being silently skipped (the predecessor's
   * `continue`) or folded into one of the three above.
   *
   * A reason map rather than a bare number because "we never looked" needs to
   * be distinguishable from "we looked and declined": a consumer must be able
   * to tell a feed boundary (harmless) from a scope narrowing (which, by the
   * verification rule, should not be happening at all). There is exactly one
   * member, and that is the answer.
   */
  readonly unselectedRowsByReason: Readonly<Record<UnselectedRowReason, number>>;
}

/**
 * Coverage is counts, not a ratio and not a gate.
 *
 * `recognizedRows / consideredRows` is the honest stated coverage: the share
 * of the selected feed HawkView could actually say something about. A zero
 * finding count is only honest when reported against this scope.
 */
export interface NormalizationCoverage {
  /**
   * What the collector asked the provider for.
   *
   * First field on purpose: every other number here is a share of what was
   * collected, and that is only meaningful alongside what was requested. A
   * consumer rendering coverage always has it, because it cannot obtain the
   * rest without it.
   */
  readonly collectionScope: CollectionScope;
  /** Rows from the selected feed. Excludes `unselectedRowsByReason`. */
  readonly consideredRows: number;
  /** Rows that produced an event, in any classification. */
  readonly normalizedRows: number;
  /**
   * Rows HawkView could name the meaning of: applies + does-not-apply +
   * not-yet-cited. The last of those is included deliberately — we did read
   * those events correctly; what is missing is our own basis for excluding
   * them, which is not a limit on our reading of the data.
   */
  readonly recognizedRows: number;
}

export interface NormalizationBatch {
  readonly scope: NormalizationScope;
  readonly source: NormalizationSource;
  /** Every normalized row, in all three classifications, sorted by `eventAt` then `eventId`. */
  readonly events: readonly NormalizedEvent[];
  /** The subset HawkView's own detectors act on. Same ordering. */
  readonly applies: readonly NormalizedEvent[];
  /**
   * Events where Microsoft judged the sign-in RISKY, kept OUT of `applies` and
   * surfaced separately.
   *
   * Classified DOES_NOT_APPLY / MICROSOFT_RISK_VERDICT, because the owner's
   * product rule is that HawkView's own findings and Microsoft's reported risk
   * are two evidence channels that are never merged or summed. A verdict
   * Microsoft reached is not a HawkView finding. It is still the only
   * Microsoft risk signal an unlicensed tenant will ever see, so it is exposed
   * here rather than buried in a counter.
   */
  readonly microsoftRiskVerdicts: readonly NormalizedEvent[];
  /**
   * Events where Microsoft judged the sign-in SAFE — a dismissal, not a
   * detection.
   *
   * A SEPARATE list rather than a flag on the one above, because the failure
   * mode is specific and one-directional: a safety verdict rendered in a
   * "risky users" view says "this user is at risk" when Microsoft said the
   * opposite. Two lists make that impossible to do by accident, and a test
   * asserts nothing appears in both.
   *
   * Empty today: populating it means reading `riskDetail`, which has no
   * control cohort yet.
   */
  readonly microsoftSafetyVerdicts: readonly NormalizedEvent[];
  /** Reference-to-identifier mapping for subjects that resolved, kept off the events. */
  readonly resolvedSubjects: readonly {
    readonly subjectRef: string;
    readonly microsoftUserId: string;
    readonly binding: SubjectBindingMethod;
  }[];
  readonly counts: NormalizationCounts;
  readonly coverage: NormalizationCoverage;
  readonly shapeObservations: ShapeObservations;
}

/**
 * The batch's tallies in the shape the evaluation core consumes, plus the one
 * derived number it needs to gate honestly.
 *
 * One mapping in one place, for the same reason the sort lives here: two
 * mappings drift.
 *
 * `uninterpretedEvents` is the number to gate a clean claim on — events we
 * could not read, plus rows we could not process. `notYetCited` is reported
 * beside it and deliberately NOT included: those events were read correctly
 * and only our own basis for excluding them is missing, so gating on them
 * would let a handful of well-understood consent prompts withhold a tenant's
 * claim indefinitely. Everything here is disclosed; only some of it is a limit
 * on what we read.
 */
export function coverageForEvaluation(batch: NormalizationBatch): {
  readonly applies: number;
  readonly doesNotApply: Readonly<Record<OutOfScopeReason, number>>;
  readonly notYetCited: Readonly<Record<UncitedReason, number>>;
  readonly unknown: Readonly<Record<UnknownObservation, number>>;
  readonly unprocessable: Readonly<Record<UnprocessableReason, number>>;
  readonly uninterpretedEvents: number;
  readonly notYetCitedEvents: number;
} {
  const { counts } = batch;
  const sum = (values: Readonly<Record<string, number>>) =>
    Object.values(values).reduce((total, value) => total + value, 0);
  return {
    applies: counts.applies,
    doesNotApply: counts.doesNotApplyByReason,
    notYetCited: counts.notYetCitedByReason,
    unknown: counts.unknownByObservation,
    unprocessable: counts.unprocessableByReason,
    uninterpretedEvents: sum(counts.unknownByObservation) + sum(counts.unprocessableByReason),
    notYetCitedEvents: sum(counts.notYetCitedByReason),
  };
}

export interface NormalizeBatchOptions {
  readonly scope: NormalizationScope;
  /** Exactly one selected feed. Independent feeds are never pooled. */
  readonly source: NormalizationSource;
  readonly rows: readonly SignInRow[];
  readonly directory: readonly DirectoryUserRow[];
  readonly reference: ReferenceResolver;
  /**
   * REQUIRED. What the collector asked the provider for — see CollectionScope.
   * Required rather than defaulted so that a caller which does not know has to
   * say `UNDECLARED` out loud instead of having a default assert on its behalf.
   */
  readonly collectionScope: CollectionScope;
}

/** Per-run bounds. Exceeding one costs the excess rows, never the run. */
export const MAX_ROWS_PER_RUN = 10_000;
export const MAX_DISTINCT_REFERENCES = 4_000;
