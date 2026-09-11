import assert from 'node:assert/strict'
import test from 'node:test'
import { decideRecurrence } from './alert-recurrence.js'
import { OPENED, RECORDED, acknowledge, applyObservation, resolveInvestigation, type AlertLifecycle } from './alert-lifecycle.js'
import { evidenceFromSync } from '../risky-users-wiring/evidence-availability.js'

/** The five recurrence cases, which must not collapse into each other.
 *
 * Collapsed one way — every event is an alert — produces the current 301. The
 * obvious correction, "one incident, stay quiet", collapses it the other way and
 * swallows the thing the recipient most needs to hear.
 */

const open: AlertLifecycle = OPENED
const ownedAndLive = acknowledge(OPENED)
const clearedButOpen: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'OPEN' }
const resolved: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'RESOLVED' }
const visibilityLost: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'UNKNOWN', investigation: 'OPEN' }

test('more of the same on an open incident updates quietly', () => {
  for (const lifecycle of [open, ownedAndLive]) {
    const outcome = decideRecurrence({ lifecycle, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
    assert.equal(outcome.action, 'UPDATE_QUIETLY')
    assert.equal(outcome.notify, false)
  }
})

test('evidence that CHANGES WHAT THIS IS sends exactly one notification', () => {
  // The case added in revision 4. Repeated failures and then a success from the
  // same source is materially different from more failures, and a flat quiet rule
  // would swallow it.
  const first = decideRecurrence({
    lifecycle: ownedAndLive, crosses: 'SUCCESS_FOLLOWED_FAILURES', alreadyEscalated: [], opensInvestigationByDefault: true,
  })
  assert.equal(first.action, 'ESCALATE')
  assert.equal(first.notify, true)
  assert.equal(first.action === 'ESCALATE' && first.signal, 'SUCCESS_FOLLOWED_FAILURES')

  // ONE notification however many events cross the line. A second crossing of
  // the SAME signal escalates the incident again but tells nobody twice.
  const second = decideRecurrence({
    lifecycle: ownedAndLive, crosses: 'SUCCESS_FOLLOWED_FAILURES', alreadyEscalated: ['SUCCESS_FOLLOWED_FAILURES'], opensInvestigationByDefault: true,
  })
  assert.equal(second.action, 'ESCALATE')
  assert.equal(second.notify, false, 'one escalation notification, not one per event')

  // POSITIVE CONTROL: a DIFFERENT signal is a different thing to say, so it does
  // notify even though one escalation has already been sent.
  const other = decideRecurrence({
    lifecycle: ownedAndLive, crosses: 'SUBJECT_HOLDS_PRIVILEGED_ROLE', alreadyEscalated: ['SUCCESS_FOLLOWED_FAILURES'], opensInvestigationByDefault: true,
  })
  assert.equal(other.notify, true)
})

test('activity after the condition cleared reactivates it and notifies', () => {
  const outcome = decideRecurrence({ lifecycle: clearedButOpen, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(outcome.action, 'REACTIVATE_CONDITION')
  assert.equal(outcome.notify, true, 'the person who owns it needs to know it came back')

  // An escalation signal rides along, so the message can say what changed rather
  // than only that something recurred.
  const escalating = decideRecurrence({
    lifecycle: clearedButOpen, crosses: 'SUCCESS_FOLLOWED_FAILURES', alreadyEscalated: [], opensInvestigationByDefault: true,
  })
  assert.equal(escalating.action, 'REACTIVATE_CONDITION')
  assert.equal(escalating.action === 'REACTIVATE_CONDITION' && escalating.signal, 'SUCCESS_FOLLOWED_FAILURES')
})

test('activity after a RESOLVED investigation opens a new linked episode, never a silent reopen', () => {
  // Without the episode boundary, an attack next month silently joins last
  // month's closed incident and nobody is told — grouping becoming its own bug.
  const outcome = decideRecurrence({ lifecycle: resolved, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(outcome.action, 'OPEN_LINKED_EPISODE')
  assert.equal(outcome.notify, true)

  // This outranks escalation dedup: a resolved investigation must never be
  // quietly updated, whatever has already been reported.
  const withEverything = decideRecurrence({
    lifecycle: resolved,
    crosses: 'SUCCESS_FOLLOWED_FAILURES',
    alreadyEscalated: ['SUCCESS_FOLLOWED_FAILURES'], opensInvestigationByDefault: true,
  })
  assert.equal(withEverything.action, 'OPEN_LINKED_EPISODE')
  assert.equal(withEverything.notify, true, 'a resolved investigation is never silently reopened')
})

test('ACTIVITY AFTER A COLLECTION GAP MUST NOTIFY', () => {
  // A GAP MUST NOT BECOME A WAY TO SILENCE AN INCIDENT BY LOOKING AWAY.
  //
  // This test previously asserted the opposite, and the reasoning behind it was
  // wrong rather than merely debatable: "quiet, because otherwise every collector
  // catch-up notifies". `decideRecurrence` only runs when matching evidence
  // ARRIVES, so it never fires on a quiet recovery — it fires exactly when
  // activity reappears after a blind spot. Under the old rule, breaking
  // collection was enough to make an incident go silent when it came back.
  const outcome = decideRecurrence({ lifecycle: visibilityLost, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(outcome.action, 'RESUMED_AFTER_GAP')
  assert.equal(outcome.notify, true)

  // Its own action, not borrowed from reactivation: nothing cleared, so the
  // message has a different thing to say.
  assert.notEqual(outcome.action, 'REACTIVATE_CONDITION')

  // POSITIVE CONTROL: an incident that never lost visibility still updates
  // quietly, so this is about the gap rather than a function that now notifies
  // for everything — which would be the 301 defect restored.
  const live = decideRecurrence({ lifecycle: ownedAndLive, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(live.notify, false)
})

test('a gap reports even when the escalation was already sent', () => {
  // Checked before escalation deduplication on purpose. Coming back after a
  // blind spot is its own news, and a signal already reported for this episode
  // must not swallow it — otherwise the silence is reachable by escalating first
  // and then breaking collection.
  const outcome = decideRecurrence({
    lifecycle: visibilityLost,
    crosses: 'SUCCESS_FOLLOWED_FAILURES',
    alreadyEscalated: ['SUCCESS_FOLLOWED_FAILURES'], opensInvestigationByDefault: true,
  })
  assert.equal(outcome.action, 'RESUMED_AFTER_GAP')
  assert.equal(outcome.notify, true)
  // And the signal rides along, so the message can say what changed rather than
  // only that something returned.
  assert.equal(outcome.action === 'RESUMED_AFTER_GAP' && outcome.signal, 'SUCCESS_FOLLOWED_FAILURES')
})

test('a new episode after a resolved investigation starts UNOWNED', () => {
  // Ownership means a person said they own THIS. Carrying the prior
  // acknowledgement forward is the system deciding somebody owns a thing they
  // have never seen, and it hides the episode from the one queue built to catch
  // it.
  const outcome = decideRecurrence({ lifecycle: resolved, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(outcome.action, 'OPEN_LINKED_EPISODE')
  assert.equal(outcome.action === 'OPEN_LINKED_EPISODE' && outcome.startsAs.ownership, 'UNACKNOWLEDGED')
  assert.equal(outcome.action === 'OPEN_LINKED_EPISODE' && outcome.startsAs.investigation, 'OPEN')
  assert.equal(outcome.action === 'OPEN_LINKED_EPISODE' && outcome.startsAs.condition, 'ACTIVE')

  // The prior incident WAS acknowledged, so the assertion above is about not
  // inheriting rather than about there being nothing to inherit.
  assert.equal(resolved.ownership, 'ACKNOWLEDGED')
})

test('THE WHOLE GAP SCENARIO, end to end', () => {
  // QA's hole, walked as one story rather than four separate assertions, because
  // the properties only matter together: a gap must not resolve, must not erase
  // ownership, must not itself notify, and activity returning after it MUST
  // notify. Three of those are about staying silent, and silence is exactly what
  // a broken component also produces — so the fourth is what proves the other
  // three are restraint rather than inertia.
  const readable = evidenceFromSync('SUCCESS')
  const gone = evidenceFromSync('FAILED')

  // A person takes it on while the condition is live.
  const owned = acknowledge(OPENED)
  assert.equal(owned.ownership, 'ACKNOWLEDGED')
  assert.equal(owned.condition, 'ACTIVE')

  // Collection breaks. Even with a caller claiming the condition cleared, and
  // even for a type permitted to auto-close.
  const duringGap = applyObservation(owned, {
    evidence: gone, conditionCleared: true, mayAutoCloseInvestigation: true,
  })
  assert.equal(duringGap.condition, 'UNKNOWN', 'we cannot see, and say so')
  assert.equal(duringGap.investigation, 'OPEN', 'a gap resolves nothing')
  assert.equal(duringGap.ownership, 'ACKNOWLEDGED', 'a gap does not erase who owns it')

  // The gap itself tells nobody: nothing arrived, so nothing decides a
  // recurrence. `applyObservation` has no notification to give.
  assert.equal('notify' in duringGap, false)

  // Activity arrives again. THIS notifies — otherwise looking away is enough to
  // silence the incident.
  const resumed = decideRecurrence({ lifecycle: duringGap, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(resumed.action, 'RESUMED_AFTER_GAP')
  assert.equal(resumed.notify, true)

  // And visibility returning with the condition genuinely over still clears
  // normally, so the rule above has not made the gap permanent.
  const recovered = applyObservation(duringGap, {
    evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: true,
  })
  assert.equal(recovered.condition, 'CLEARED')
  assert.equal(recovered.investigation, 'RESOLVED', 'an operational type may close once it can see again')
})

test('A RECORD CAN BECOME AN INVESTIGATION, but only on escalating evidence', () => {
  // "Records do not open investigations" is a default, not a prohibition. Without
  // this a routine change that turns out to be the first step of something would
  // be structurally un-investigable — one dead end traded for another.
  const quiet = decideRecurrence({ lifecycle: RECORDED, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: false })
  assert.equal(quiet.action, 'UPDATE_QUIETLY')
  assert.equal(quiet.notify, false, 'more routine activity is still routine')

  const promoted = decideRecurrence({
    lifecycle: RECORDED, crosses: 'CORROBORATED_BY_SECOND_SOURCE', alreadyEscalated: [], opensInvestigationByDefault: false,
  })
  assert.equal(promoted.action, 'ESCALATE_INTO_INVESTIGATION')
  assert.equal(promoted.notify, true)
  assert.equal(promoted.action === 'ESCALATE_INTO_INVESTIGATION' && promoted.startsAs.investigation, 'OPEN')
  assert.equal(
    promoted.action === 'ESCALATE_INTO_INVESTIGATION' && promoted.startsAs.ownership,
    'UNACKNOWLEDGED',
    'promoted into the queue unowned, or it is hidden from the queue it just joined')
})

test('a record that cleared and returned is not reported as a reactivation', () => {
  // A record's condition moves like any other. Reported as REACTIVATE_CONDITION
  // it would claim a person's investigation came back to life, when there was
  // never an investigation — the wrong sentence, and one a reader acts on.
  const clearedRecord = { ...RECORDED, condition: 'CLEARED' as const }
  const outcome = decideRecurrence({ lifecycle: clearedRecord, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true })
  assert.equal(outcome.action, 'UPDATE_QUIETLY')
  assert.notEqual(outcome.action, 'REACTIVATE_CONDITION')

  // And a gap on a record does not borrow the gap notification either, unless it
  // brings escalating evidence with it.
  const afterGap = { ...RECORDED, condition: 'UNKNOWN' as const }
  assert.equal(decideRecurrence({ lifecycle: afterGap, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true }).action, 'UPDATE_QUIETLY')

  // POSITIVE CONTROL: the same cleared-and-returned shape WITH an investigation
  // does reactivate, so the above is about the record.
  const realCleared: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'OPEN' }
  assert.equal(decideRecurrence({ lifecycle: realCleared, crosses: null, alreadyEscalated: [], opensInvestigationByDefault: true }).action, 'REACTIVATE_CONDITION')
})

test('promotion is not suppressed by the escalation dedup list', () => {
  // Crossing a threshold for the first time on a record is the moment it stops
  // being a record. That happens once and cannot be "already reported" — and if
  // the dedup list could suppress it, a record would stay a record forever after
  // any earlier escalation bookkeeping.
  const outcome = decideRecurrence({
    lifecycle: RECORDED,
    crosses: 'CORROBORATED_BY_SECOND_SOURCE',
    alreadyEscalated: ['CORROBORATED_BY_SECOND_SOURCE'], opensInvestigationByDefault: false,
  })
  assert.equal(outcome.action, 'ESCALATE_INTO_INVESTIGATION')
  assert.equal(outcome.notify, true)
})

test('A RECORD THAT PROMOTED ONCE DOES NOT STAY PROMOTED FOREVER', () => {
  // THE DEFECT THIS TEST WAS WRITTEN FOR, found by being asked whether "once" was
  // enforced or merely true. It was merely true.
  //
  // A record promotes, a person resolves it, and new routine activity arrives.
  // The lifecycle now reads RESOLVED — indistinguishable from an ordinary resolved
  // incident, because it no longer remembers having been a record. The new episode
  // therefore opened as an investigation, so ONE escalation promoted every future
  // routine change on that incident key with no escalating evidence of its own.
  // Escalate once, escalate forever: routine activity permanently back in the
  // queue, which is the 301 problem re-entering through the fix for it.
  const promoted = decideRecurrence({
    lifecycle: RECORDED,
    crosses: 'CORROBORATED_BY_SECOND_SOURCE',
    alreadyEscalated: [],
    opensInvestigationByDefault: false,
  })
  assert.equal(promoted.action, 'ESCALATE_INTO_INVESTIGATION')
  const live = promoted.action === 'ESCALATE_INTO_INVESTIGATION' ? promoted.startsAs : OPENED
  assert.equal(live.investigation, 'OPEN')

  // A person resolves it, then routine activity arrives again.
  const closed = resolveInvestigation(live)
  const next = decideRecurrence({
    lifecycle: closed,
    crosses: null,
    alreadyEscalated: [],
    opensInvestigationByDefault: false,
  })
  assert.equal(next.action, 'OPEN_LINKED_EPISODE')
  // BACK TO BEING A RECORD. The promotion was a property of that episode's
  // evidence, never of the type.
  assert.equal(
    next.action === 'OPEN_LINKED_EPISODE' && next.startsAs.investigation,
    'NONE',
    'a promoted-then-resolved record must not have its next episode born as an investigation')

  // POSITIVE CONTROL: a type that DOES open investigations still gets an
  // investigation episode from the identical call, so the line above is about the
  // type rather than a function that always returns a record.
  const realType = decideRecurrence({
    lifecycle: closed,
    crosses: null,
    alreadyEscalated: [],
    opensInvestigationByDefault: true,
  })
  assert.equal(realType.action === 'OPEN_LINKED_EPISODE' && realType.startsAs.investigation, 'OPEN')
})

test('promotion happens at most ONCE PER EPISODE, and that is what makes skipping dedup safe', () => {
  // The reason for not consulting the dedup list has to survive a second
  // promotion. It does, because within one episode a second promotion is
  // unreachable: after promoting, the investigation is OPEN, so the record branch
  // cannot fire again.
  const first = decideRecurrence({
    lifecycle: RECORDED,
    crosses: 'CORROBORATED_BY_SECOND_SOURCE',
    alreadyEscalated: [],
    opensInvestigationByDefault: false,
  })
  const afterPromotion = first.action === 'ESCALATE_INTO_INVESTIGATION' ? first.startsAs : OPENED

  const again = decideRecurrence({
    lifecycle: afterPromotion,
    crosses: 'CORROBORATED_BY_SECOND_SOURCE',
    alreadyEscalated: [],
    opensInvestigationByDefault: false,
  })
  assert.notEqual(again.action, 'ESCALATE_INTO_INVESTIGATION', 'the same episode cannot promote twice')
  // It is an ordinary escalation now, which IS dedup-governed — the two questions
  // separating cleanly rather than one borrowing the other's answer.
  assert.equal(again.action, 'ESCALATE')

  const deduped = decideRecurrence({
    lifecycle: afterPromotion,
    crosses: 'CORROBORATED_BY_SECOND_SOURCE',
    alreadyEscalated: ['CORROBORATED_BY_SECOND_SOURCE'],
    opensInvestigationByDefault: false,
  })
  assert.equal(deduped.notify, false, 'and once promoted, the usual one-notification rule applies')
})
