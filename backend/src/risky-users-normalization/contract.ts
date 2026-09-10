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
  | 'DISABLED_ACCOUNT_ATTEMPT'
  /**
   * 50055, 50144. The password was submitted, VALIDATED, and then the session
   * ended on the expiry policy.
   *
   * Deliberately NOT in the post-password interrupt family, and deliberately
   * not named after it. The interrupt family's value is "the credential was
   * correct AND an attacker-resistant control stopped them" — the second
   * factor is what does the work. This is "the credential was correct AND a
   * password policy stopped them", and a password policy is not
   * attacker-resistant: the change flow typically needs only the old password,
   * which whoever submitted it already has.
   *
   * That cuts both ways, and both halves matter. WEAKER than a genuine MFA
   * interrupt as evidence a control held — nothing held, and the holder can
   * likely rotate the credential themselves. STRONGER than hygiene, because it
   * establishes the same fact the interrupt family exists to establish:
   * somebody submitted a working password for this account.
   *
   * FOR WHOEVER BUILDS ON IT: the discriminator is location, not the code. From
   * a familiar location this is almost always the legitimate user meeting a
   * policy — high volume, no signal. From an unfamiliar location, or an address
   * that also produced 50126 storms, it means somebody other than the user
   * holds a working credential. Expired passwords are overwhelmingly ordinary
   * users, so this must corroborate rather than alarm on its own.
   */
  | 'CREDENTIAL_CONFIRMED_VALID';

/** True when Microsoft's result code establishes that the password itself was accepted. */
export function passwordWasAccepted(outcome: EventOutcome): boolean {
  return (
    outcome === 'PASSWORD_ACCEPTED_COMPLETED' ||
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' ||
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' ||
    outcome === 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED' ||
    outcome === 'CREDENTIAL_CONFIRMED_VALID'
  );
}

/**
 * The post-password interrupt family: the password was accepted and an
 * attacker-resistant control stopped the sign-in. Provided so a detector
 * groups the family by calling this rather than by listing result codes.
 *
 * MEMBERSHIP IS EXPLICIT, not derived as "accepted and not completed". That
 * derivation was an EXCLUSION definition, and exclusion definitions absorb new
 * members: adding CREDENTIAL_CONFIRMED_VALID would silently have joined this
 * family and lent it a claim about a control that held, when nothing held. The
 * same shape as every other defect in this module — a new case quietly
 * inheriting a definite answer — so the list is stated rather than inferred.
 */
export function isPostPasswordInterrupt(outcome: EventOutcome): boolean {
  return (
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED' ||
    outcome === 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED' ||
    outcome === 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED'
  );
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
 * Whether a feed can produce an outcome at all, and whether it ever has.
 *
 * TWO CLAIMS, kept apart, because collapsing them is this workstream's
 * recurring defect in a new place. "No mapping exists on this feed" and
 * "a mapping exists and no row has matched it" are different facts, and a
 * consumer deciding whether a rule can run needs the first while a consumer
 * asking what the data has shown needs the second.
 */
export type OutcomeReachability =
  /**
   * A mapping exists on this feed AND rows have been measured producing it.
   */
  | 'MAPPED_AND_OBSERVED'
  /**
   * A mapping exists on this feed and zero rows have been measured producing
   * it. A rule needing this outcome is APPLICABLE — a quiet window is not an
   * incapable feed — but a zero result over this evidence says less than the
   * same zero over an observed outcome.
   */
  | 'MAPPED_NOT_OBSERVED'
  /**
   * NO route to this outcome exists on this feed. Not rare: impossible. A
   * rule whose pattern needs it cannot fire here no matter what the tenant
   * does, and reporting a clean zero for it is the failure this exists to
   * prevent.
   */
  | 'UNREACHABLE';

/**
 * Microsoft's own judgement about a sign-in, as a dimension ORTHOGONAL to
 * classification.
 *
 * It is not a classification, and that is the whole design. Splitting the
 * event from the judgement is what lets both channels read the same log line
 * independently:
 *
 *  - The OBSERVATION (a sign-in happened, at this time, by this subject, with
 *    this outcome) is a fact from the same log that gives us every other
 *    event. It classifies normally and feeds our rules.
 *  - The VERDICT is Microsoft's conclusion. It never enters a HawkView
 *    finding, never contributes to our count, and never appears as a reason.
 *
 * The channel rule is not violated by one event being evidence in both: two
 * analysts reading the same log line and reaching independent conclusions is
 * not merging, it is the point of running two channels, and it is what makes
 * agreement between them mean anything.
 *
 * THE GUARANTEE IS STRUCTURAL, NOT A CONVENTION. This never appears on
 * NormalizedEvent, so a detector iterating the applies list cannot read it
 * even by accident, and a HawkView finding cannot cite Microsoft's judgement.
 * Verdicts reach a consumer only through the batch-level lists.
 *
 * Treating the verdict as a classification, and so removing judged events
 * from evaluation, was the earlier design and was wrong three ways: it went
 * silent on the most suspicious pattern the data can hold (failures then a
 * success Microsoft independently thought worth challenging); it made our
 * findings anti-correlated with real risk, invisibly; and it made
 * detected-by-both structurally rarest exactly where it is most valuable.
 */
export type MicrosoftVerdict =
  /**
   * Microsoft judged the sign-in risky.
   *
   * Reaches us three ways without the risk API: sign-in log failure reasons,
   * code 53004, and riskDetail.
   */
  | 'RISK'
  /**
   * Microsoft detected risk, a control the tenant configured responded, and
   * the sign-in completed. Detected, handled, closed.
   *
   * A third value rather than a shade of the other two, because it is
   * neither: RISK would overstate it as live, SAFE would understate it as
   * never-risky. Measured shape: riskDetail
   * `userPassedMFADrivenByRiskBasedPolicy` with riskState `remediated`.
   *
   * Still Microsoft's judgement under the attribution rule — attribute by
   * whose judgement GENERATED the assessment, not whose machinery responded
   * to it. A risk-based Conditional Access policy is the tenant's machinery
   * responding to Microsoft's judgement.
   */
  | 'REMEDIATED'
  /**
   * Microsoft assessed the sign-in and judged it SAFE. A dismissal, not a
   * detection.
   *
   * Separate from RISK because conflating them is misleading in the one
   * direction that matters: Microsoft's AI concluding "we looked and this is
   * fine" must never render as "this user is at risk". Measured shape:
   * riskDetail `aiConfirmedSigninSafe` with riskState `dismissed` — and note
   * the trap Microsoft's own vocabulary sets, since system auto-remediation
   * also lands on `dismissed`, so this is a machine assessment rather than a
   * human waving something away.
   */
  | 'SAFE';

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
   * Microsoft's verdicts seen, by kind, plus values we could not read.
   *
   * An ORTHOGONAL dimension rather than a fifth bucket: every event counted
   * here is also counted in one of the four vocabularies, because the verdict
   * does not decide whether our detectors act.
   *
   * DO NOT SUM THIS WITH THE FOUR, and the concrete failure is worth naming
   * because a summary card is exactly where it happens: on a tenant where
   * ~921 rows carry a RISK verdict, a total built by adding all five reads
   * about 35% higher than the number of rows handed in, and it would look
   * plausible. The four vocabularies account for every row exactly once and a
   * test asserts it; this is a second reading of some of those same rows.
   */
  readonly microsoftVerdicts: Readonly<Record<MicrosoftVerdict | 'UNRECOGNIZED', number>>;
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
  /**
   * Rows not evaluated because the subject is not in this tenant.
   *
   * A PROJECTION of two entries in `unprocessableByReason`
   * (SUBJECT_NOT_IN_DIRECTORY and SUBJECT_UPN_NOT_IN_DIRECTORY), not an
   * additional bucket — do not add it to the tallies or it double-counts.
   *
   * It is in the coverage statement rather than left internal because these
   * rows previously vanished with nothing recorded, which is this feature's
   * signature defect in its purest form: evidence dropped, no trace, and a
   * confident answer computed from what is left. A screen can now say "N
   * events were not evaluated because the subject is not in this tenant",
   * which converts an invisible loss into a stated limit.
   */
  readonly subjectNotInTenantRows: number;
  /**
   * Of those, how many carried a documented username-enumeration code.
   *
   * Non-zero means real enumeration evidence is being discarded upstream of
   * any detector — the codes describe a subject that by definition is not in
   * the tenant, so subject resolution drops the row before classification.
   * Detecting directory probing needs a tenant-level finding where this model
   * is user-scoped, which is a scope decision and not this layer's to make.
   * The number exists so the gap is visible while that is decided.
   */
  readonly enumerationCodedRows: number;
}

export interface NormalizationBatch {
  readonly scope: NormalizationScope;
  readonly source: NormalizationSource;
  /** Every normalized row, in all three classifications, sorted by `eventAt` then `eventId`. */
  readonly events: readonly NormalizedEvent[];
  /** The subset HawkView's own detectors act on. Same ordering. */
  readonly applies: readonly NormalizedEvent[];
  /**
   * Events carrying Microsoft's RISK verdict.
   *
   * These events also classify normally and may appear in the applies list:
   * the observation is ours, the verdict is Microsoft's. The events here
   * carry no verdict field, so reading this list is the only way to learn
   * what Microsoft concluded.
   *
   * The owner's product rule — HawkView's own findings and Microsoft's
   * reported risk are two evidence channels that are never merged or summed —
   * is honoured by keeping the verdict off the event rather than by removing
   * the event from evaluation. Microsoft's conclusion cannot enter a HawkView
   * finding because no detector can read it; and it is the only Microsoft risk
   * signal an unlicensed tenant will ever see, so it is exposed here rather
   * than buried in a counter.
   */
  readonly microsoftRiskVerdicts: readonly NormalizedEvent[];
  /**
   * Events where Microsoft DETECTED risk, the tenant's own policy responded,
   * and the sign-in completed. Detected, handled, closed.
   *
   * A third list rather than a flag on either of the others, for the same
   * reason there are two: a consumer can ignore a flag but cannot iterate a
   * list it does not have. These map onto the frontend's CLOSED group, while
   * `microsoftSafetyVerdicts` maps onto CLEARED and `microsoftRiskVerdicts`
   * onto ACTIVE_RISK.
   */
  readonly microsoftRemediatedVerdicts: readonly NormalizedEvent[];
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
   * Populated from `riskDetail`, whose control cohort now passes.
   */
  readonly microsoftSafetyVerdicts: readonly NormalizedEvent[];
  //
  // THE THREE LISTS ARE DISJOINT PER EVENT, NOT PER SUBJECT.
  //
  // One verdict per event, and a test asserts no event reaches two lists. But
  // a subject has many events, and nothing stops one person having a RISK
  // verdict on Tuesday and a SAFE verdict on Thursday — both true, about
  // different sign-ins.
  //
  // So a surface that groups BY USER has a case this layer does not decide
  // for it: a user who belongs in two groups at once. Picking the worst
  // verdict, the latest, or showing the user twice are all defensible, and
  // they are rendering decisions rather than facts about the data — which is
  // why this says the shape rather than choosing. What is NOT defensible is
  // reaching for one of them without noticing the case exists, because the
  // failure is silent and lands in the direction that reads as reassurance.
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
