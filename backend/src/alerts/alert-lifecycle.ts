import type { EvidenceDisposition } from '../risky-users-wiring/evidence-availability.js'

/** How an alert ends, as THREE INDEPENDENT AXES rather than three states.
 *
 * This is the thing the plan says is most likely to be rebuilt wrong, and it was
 * corrected twice in review, so the shape here is deliberately one that cannot be
 * collapsed into a sequence.
 *
 *   Ownership           unacknowledged · acknowledged     set by a person
 *   Observed condition  active · cleared · unknown        set by the system
 *   Investigation       open · resolved                   set by a person
 *
 * They are orthogonal. An acknowledged investigation can have an active
 * condition. A cleared condition does not close an investigation. A single
 * `status` field — which is what `notifications.resolvedAt` is today — cannot
 * express that, and collapsing them is what makes "silence" and "resolution"
 * look like the same thing.
 *
 * WHY A PRODUCT AND NOT A UNION. Written as `type AlertState = 'UNACKNOWLEDGED' |
 * 'ACKNOWLEDGED' | 'CLEARED' | 'RESOLVED'` the axes become mutually exclusive by
 * construction, and every later reader has to guess which ones are compatible.
 * As three fields, all twelve combinations are representable and each transition
 * names the single axis it touches — so the independence is a property of the
 * type rather than a rule in a comment.
 */

/** Set by a person. Whether anybody has taken this on. */
export type Ownership = 'UNACKNOWLEDGED' | 'ACKNOWLEDGED'

/** Set by the system, from evidence.
 *
 * UNKNOWN is the value the whole plan turns on. It is NOT a worse kind of
 * CLEARED: it means HawkView cannot currently see whether the condition is still
 * happening. Lockouts stop when an attack stops, and they also stop when
 * collection stops — the events are identical in both cases, because in both
 * cases there are none. */
export type ObservedCondition = 'ACTIVE' | 'CLEARED' | 'UNKNOWN'

/** Set by a person, for security findings. Whether the question is closed.
 *
 * NONE is not a third way of being closed. It means this alert never opened an
 * investigation — a record, with nothing to do about it, living in a searchable
 * list rather than a queue.
 *
 * IT EXISTS BECAUSE NEITHER OTHER VALUE IS CORRECT FOR A RECORD, which only
 * became visible once records were allowed to escalate. `OPEN` would put every
 * routine directory change into the queue nobody can empty — the 301 defect,
 * rebuilt. `RESOLVED` would be worse and quieter: it reads as "a person closed
 * this", and `decideRecurrence` would open a new linked episode on every single
 * recurrence, because that is what activity after a resolved investigation
 * means. A record would have manufactured an episode per event. */
export type Investigation = 'OPEN' | 'RESOLVED' | 'NONE'

export type AlertLifecycle = Readonly<{
  ownership: Ownership
  condition: ObservedCondition
  investigation: Investigation
}>

/** What a new incident looks like: nobody owns it, the condition is happening,
 * the question is open. */
export const OPENED: AlertLifecycle = Object.freeze({
  ownership: 'UNACKNOWLEDGED',
  condition: 'ACTIVE',
  investigation: 'OPEN',
})

/** What a new RECORD looks like: an owner and a condition, and no investigation.
 *
 * Records do not open investigations BY DEFAULT — which is not the same as never
 * being investigable. A routine directory change that turns out to be the first
 * step of something must be able to become an investigation, or the rule that
 * keeps records out of the queue would make them structurally un-investigable,
 * trading one dead end for another. That transition is an escalation, and it is
 * `decideRecurrence`'s to make. */
export const RECORDED: AlertLifecycle = Object.freeze({
  ownership: 'UNACKNOWLEDGED',
  condition: 'ACTIVE',
  investigation: 'NONE',
})

/** Whether this alert type's investigation may be closed by the system.
 *
 * OPERATIONAL may. A collector that succeeds has demonstrably recovered, and
 * holding that open is noise that trains people to ignore the queue.
 *
 * SECURITY may not. An account that stopped being attacked has NOT been shown to
 * be safe — a cleared condition is evidence the activity stopped, never evidence
 * the account is clean. A person closes that. */
export type AlertCategory = 'OPERATIONAL' | 'SECURITY'

export interface Observation {
  /** From `evidenceFromSync`. The existing vocabulary for "can we still see?",
   * reused rather than reinvented: a second notion of freshness living here
   * would drift from the one the evidence engine already uses. */
  readonly evidence: EvidenceDisposition
  /** Whether fresh evidence shows the condition has stopped. Only meaningful
   * when the evidence is readable, and deliberately separate from it so that
   * "no events" cannot be passed off as "cleared". */
  readonly conditionCleared: boolean
  /** From `mayAutoClose(declaration)`. The DECLARATION decides this, not the
   * category directly: SECURITY can never auto-close, but an operational type is
   * also free to declare that only a person closes it, and reading the category
   * here would quietly override that choice. */
  readonly mayAutoCloseInvestigation: boolean
}

/** Applies what the system can see. Touches the observed condition, and — only
 * for operational alerts that have demonstrably recovered — the investigation.
 *
 * MISSING COLLECTION MOVES THE CONDITION TO UNKNOWN AND TOUCHES NOTHING ELSE.
 * Not the ownership, not the investigation. Someone who acknowledged an incident
 * still owns it when the feed goes quiet, and an open question stays open. This
 * is the rule the plan turns on and the one the first draft got wrong. */
export function applyObservation(
  current: AlertLifecycle,
  observation: Observation,
): AlertLifecycle {
  if (!observation.evidence.read) {
    // No readable evidence. We do not know, and saying so is the entire point —
    // the alternative is reporting an attack as over because the collector that
    // would have seen it is broken.
    return { ...current, condition: 'UNKNOWN' }
  }

  if (!observation.conditionCleared) {
    return { ...current, condition: 'ACTIVE' }
  }

  // Fresh, readable evidence that the condition stopped. The CONDITION clears
  // for both categories — that is an observation, and it is true.
  const cleared: AlertLifecycle = { ...current, condition: 'CLEARED' }

  // A record has no investigation to close, and must not acquire one by having
  // its condition clear. Becoming an investigation is an escalation — a
  // deliberate act on new evidence — never a side effect of going quiet.
  if (cleared.investigation === 'NONE') return cleared

  // Whether the QUESTION closes is a different decision, and the declaration
  // decides it. Note this never reopens: an incident whose investigation a person
  // already resolved stays resolved.
  return observation.mayAutoCloseInvestigation
    ? { ...cleared, investigation: 'RESOLVED' }
    : cleared
}

/** Set by a person. Touches ownership only — acknowledging is saying "I have
 * this", not "this is over". */
export function acknowledge(current: AlertLifecycle): AlertLifecycle {
  return { ...current, ownership: 'ACKNOWLEDGED' }
}

/** Set by a person. Touches the investigation only.
 *
 * Deliberately permitted while the condition is ACTIVE or UNKNOWN: an operator
 * may conclude that an ongoing lockout storm is a misconfigured service account
 * and close the question without the activity stopping. Refusing that would make
 * the queue unclosable in exactly the cases where a human has the answer. */
export function resolveInvestigation(current: AlertLifecycle): AlertLifecycle {
  return { ...current, investigation: 'RESOLVED' }
}

/** Whether this lifecycle still wants someone's attention.
 *
 * Reads all three axes, which is the point — no single field answers it. An
 * UNKNOWN condition on an open investigation still wants attention, because not
 * being able to see is itself something to act on. */
export function needsAttention(lifecycle: AlertLifecycle): boolean {
  // A record is not in the queue. That is the whole point of it being a record,
  // and it is why NONE had to be distinguishable from OPEN.
  if (lifecycle.investigation === 'NONE') return false
  if (lifecycle.investigation === 'RESOLVED') return false
  return lifecycle.condition !== 'CLEARED' || lifecycle.ownership === 'UNACKNOWLEDGED'
}

/** Promotes a record into an investigation. The only way NONE is left.
 *
 * Called when new evidence crosses an escalation threshold, so a routine change
 * that turns out to be part of something can be investigated. It opens
 * UNACKNOWLEDGED for the same reason a new episode does: nobody has yet looked at
 * this as an investigation, and pre-filling an owner hides it from the queue it
 * has just been promoted into. */
export function openInvestigation(current: AlertLifecycle): AlertLifecycle {
  return current.investigation === 'NONE'
    ? { ...current, investigation: 'OPEN', ownership: 'UNACKNOWLEDGED' }
    : current
}
