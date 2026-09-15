import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { queueSummary } from './queue-summary.ts'

test('a zero over unread tenants is not a zero over read ones', () => {
  // THE TEST THE PM SET, APPLIED TO THIS SURFACE: can it distinguish an empty
  // list from an unreadable one, or does it have only a number? The old line
  // had only `sortedQueueItems.length`, so both were "0 matching alerts".
  const allRead = queueSummary(0, { inScope: 14, read: 14 }, false)
  const someUnread = queueSummary(0, { inScope: 14, read: 10 }, false)

  assert.notDeepEqual(allRead, someUnread)
  assert.notEqual(allRead.empty!.title, someUnread.empty!.title)
  assert.equal(allRead.complete, true)
  assert.equal(someUnread.complete, false)

  // And the unread one must not be read as a statement about those tenants.
  assert.match(someUnread.empty!.detail, /not a complete answer/)
  assert.match(someUnread.empty!.detail, /not a statement that those tenants are quiet/)
})

test('"try adjusting filters" is only said when filters could be the cause', () => {
  // The sentence blamed the reader's filters for every empty queue. With
  // tenants unread it is wrong about the cause; with no filters set it is
  // advice to adjust something that is not narrowing anything.
  const filtered = queueSummary(0, { inScope: 5, read: 5 }, true)
  assert.match(filtered.empty!.detail, /Try adjusting filters/)

  for (const summary of [
    queueSummary(0, { inScope: 5, read: 5 }, false),
    queueSummary(0, { inScope: 5, read: 3 }, true),
    queueSummary(0, { inScope: 5, read: 3 }, false),
  ]) {
    assert.ok(
      !/Try adjusting filters/.test(summary.empty!.detail),
      'blamed the filters: ' + summary.empty!.detail
    )
  }
})

test('an incomplete count never travels alone', () => {
  // "12 matching alerts" and "12 matching alerts across 10 of 14 tenants" are
  // different claims and only the second is supported. The alerts found are
  // still real -- the number is a floor, not a fiction -- so it is qualified
  // rather than withheld.
  const partial = queueSummary(12, { inScope: 14, read: 10 }, false)
  assert.match(partial.headline, /12 matching alerts/)
  assert.match(partial.headline, /10 of 14 tenants/)
  assert.equal(partial.complete, false)
  assert.equal(partial.empty, null, 'a populated queue rendered an empty state')

  // The control: a complete count says the number plainly, with no hedge that
  // would make every screen read as doubtful.
  const whole = queueSummary(12, { inScope: 14, read: 14 }, false)
  assert.equal(whole.headline, '12 matching alerts')
  assert.equal(whole.complete, true)
})

test('the four ways of being empty are four different sentences', () => {
  // Swept rather than sampled, and compared as a SET, so a change collapsing
  // any two of them fails here. Two of the four were one sentence before.
  const cases = [
    queueSummary(0, { inScope: 5, read: 5 }, true),
    queueSummary(0, { inScope: 5, read: 5 }, false),
    queueSummary(0, { inScope: 5, read: 3 }, true),
    queueSummary(0, { inScope: 5, read: 3 }, false),
  ]
  const titles = new Set(cases.map((each) => each.empty!.title))
  const details = new Set(cases.map((each) => each.empty!.detail))
  // The two unread cases share a sentence deliberately -- the filters are not
  // the story when tenants could not be read -- so three distinct answers, not
  // four.
  assert.equal(titles.size, 3, 'empty-state titles collapsed')
  assert.equal(details.size, 3, 'empty-state details collapsed')

  // Every one of them says something.
  for (const each of cases) {
    assert.ok(each.empty, 'an empty queue rendered no explanation')
    assert.ok(each.empty!.title.length > 0 && each.empty!.detail.length > 0)
  }
})

test('grammar follows the numbers, including the one-tenant fleet', () => {
  // A single-tenant MSP is the common case at the start, and "1 tenants" on the
  // first screen somebody sees is the kind of thing that makes the rest look
  // careless.
  assert.match(queueSummary(1, { inScope: 3, read: 3 }, false).headline, /1 matching alert\b/)
  assert.match(queueSummary(2, { inScope: 3, read: 3 }, false).headline, /2 matching alerts\b/)
  assert.match(
    queueSummary(0, { inScope: 1, read: 0 }, false).headline,
    /0 of 1 tenant\b/
  )
  assert.match(
    queueSummary(0, { inScope: 1, read: 0 }, false).empty!.detail,
    /1 of 1 tenant did not report/
  )
  assert.match(
    queueSummary(0, { inScope: 4, read: 1 }, false).empty!.detail,
    /3 of 4 tenants did not report/
  )
})

test('coverage that cannot happen does not produce a negative shortfall', () => {
  // `read` greater than `inScope` should be impossible, and if a refactor ever
  // makes it possible the summary must not print "-2 tenants did not report".
  // A nonsense number on screen is worse than the bug that caused it, because
  // it is the part a reader will try to act on.
  const odd = queueSummary(0, { inScope: 2, read: 5 }, false)
  assert.equal(odd.complete, true)
  assert.ok(!/-/.test(odd.headline), 'negative shortfall in the headline')
  assert.ok(!/-\d/.test(odd.empty!.detail), 'negative shortfall in the detail')
})

test('the dashboard actually uses this, and no longer renders a bare length', () => {
  // A WIRING CHECK, ADDED BECAUSE THE MUTATION SWEEP ASKED FOR ONE. Replacing
  // the heading with `{sortedQueueItems.length} matching alerts` again killed
  // NOTHING -- every test above exercises queueSummary, and none of them can
  // see whether the page calls it. The bell needed the same check for the same
  // reason, and there it was the preview that misled me: a harness rendering
  // its own copy of the markup proves the function works, not that the screen
  // uses it.
  const page = readFileSync(
    new URL('../../app/(protected)/dashboard/page.tsx', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')

  // POSITIVE CONTROL. If the page moved, every assertion below would pass over
  // an empty string.
  assert.ok(
    page.includes('Priority Action Queue'),
    'did not find the dashboard queue where this test expects it'
  )

  assert.ok(page.includes('queueSummary('), 'the page does not call queueSummary')
  assert.ok(
    page.includes('{queue.headline}'),
    'the queue heading is not rendered from the summary'
  )
  assert.ok(
    page.includes('{queue.empty.title}'),
    'the empty state is not rendered from the summary'
  )

  // THE OLD CLAIMS MUST BE GONE, not merely joined by the new ones. Comments
  // are stripped first: the comment explaining this fix quotes the old
  // sentence, and a check that reads prose as behaviour is wrong in both
  // directions -- it can fail on an explanation, and pass on one while the
  // code beside it is wrong.
  const code = page
    .split(String.fromCharCode(10))
    .filter((line) => {
      const t = line.trim()
      return !(
        t.startsWith('//') ||
        t.startsWith('{/*') ||
        t.startsWith('/*') ||
        t.startsWith('*') ||
        t.startsWith('*/}') ||
        t.endsWith('*/}') ||
        t.endsWith('*/')
      )
    })
    .join(String.fromCharCode(10))

  assert.ok(
    !code.includes('{sortedQueueItems.length} matching'),
    'the queue heading still renders a bare count'
  )
  assert.ok(
    !code.includes('Try adjusting filters or search query.'),
    'the unconditional "try adjusting filters" sentence is still in the page'
  )

  // Control: the phrase must still be reachable through the summary, or the
  // assertion above would be satisfied by deleting the advice entirely -- and
  // it is correct advice in the one case where filters really are the cause.
  assert.match(
    queueSummary(0, { inScope: 3, read: 3 }, true).empty!.detail,
    /Try adjusting filters/
  )
})
