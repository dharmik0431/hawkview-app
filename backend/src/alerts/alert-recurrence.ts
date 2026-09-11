import { OPENED, RECORDED, openInvestigation, type AlertLifecycle } from './alert-lifecycle.js'
import type { EscalationSignal } from './alert-type.js'

/** What happens when matching evidence arrives for something already open.
 *
 * SIX CASES THAT MUST NOT BE COLLAPSED. The current system collapses them into
 * one — every event becomes an alert — which is how 301 events became 301
 * notifications. A flat "one incident, stay quiet" rule is the opposite mistake
 * and swallows the thing the recipient most needs to hear.
 *
 *   more of the same on an open incident      update quietly, no notification
 *   evidence that CHANGES WHAT THIS IS        one deduplicated escalation
 *   activity after the condition cleared      reactivate the condition, notify
 *   activity after a RESOLVED investigation   new linked episode, notify
 *   activity after a COLLECTION GAP           resumed after gap, notify
 *   a RECORD gains escalating evidence        becomes an investigation, notify
 */

export type RecurrenceOutcome =
  | Readonly<{ action: 'UPDATE_QUIETLY'; notify: false }>
  | Readonly<{ action: 'ESCALATE'; notify: boolean; signal: EscalationSignal }>
  | Readonly<{ action: 'REACTIVATE_CONDITION'; notify: true; signal: EscalationSignal | null }>
  /** Activity present again after a period HawkView could not see. Its own
   * action rather than a reactivation, because the message differs: nothing
   * cleared, we simply stopped being able to look. */
  | Readonly<{ action: 'RESUMED_AFTER_GAP'; notify: true; signal: EscalationSignal | null }>
  /** A record has gained evidence that makes it worth investigating. Records do
   * not open investigations BY DEFAULT; without this they could never open one at
   * all, and a routine change that turns out to be the first step of something
   * would be structurally un-investigable — one dead end traded for another. */
  | Readonly<{
      action: 'ESCALATE_INTO_INVESTIGATION'
      notify: true
      signal: EscalationSignal
      startsAs: AlertLifecycle
    }>
  | Readonly<{
      action: 'OPEN_LINKED_EPISODE'
      notify: true
      /** THE NEW EPISODE STARTS UNOWNED. Stated in the outcome rather than left
       * to whoever writes the grouping, because it is the kind of detail that
       * gets filled in by whatever was convenient. */
      startsAs: AlertLifecycle
    }>

export interface RecurrenceInput {
  readonly lifecycle: AlertLifecycle
  /** Which escalation signal this evidence crosses, if any. Null means more of
   * the same — which is the common case and must stay quiet. */
  readonly crosses: EscalationSignal | null
  /** Signals already notified for this episode. An escalation sends ONE
   * notification however many events crossed the line, so a signal that has
   * already been reported updates quietly. */
  readonly alreadyEscalated: readonly EscalationSignal[]
  /** `opensInvestigation` from the alert type's declaration — whether THIS TYPE
   * opens an investigation by default, which is not the same as whether this
   * incident currently has one.
   *
   * REQUIRED BECAUSE THE LIFECYCLE CANNOT ANSWER IT, and a defect lived in the
   * gap. A record that promoted into an investigation and was then resolved has
   * `investigation: 'RESOLVED'` — indistinguishable from an ordinary resolved
   * incident, because the lifecycle no longer remembers it began as a record. The
   * new episode therefore opened as an investigation, which means one escalation
   * promoted every FUTURE routine change on that incident key, with no escalating
   * evidence of its own. Escalate once, escalate forever: routine activity back in
   * the queue permanently, which is the 301 problem re-entering through the fix
   * meant to prevent it. */
  readonly opensInvestigationByDefault: boolean
}

export function decideRecurrence(input: RecurrenceInput): RecurrenceOutcome {
  const { lifecycle, crosses, alreadyEscalated, opensInvestigationByDefault } = input

  // 1. The investigation was closed by a person. Activity after that is a NEW
  //    EPISODE linked to the prior one — never a silent reopen, because an
  //    attack next month quietly joining last month's closed incident is exactly
  //    how grouping becomes its own bug. Checked first: it outranks everything,
  //    including an escalation signal.
  if (lifecycle.investigation === 'RESOLVED') {
    // UNOWNED, and deliberately not inheriting the prior acknowledgement.
    // Ownership means a person said they own THIS; carrying it forward is the
    // system deciding somebody owns a thing they have never seen, and it hides
    // the new episode from the one queue built to catch it.
    //
    // And it starts as whatever THE TYPE is, not as whatever the last episode
    // became. A record that was promoted once must not have every later episode
    // born as an investigation — the promotion was a property of that episode's
    // evidence, never of the type.
    return {
      action: 'OPEN_LINKED_EPISODE',
      notify: true,
      startsAs: opensInvestigationByDefault ? OPENED : RECORDED,
    }
  }

  // 2. A RECORD that has gained evidence of a different character. It becomes an
  //    investigation, and somebody is told.
  //
  //    Checked here, before the condition branches, because a record's condition
  //    moves like any other and a cleared-then-returned record would otherwise be
  //    reported as a reactivation of something that was never being investigated.
  //    THE DEDUPLICATION LIST IS DELIBERATELY NOT CONSULTED, and the reason has to
  //    survive a second promotion — because a second promotion is possible.
  //
  //    The two answer different questions. Deduplication answers "have we already
  //    told somebody about this signal"; promotion answers "has this stopped being
  //    a record". The second is not the first's to decide.
  //
  //    What makes that safe rather than merely tidy: promotion happens at most
  //    ONCE PER EPISODE, because after it the investigation is OPEN and this
  //    branch is unreachable. `alreadyEscalated` is scoped per episode as well, so
  //    it can never legitimately hold a promotion belonging to the episode being
  //    decided. A LATER episode may promote again on its own evidence, which is
  //    correct — and is why the reason is stated per episode rather than "once".
  if (lifecycle.investigation === 'NONE') {
    if (crosses === null) return { action: 'UPDATE_QUIETLY', notify: false }
    return {
      action: 'ESCALATE_INTO_INVESTIGATION',
      notify: true,
      signal: crosses,
      startsAs: openInvestigation(lifecycle),
    }
  }

  // 3. The condition had cleared and the activity is back, on an investigation
  //    still open. The person who owns it needs to know it returned. Any
  //    escalation signal rides along so the message can say what changed rather
  //    than only that it recurred.
  if (lifecycle.condition === 'CLEARED') {
    return { action: 'REACTIVATE_CONDITION', notify: true, signal: crosses }
  }

  // 4. Activity present again after a period HawkView could not see.
  //
  //    A GAP MUST NOT BECOME A WAY TO SILENCE AN INCIDENT BY LOOKING AWAY.
  //
  //    I first wrote this the other way — quiet — on the argument that otherwise
  //    every collector catch-up would notify. The argument was wrong, and the
  //    reason is worth keeping: this function only runs when matching evidence
  //    ARRIVES, so the branch never fires on a quiet recovery. It fires exactly
  //    when activity reappears after a blind spot, which is the case that most
  //    needs saying out loud — during the gap nobody could know whether it
  //    continued, and now it is here again.
  //
  //    Checked BEFORE escalation so the gap is always reported, even when the
  //    crossing signal has already been notified for this episode. Coming back
  //    after a blind spot is its own news.
  if (lifecycle.condition === 'UNKNOWN') {
    return { action: 'RESUMED_AFTER_GAP', notify: true, signal: crosses }
  }

  // 5. Evidence of a different character on a live incident. One notification,
  //    however many events crossed the line — and none at all if this signal has
  //    already been reported for this episode.
  if (crosses !== null) {
    return { action: 'ESCALATE', notify: !alreadyEscalated.includes(crosses), signal: crosses }
  }

  // 6. More of the same on a live incident. The common case, and the one that
  //    must stay quiet: treating it as news is what turned 301 events into 301
  //    notifications.
  return { action: 'UPDATE_QUIETLY', notify: false }
}
