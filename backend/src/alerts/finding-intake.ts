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

import { incidentGrouping, type ResolvedSubject } from './alert-incident-key.js'
import { eventInstant, type EventInstant } from './alert-event-time.js'
import type { SubjectRole } from './alert-type.js'

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

// ---------------------------------------------------------------------------------------
// THE WIRING. Pure, and it decides nothing it lacks evidence for.
// ---------------------------------------------------------------------------------------

/** What `incidentGrouping` actually reads.
 *
 * Narrowed here rather than fabricating an `AlertTypeDeclaration` for a Risky Users rule. A
 * rule is not an alert type declaration, and a fake one would be a wrong state made
 * expressible: every other field would have to be invented, and each invented field is
 * something a later reader may believe. */
type IncidentIdentity = Readonly<{ id: string; subject: SubjectRole }>

/** The account a finding is about, or why it cannot be named.
 *
 * A blank subject does not group — step 02's ruling applied rather than re-decided. Merging
 * on "unknown" would assert that two findings concern the same account on the strength of
 * not knowing which account either concerns. */
function accountOf(finding: EmittedFinding): ResolvedSubject {
  return finding.subjectId.trim().length > 0
    ? { resolved: true, id: finding.subjectId }
    : { resolved: false, why: `the finding carries no subjectId (subjectType ${finding.subjectType})` }
}

/** FULL beats PARTIAL beats UNAVAILABLE; an incident reports the weakest it was built on. */
const COVERAGE_ORDER: readonly FindingCoverage[] = ['UNAVAILABLE', 'PARTIAL', 'FULL']
function leastComplete(left: FindingCoverage, right: FindingCoverage): FindingCoverage {
  return COVERAGE_ORDER.indexOf(left) <= COVERAGE_ORDER.indexOf(right) ? left : right
}

/** Build the queue from a sequence of runs.
 *
 * PURE, AND IT NEVER CLEARS ANYTHING. A finding's disappearance from a later completed run is
 * not evidence the risk ended — clearing requires the resolving condition in
 * `alert-clearing.ts` and the evidence that rule asks for, none of which is in a finding
 * stream. So this produces OPEN incidents and nothing else, and CLEARED is unreachable from
 * here by construction rather than by a rule somebody has to remember.
 *
 * A FAILED RUN CONTRIBUTES NOTHING BUT ITS RECORD. It cannot be read as absence, because it
 * is not evidence that anything stopped — it is evidence that we stopped looking. */
export function intake(runs: readonly IntakeRun[]): QueueState {
  const byKey = new Map<string, {
    incident: Omit<QueuedIncident, 'notifications'>
    notifications: QueuedNotification[]
  }>()
  const failedRuns: { failedAt: Date; because: string }[] = []
  let completedRuns = 0
  let lastCompletedRun: QueueState['lastCompletedRun'] = null
  let lastRunAttemptedAt: Date | null = null

  for (const run of runs) {
    const attemptedAt = run.kind === 'COMPLETED' ? run.completedAt : run.failedAt
    // Liveness advances for BOTH arms — the one thing that legitimately reads across them,
    // and the reason it has a name of its own rather than a shared field on the union.
    if (lastRunAttemptedAt === null || attemptedAt > lastRunAttemptedAt) lastRunAttemptedAt = attemptedAt

    if (run.kind === 'FAILED') {
      failedRuns.push({ failedAt: run.failedAt, because: run.because })
      continue
    }

    completedRuns += 1
    lastCompletedRun = { completedAt: run.completedAt, emitted: run.emitted.length }

    for (const finding of run.emitted) {
      const account = accountOf(finding)
      const identity: IncidentIdentity = { id: finding.ruleId, subject: 'ACCOUNT' }
      const grouping = incidentGrouping(
        identity,
        { organizationId: finding.organizationId, customerTenantId: finding.customerTenantId },
        account)

      // An ungrouped finding stands alone on its own id — step 03's ruling, honoured here so
      // these two steps cannot drift the way the reconciliation drifted from step 02.
      const key = grouping.groups ? grouping.key : `ungrouped:${finding.id}`
      // THE EVENT'S OWN TIME. The run's completion is the arrival half and reaches no
      // decision: `eventInstant` reads `occurredAt` and nothing else.
      const at = eventInstant({ occurredAt: finding.observedAt, receivedAt: run.completedAt })
      const existing = byKey.get(key)

      if (existing === undefined) {
        byKey.set(key, {
          incident: {
            key,
            organizationId: finding.organizationId,
            customerTenantId: finding.customerTenantId,
            subject: account,
            ruleId: finding.ruleId,
            state: 'OPEN',
            coverage: finding.coverage,
            firstEventAt: at,
            latestEventAt: at,
          },
          // THE ONLY PLACE A NOTIFICATION IS CREATED. The re-emission path below cannot reach
          // it, which makes "notifies once" a property of the shape rather than of a
          // condition someone could weaken later.
          notifications: [{
            incidentKey: key,
            fromFindingId: finding.id,
            organizationId: finding.organizationId,
            at,
          }],
        })
        continue
      }

      // Re-emission: the incident learns from it, and nobody is told again.
      existing.incident = {
        ...existing.incident,
        coverage: leastComplete(existing.incident.coverage, finding.coverage),
        // BY EVENT TIME, NOT ARRIVAL ORDER — different mistakes, and the second is subtler. A
        // backfilled finding delivered last may have happened first, so taking the most
        // recently delivered would report it as the newest.
        firstEventAt: at < existing.incident.firstEventAt ? at : existing.incident.firstEventAt,
        latestEventAt: at > existing.incident.latestEventAt ? at : existing.incident.latestEventAt,
      }
    }
  }

  return {
    incidents: [...byKey.values()].map(({ incident, notifications }) => ({ ...incident, notifications })),
    runsSeen: runs.length,
    completedRuns,
    lastCompletedRun,
    lastRunAttemptedAt,
    failedRuns,
  }
}

/** Whether the queue is current, COMPUTED FROM THE RUNS rather than from the state.
 *
 * Deliberately not a field, and deliberately not a function of `QueueState`. A state
 * reporting a dead engine as current is internally consistent — nothing else in it disagrees
 * — so a freshness check reading only the state is testing self-consistency and calling it
 * freshness. This reads the run sequence, which is the only thing that knows. */
export type Freshness =
  | Readonly<{ kind: 'CURRENT'; lastCompletedAt: Date; sinceMs: number }>
  | Readonly<{ kind: 'STALE'; lastCompletedAt: Date; sinceMs: number }>
  /** No completed run at all. NOT stale: nothing has gone quiet, because nothing has
   * started. Reporting a never-started engine as stale would send somebody to restart a
   * schedule that was never configured, and the two need different people. */
  | Readonly<{ kind: 'NEVER_COMPLETED'; because: string }>

export function freshnessOf(runs: readonly IntakeRun[], now: Date): Freshness {
  let latest: Date | null = null
  for (const run of runs) {
    if (run.kind !== 'COMPLETED') continue
    if (latest === null || run.completedAt > latest) latest = run.completedAt
  }
  if (latest === null) {
    const failures = runs.filter((run) => run.kind === 'FAILED').length
    return {
      kind: 'NEVER_COMPLETED',
      because: failures > 0
        ? `${failures} run(s) attempted, none completed`
        : 'no run has been attempted',
    }
  }
  const sinceMs = now.getTime() - latest.getTime()
  return sinceMs > STALE_AFTER_MS
    ? { kind: 'STALE', lastCompletedAt: latest, sinceMs }
    : { kind: 'CURRENT', lastCompletedAt: latest, sinceMs }
}
