/** THE SEAM between the Risky Users engine and the alert queue. Types only, deliberately.
 *
 * The engine produces findings every five minutes and tells nobody. Steps 02 and 03 built
 * the queue; step 04 wires them together. This file is the shape of that wiring's input and
 * output, written BEFORE the wiring, because a seam that cannot express a property cannot
 * pin it — and discovering that after the code exists means rewriting both.
 *
 * WRITTEN WITHOUT READING THE REFERENCE WIRING IN QA'S CONTRACT. Their pre-registration is
 * only independent if it was not the specification I built from; a check that shares an
 * origin with what it checks agrees by construction, and it does not matter whether the
 * shared origin arrived as a bug or as a helpful example. The vocabulary below comes from
 * steps 01-03 and from the `IdentityRiskFinding` model.
 */

import type { ResolvedSubject } from './alert-incident-key.js'
import type { EventInstant } from './alert-event-time.js'

/** How complete the evidence was when the engine reached its verdict.
 *
 * The engine's own three values, not a reduction of them. Carried through the seam rather
 * than dropped, because a finding reached on PARTIAL evidence and one reached on FULL are
 * different claims, and a queue that shows only the verdict invites a reader to act on the
 * weaker one as though it were the stronger. */
export type FindingCoverage = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'

/** A finding exactly as the engine emits it — the producer's shape, field for field from
 * `IdentityRiskFinding`, including the fields the queue has no use for.
 *
 * DELIBERATELY NOT WHAT A CONSUMER WOULD FIND CONVENIENT. A seam that accepts a tidied-up
 * struct pushes the tidying into the producer, and the tidying is where a field quietly
 * stops being carried. `observedAt` stays a bare `Date` here because that is what the
 * producer has; it becomes an `EventInstant` at the boundary below, which is the one place
 * the conversion can be reviewed. */
export interface EmittedFinding {
  readonly id: string
  readonly organizationId: string
  readonly customerTenantId: string
  readonly matchedResultId: string
  readonly dedupeKey: string
  readonly ruleId: string
  readonly ruleVersion: string
  readonly subjectType: string
  readonly subjectId: string
  readonly state: string
  readonly severity: string
  readonly confidence: string
  readonly coverage: FindingCoverage
  /** The event's OWN time. Becomes the queue's `EventInstant`; see `IntakeRun.completedAt`. */
  readonly observedAt: Date
  readonly expiresAt: Date
}

/** ONE RUN OF THE ENGINE, AND WHETHER IT GOT THERE.
 *
 * A SEQUENCE OF RUNS RATHER THAN A LIST OF FINDINGS, because absence is the point. "This
 * finding was emitted and then stopped" and "this finding was never emitted" are the same
 * input to a flat list, and the difference between them is the whole of the
 * absence-does-not-clear rule. Only a run that HAPPENED and did not emit something is
 * evidence of anything.
 *
 * AND A FAILED RUN IS NOT AN EMPTY ONE. This is the same distinction one level up, and it
 * is the one that would have hurt: if a failure arrives as `emitted: []`, then a crashed
 * engine is indistinguishable from an engine reporting that everything is fine — and the
 * rule about to be evaluated against that input is precisely the one deciding whether
 * absence clears an incident. An engine that dies would close every open incident in the
 * queue, quietly, and the only trace would be a gap nobody was counting.
 *
 * So the variants are separate and a consumer must handle both to compile. */
/** A DISCRIMINATED UNION ONLY FORCES A BRANCH WHERE THE FIELD DIFFERS BETWEEN ARMS.
 *
 * Both arms first carried `at`, which left the hole one field over from the one the union
 * closed: the freshness marker — the exact value the staleness property is about — could be
 * computed across every run with no branch, no discriminant and no error, counting a failed
 * run as evidence the engine is healthy. The defect made unwriteable and its sibling one
 * field over were reachable through the same type.
 *
 * So the times are named per arm. A consumer reaching for a time has to say which kind it
 * meant, which is the forcing function the union already applied to `emitted`, moved onto
 * the field a hurried consumer actually touches.
 *
 * THERE IS ONE LEGITIMATE CONSUMER OF "when did a run arrive, whatever its outcome", and it
 * is not freshness — it is LIVENESS: "the scheduler is firing but every run fails" and "the
 * scheduler is dead" are different conditions with different remedies, and only the second
 * is fixed by restarting a schedule. That consumer gets `QueueState.lastRunAttemptedAt`,
 * named for what it answers. Giving it a name is what stops it coming back as an argument
 * for a common `at`: the question is real, and reaching for the nearest Date is still the
 * wrong way to answer it. */
export type IntakeRun =
  | Readonly<{
      kind: 'COMPLETED'
      /** When the run FINISHED — arrival time, never an event time, and never the half a
       * decision is made on. It is the `receivedAt` of every instant this run produces. */
      completedAt: Date
      emitted: readonly EmittedFinding[]
    }>
  | Readonly<{
      kind: 'FAILED'
      /** When the run GAVE UP. Deliberately not the same name: a failed run says nothing
       * about whether the queue is current, and a consumer that wants the completed time
       * must now go and get it. */
      failedAt: Date
      /** Why. Carried so the unanswerable set can be measured and shrunk rather than
       * quietly accumulating — the same discipline as every other refusal in this feature. */
      because: string
    }>

/** Where an incident stands. Three values, and the middle one is the point of P3. */
export type IncidentState =
  /** Still current: the latest completed run emitted it. */
  | 'OPEN'
  /** A completed run stopped emitting it AND the queue's clearing rule was satisfied. Not
   * reachable from absence alone — see `alert-clearing.ts`. */
  | 'CLEARED'
  /** A person closed it. */
  | 'RESOLVED'

/** One notification, as a thing that can be COUNTED.
 *
 * Separate from the incident because "no second notification" is a property about
 * notifications, and an output that exposes only incidents cannot express it: a wiring that
 * notifies on every re-emission produces exactly the same incident list as one that notifies
 * once. That is the shape QA found in their own draft on the time axis, and it applies here
 * too — the seam has to carry the thing the property is about. */
export interface QueuedNotification {
  /** The incident it belongs to. */
  readonly incidentKey: string
  /** The finding that caused it, so a notification can be traced back across the seam —
   * which is what makes a cross-organisation leak observable rather than merely unlikely. */
  readonly fromFindingId: string
  readonly organizationId: string
  /** The EVENT's time, not the run's. Typed so the arrival-time version does not compile
   * by reaching for the nearer variable. */
  readonly at: EventInstant
}

/** One incident in the queue. */
export interface QueuedIncident {
  /** From step 02's `incidentGrouping`. Carries the organisation, so two organisations
   * cannot share an incident even if every other component matches. */
  readonly key: string
  readonly organizationId: string
  readonly customerTenantId: string
  /** THE ACCOUNT, as a resolved subject rather than a string, so "could not be attributed"
   * stays distinguishable from "attributed to the empty string" — and so the no-merge rule
   * step 02 already enforces is the same rule here rather than a second implementation. */
  readonly subject: ResolvedSubject
  /** The rule that fired. One incident per account-rule pair means this is part of the
   * identity, not a property of it. */
  readonly ruleId: string
  readonly state: IncidentState
  /** THE LEAST COMPLETE EVIDENCE ANY CONTRIBUTING FINDING WAS REACHED ON.
   *
   * A DESIGN DECISION, FLAGGED RATHER THAN BURIED: when re-emission changes coverage from
   * FULL to PARTIAL, this reports PARTIAL. An incident partly built on incomplete evidence
   * is not a complete one, and taking the latest would let a single good run launder every
   * earlier gap. The alternative — carry every value and let the reader decide — is
   * defensible and noisier. Reported per notification as well, so the choice is reversible
   * without losing information. */
  readonly coverage: FindingCoverage
  /** When the earliest and latest contributing EVENTS happened. Event time on both, so a
   * queue built on arrival is a different value rather than an identical one. */
  readonly firstEventAt: EventInstant
  readonly latestEventAt: EventInstant
  readonly notifications: readonly QueuedNotification[]
}

/** What the queue looks like after a sequence of runs. */
export interface QueueState {
  readonly incidents: readonly QueuedIncident[]
  /** Completed runs seen, so "no run has happened yet" is distinguishable from "runs have
   * happened and emitted nothing" — the input distinction, preserved into the output where
   * a property can reach it. */
  readonly completedRuns: number
  /** Runs seen in total, both arms.
   *
   * FOR THE VARIANT THAT COUNTS RUNS AS `input.length`. Without a total to reconcile
   * against, a wiring reporting every run as completed is internally consistent: the
   * failures are still recorded in `failedRuns`, so the record-the-failure property is
   * satisfied while the count quietly says the engine has never missed. The identity
   * `runsSeen === completedRuns + failedRuns.length` is what makes that expressible. */
  readonly runsSeen: number
  /** THE LAST COMPLETED RUN ITSELF, not a timestamp claiming to describe one.
   *
   * The bare `lastCompletedRunArrivedAt: Date` this replaced was a conclusion a wiring
   * asserted, and a state reporting a dead engine as current is INTERNALLY CONSISTENT —
   * nothing else in the state contradicts it. Carrying the run means the marker is a projection of something that had
   * to come from the input, and a fabricated one has to be consistent with the incidents it
   * claims to have produced.
   *
   * That raises the cost of the defect without eliminating it. It cannot be eliminated at
   * this layer: see the note on staleness in the docs — the property has to read the run
   * sequence as well as the state. */
  readonly lastCompletedRun: Readonly<{ completedAt: Date; emitted: number }> | null
  /** When a run last ARRIVED AT ALL, whatever its outcome. LIVENESS, NOT FRESHNESS.
   *
   * The one legitimate consumer of an outcome-blind time, given its own name so that it
   * cannot be reached by accident and does not become the argument for putting `at` back on
   * both arms. A scheduler firing into failures and a scheduler that has stopped are
   * different conditions; this separates them and answers nothing else. Never an input to
   * whether the queue is current. */
  readonly lastRunAttemptedAt: Date | null
  /** Runs that failed, with their reasons.
   *
   * ZERO OF THESE HAVE EVER HAPPENED: 5,166 production runs, 5,166 completed, none failed.
   * The arm this records has never fired, which is an argument FOR enforcing it in the type
   * rather than against — nothing in the observed history would ever have taught anyone that
   * failures exist, so the defect was invisible to experience rather than merely unnoticed.
   * When the first one comes it arrives on a path no production data has ever traversed. */
  readonly failedRuns: readonly Readonly<{ failedAt: Date; because: string }>[]
}

/** WHEN A QUEUE STOPS BEING CURRENT. Thirty minutes since the last COMPLETED run.
 *
 * MEASURED, NOT BORROWED, and the distribution is carried rather than the conclusion — the
 * same rule the episode intervals are held to, because a threshold whose provenance is lost
 * becomes a number nobody may change.
 *
 * | across 5,166 production runs | |
 * |---|---|
 * | completed | 5,166 |
 * | failed | 0 |
 * | gap p50 | 0.1 min |
 * | gap p95 | 9.1 min |
 * | **worst gap ever observed** | **14.9 min** |
 *
 * Thirty minutes is twice the worst gap ever seen. The p50 of 0.1 min is runs clustering
 * inside a cycle rather than the cycle cadence, so it is 14.9 that the threshold is set
 * against; quoting the median here would make the margin look far larger than it is.
 *
 * IT IS A CEILING ON SILENCE, NOT A PREDICTION. If the gap distribution shifts, this number
 * is wrong in the direction that matters — reporting a queue as current when the engine has
 * stopped — so it is checked against the measurement rather than tuned against complaints. */
export const STALE_AFTER_MS = 30 * 60 * 1000

/** Observed gaps, kept beside the threshold so the next person can see what it was set
 * against instead of re-deriving it or trusting it. Milliseconds. */
export const OBSERVED_RUN_GAPS = {
  runs: 5166,
  completed: 5166,
  failed: 0,
  p50Ms: 6_000,
  p95Ms: 546_000,
  worstMs: 894_000,
} as const
