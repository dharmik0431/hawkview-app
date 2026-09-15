import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPENED,
  RECORDED,
  openInvestigation,
  acknowledge,
  applyObservation,
  needsAttention,
  resolveInvestigation,
  type AlertLifecycle,
  type Investigation,
  type ObservedCondition,
  type Ownership,
} from './alert-lifecycle.js'
import { evidenceFromSync } from '../risky-users-wiring/evidence-availability.js'

/** The three axes, and above all their independence.
 *
 * This was corrected twice in review and is the part of the plan most likely to
 * be rebuilt wrong, so the tests sweep every combination rather than checking the
 * happy path. A model that makes the axes sequential passes a one-case test and
 * fails here.
 */

const OWNERSHIPS: readonly Ownership[] = ['UNACKNOWLEDGED', 'ACKNOWLEDGED']
const CONDITIONS: readonly ObservedCondition[] = ['ACTIVE', 'CLEARED', 'UNKNOWN']
const INVESTIGATIONS: readonly Investigation[] = ['OPEN', 'RESOLVED', 'NONE']

/** All eighteen states. If any were unrepresentable the axes would not be
 * independent. NONE joined the investigation axis once records were allowed to
 * escalate: a record is neither open nor resolved, and calling it either was
 * wrong in a different way. */
function everyLifecycle(): AlertLifecycle[] {
  return OWNERSHIPS.flatMap((ownership) =>
    CONDITIONS.flatMap((condition) =>
      INVESTIGATIONS.map((investigation) => ({ ownership, condition, investigation }))))
}

/** Readable evidence, via the SAME function the evidence engine uses. Reused
 * rather than hand-rolled so this cannot drift from the real notion of "can we
 * still see". */
const readable = evidenceFromSync('SUCCESS')
const collectionBroken = evidenceFromSync('FAILED')
const neverCollected = evidenceFromSync('PENDING')

test('all eighteen combinations exist, because the axes are independent', () => {
  const all = everyLifecycle()
  assert.equal(all.length, 18)
  // An acknowledged investigation with an active condition is the combination
  // the review specifically called out, and a sequential model cannot hold it.
  assert.ok(all.some((l) => l.ownership === 'ACKNOWLEDGED' && l.condition === 'ACTIVE' && l.investigation === 'OPEN'))
  // And a cleared condition on an open investigation: the activity stopped, the
  // question has not been answered.
  assert.ok(all.some((l) => l.condition === 'CLEARED' && l.investigation === 'OPEN'))
})

test('MISSING COLLECTION MOVES THE CONDITION TO UNKNOWN AND TOUCHES NOTHING ELSE', () => {
  // THE RULE THE WHOLE PLAN TURNS ON, and the one the first draft got wrong.
  // Lockouts stop when an attack stops, and they also stop when collection stops.
  let checked = 0
  for (const before of everyLifecycle()) {
    for (const evidence of [collectionBroken, neverCollected]) {
      for (const mayAutoCloseInvestigation of [true, false]) {
        // conditionCleared TRUE on purpose: even a caller claiming the condition
        // cleared must not be believed without readable evidence.
        const after = applyObservation(before, { evidence, conditionCleared: true, mayAutoCloseInvestigation })
        assert.equal(after.condition, 'UNKNOWN')
        assert.equal(after.ownership, before.ownership, 'ownership must be untouched')
        assert.equal(after.investigation, before.investigation, 'the investigation must be untouched')
        checked += 1
      }
    }
  }
  assert.equal(checked, 18 * 2 * 2, 'the sweep must actually have run')

  // POSITIVE CONTROL: with READABLE evidence the same call does clear, so the
  // above is about the missing evidence and not a function that never acts.
  const cleared = applyObservation(OPENED, { evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: false })
  assert.equal(cleared.condition, 'CLEARED')
})

test('SILENCE IS NOT RESOLUTION: no readable evidence never resolves anything', () => {
  // An open investigation with a broken collector must not end up resolved, by
  // any path. This is absence of evidence read as evidence of absence — the
  // defect removed from the Risky Users engine, and this is the layer where it
  // would come back.
  for (const before of everyLifecycle().filter((l) => l.investigation === 'OPEN')) {
    const after = applyObservation(before, {
      evidence: collectionBroken, conditionCleared: true, mayAutoCloseInvestigation: true,
    })
    assert.equal(after.investigation, 'OPEN', 'a broken collector must not close an investigation')
  }
})

test('OPERATIONAL MAY AUTO-CLOSE, SECURITY MAY NOT', () => {
  // A collector that succeeds has demonstrably recovered. An account that stopped
  // being attacked has not been shown to be safe.
  const operational = applyObservation(OPENED, {
    evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: true,
  })
  assert.equal(operational.condition, 'CLEARED')
  assert.equal(operational.investigation, 'RESOLVED')

  const security = applyObservation(OPENED, {
    evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: false,
  })
  assert.equal(security.condition, 'CLEARED', 'the condition still clears — that is an observation, and it is true')
  assert.equal(security.investigation, 'OPEN', 'but the question stays open for a person')
})

test('a cleared condition never erases who owns it', () => {
  const owned = acknowledge(OPENED)
  const after = applyObservation(owned, {
    evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: true,
  })
  assert.equal(after.ownership, 'ACKNOWLEDGED')
})

test('acknowledging touches ownership only', () => {
  for (const before of everyLifecycle()) {
    const after = acknowledge(before)
    assert.equal(after.ownership, 'ACKNOWLEDGED')
    assert.equal(after.condition, before.condition, 'acknowledging is not saying the activity stopped')
    assert.equal(after.investigation, before.investigation, 'acknowledging is not resolving')
  }
})

test('resolving touches the investigation only, and is allowed while the condition is live', () => {
  // Deliberate: an operator may conclude an ongoing lockout storm is a
  // misconfigured service account and close the question without the activity
  // stopping. Refusing that makes the queue unclosable exactly where a human has
  // the answer.
  for (const before of everyLifecycle()) {
    const after = resolveInvestigation(before)
    assert.equal(after.investigation, 'RESOLVED')
    assert.equal(after.condition, before.condition)
    assert.equal(after.ownership, before.ownership)
  }
  const live = resolveInvestigation({ ownership: 'ACKNOWLEDGED', condition: 'ACTIVE', investigation: 'OPEN' })
  assert.equal(live.condition, 'ACTIVE')
  assert.equal(live.investigation, 'RESOLVED')
})

test('an observation never reopens an investigation a person resolved', () => {
  const resolved: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'RESOLVED' }
  const after = applyObservation(resolved, {
    evidence: readable, conditionCleared: false, mayAutoCloseInvestigation: true,
  })
  assert.equal(after.condition, 'ACTIVE', 'the condition is live again')
  assert.equal(after.investigation, 'RESOLVED', 'but the resolved question is not silently reopened here')
  // Re-opening is the recurrence layer's job, and it opens a NEW linked episode
  // rather than mutating this one — see alert-recurrence.test.ts.
})

test('an unknown condition still wants attention', () => {
  // Not being able to see is itself something to act on, so UNKNOWN must not read
  // as "nothing to do here".
  assert.equal(needsAttention({ ownership: 'ACKNOWLEDGED', condition: 'UNKNOWN', investigation: 'OPEN' }), true)
  // A resolved investigation is finished, whatever the condition says.
  assert.equal(needsAttention({ ownership: 'ACKNOWLEDGED', condition: 'ACTIVE', investigation: 'RESOLVED' }), false)
  // Cleared and owned is finished for attention purposes; cleared and unowned is
  // not, because nobody has looked at it.
  assert.equal(needsAttention({ ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'OPEN' }), false)
  assert.equal(needsAttention({ ownership: 'UNACKNOWLEDGED', condition: 'CLEARED', investigation: 'OPEN' }), true)
})

test('A RECORD IS NEITHER OPEN NOR RESOLVED, and is not in the queue', () => {
  // NONE exists because neither other value is correct, which only became visible
  // once records were allowed to escalate. OPEN would put every routine directory
  // change into the queue nobody can empty — the 301 defect rebuilt. RESOLVED
  // reads as "a person closed this", and would make every recurrence open a new
  // linked episode, manufacturing an episode per event.
  assert.equal(RECORDED.investigation, 'NONE')
  assert.equal(RECORDED.condition, 'ACTIVE')
  assert.equal(needsAttention(RECORDED), false, 'a record belongs in a list, not a queue')

  // POSITIVE CONTROL: the same shape with an investigation DOES want attention,
  // so the line above is about being a record rather than about the condition.
  assert.equal(needsAttention({ ...RECORDED, investigation: 'OPEN' }), true)
})

test('a record never acquires an investigation by going quiet', () => {
  // Becoming an investigation is a deliberate act on new evidence, never a side
  // effect of the condition clearing — otherwise a quiet record would silently
  // join the queue it was designed to stay out of.
  for (const mayAutoCloseInvestigation of [true, false]) {
    const after = applyObservation(RECORDED, {
      evidence: readable, conditionCleared: true, mayAutoCloseInvestigation,
    })
    assert.equal(after.condition, 'CLEARED')
    assert.equal(after.investigation, 'NONE', 'a record must not be resolved, because it was never open')
  }

  // POSITIVE CONTROL: the same call on a real investigation does resolve it when
  // permitted, so the above is about the record and not an inert function.
  const real = applyObservation(OPENED, {
    evidence: readable, conditionCleared: true, mayAutoCloseInvestigation: true,
  })
  assert.equal(real.investigation, 'RESOLVED')
})

test('promotion opens an investigation UNOWNED, and leaves everything else alone', () => {
  const owned = acknowledge(RECORDED)
  assert.equal(owned.ownership, 'ACKNOWLEDGED')

  const promoted = openInvestigation(owned)
  assert.equal(promoted.investigation, 'OPEN')
  // Unowned for the same reason a new episode is: nobody has yet looked at this
  // AS an investigation, and pre-filling an owner hides it from the queue it was
  // just promoted into.
  assert.equal(promoted.ownership, 'UNACKNOWLEDGED')
  assert.equal(promoted.condition, owned.condition, 'promotion says nothing about the condition')

  // A no-op on anything that already has an investigation, so it cannot reopen a
  // resolved one by a side door.
  const resolved: AlertLifecycle = { ownership: 'ACKNOWLEDGED', condition: 'CLEARED', investigation: 'RESOLVED' }
  assert.deepEqual(openInvestigation(resolved), resolved)
  assert.deepEqual(openInvestigation(OPENED), OPENED)
})
