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
  /** The event's OWN time. Becomes the queue's `EventInstant`; see `IntakeRun.at`. */
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
export type IntakeRun =
  | Readonly<{
      kind: 'COMPLETED'
      /** When the run finished — ARRIVAL TIME, and named so it cannot be mistaken for an
       * event time. It is the `receivedAt` half of every instant this run produces, and it
       * is never the half a decision is made on. */
      at: Date
      emitted: readonly EmittedFinding[]
    }>
  | Readonly<{
      kind: 'FAILED'
      at: Date
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
  /** The last completed run's ARRIVAL time, or null if there has never been one.
   *
   * Arrival is the right clock here and it is the only place in this file where it is: the
   * question "is the engine still running" is about the engine, not about the events. Named
   * to say so. Freshness of the engine's runs is not a pinned property yet — this is the
   * field that would make it expressible. */
  readonly lastCompletedRunArrivedAt: Date | null
  /** Runs that failed, with their reasons.
   *
   * NOT PINNED BY ANY OF THE SEVEN PROPERTIES, and present anyway, because the seam had to
   * decide whether a failure was expressible at all and the answer determines whether the
   * absence rule is safe. Failure handling can now be specified against something. */
  readonly failedRuns: readonly Readonly<{ at: Date; because: string }>[]
}
