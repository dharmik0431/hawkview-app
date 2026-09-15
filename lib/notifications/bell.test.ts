import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bellIndicator, bellLabel } from './bell.ts'
import { type NotificationFeedState } from './feed-state.ts'

const STATES: NotificationFeedState[] = [
  'LOADING',
  'LOADED',
  'UNAVAILABLE',
  'STALE',
]

test('the rule the bell used to follow collapses two different answers', () => {
  // THE DEFECT, WRITTEN DOWN SO IT CANNOT COME BACK QUIETLY. The bell rendered
  // `unreadCount > 0 && <badge>`, and unreadCount is derived from the list --
  // which is empty when nothing has ever loaded. So "we could not look" and
  // "nothing is waiting" drew the identical bell.
  const oldRule = (_state: NotificationFeedState, unread: number) => unread > 0
  assert.equal(oldRule('UNAVAILABLE', 0), oldRule('LOADED', 0))

  // The new rule separates them, which is the whole point.
  assert.notDeepEqual(bellIndicator('UNAVAILABLE', 0), bellIndicator('LOADED', 0))
})

test('only a state that may be read as quiet renders as quiet', () => {
  // Swept over every feed state rather than sampled. Exactly one may reassure,
  // and the others are statements about HawkView rather than about the tenant --
  // a bare bell in any of them is the empty-inbox lie one level up, arriving as
  // an absence instead of a sentence.
  assert.deepEqual(bellIndicator('LOADED', 0), { kind: 'QUIET' })
  for (const state of STATES.filter((each) => each !== 'LOADED')) {
    const indicator = bellIndicator(state, 0)
    assert.equal(
      indicator.kind,
      'UNKNOWN',
      state + ' drew a bell that reads as "nothing needs you"'
    )
  }
})

test('a count we actually have is shown in every state, and qualified in STALE', () => {
  // The control for the rule above. It would be satisfied by a bell that never
  // shows a number at all, which would be useless -- and by one that hides the
  // count whenever a refresh fails, which throws away rows a successful read
  // really returned.
  for (const state of STATES) {
    const indicator = bellIndicator(state, 3)
    assert.equal(indicator.kind, 'COUNT', state + ' discarded a real count')
    assert.equal(indicator.kind === 'COUNT' && indicator.unread, 3)
  }

  // STALE says the number was true at a known point, rather than now.
  const stale = bellIndicator('STALE', 3)
  const fresh = bellIndicator('LOADED', 3)
  assert.equal(stale.kind === 'COUNT' && stale.asOfLastCheck, true)
  assert.equal(fresh.kind === 'COUNT' && fresh.asOfLastCheck, false)
  assert.notDeepEqual(stale, fresh)
})

test('a stale zero is not a fresh zero', () => {
  // The subtle one. STALE means a read succeeded before and the latest did not,
  // so a zero is "nothing was waiting when we last managed to look" -- which is
  // not "nothing is waiting". Collapsing it into QUIET would reassure from a
  // measurement that is, by definition, out of date.
  assert.equal(bellIndicator('STALE', 0).kind, 'UNKNOWN')
  assert.notDeepEqual(bellIndicator('STALE', 0), bellIndicator('LOADED', 0))
})

test('the label never asserts a zero it does not have', () => {
  // The aria-label was the more explicit version of the same lie: it
  // interpolated the count unconditionally, so it announced "0 unread" over an
  // inbox nobody had managed to read. A sighted reader saw an unmarked bell;
  // this asserted the zero out loud.
  for (const state of STATES.filter((each) => each !== 'LOADED')) {
    const label = bellLabel(bellIndicator(state, 0))
    assert.ok(
      !/\b0 unread\b/.test(label) && !/none unread/.test(label),
      state + ' announced a zero it did not have: ' + label
    )
  }

  // And the state that DOES have one says so plainly, or the rule above could
  // be met by a label that never commits to anything.
  assert.equal(bellLabel(bellIndicator('LOADED', 0)), 'Notifications (none unread)')
  assert.match(bellLabel(bellIndicator('LOADED', 3)), /3 unread/)
  assert.match(
    bellLabel(bellIndicator('STALE', 3)),
    /as of the last successful check/
  )
})

test('every state produces an indicator; none produces nothing', () => {
  // THE INVARIANT TURNED BACKWARDS ON THE BELL. The settings page needed
  // "always loading, explaining, or listing" because the state that produced
  // NEITHER rendered as blank space, and a reader takes blank space for
  // "nothing here". The bell's version of blank space is an unmarked bell, and
  // it was reachable from two of the four states.
  for (const state of STATES) {
    for (const unread of [0, 1, 99, 100]) {
      const indicator = bellIndicator(state, unread)
      assert.ok(
        ['COUNT', 'QUIET', 'UNKNOWN'].includes(indicator.kind),
        state + '/' + unread + ' produced no indicator at all'
      )
      assert.ok(
        bellLabel(indicator).length > 0,
        state + '/' + unread + ' produced an empty label'
      )
    }
  }

  // Controls: all three arms must be reachable, or the sweep is satisfied by a
  // function that always returns the same thing.
  const kinds = new Set(
    STATES.flatMap((state) => [0, 5].map((n) => bellIndicator(state, n).kind))
  )
  assert.equal(kinds.size, 3, 'not every indicator arm is reachable')
})

test('the panel actually uses this, and no longer decides from the count alone', () => {
  // A WIRING CHECK, BECAUSE THE RULE BEING RIGHT IS NOT THE SAME AS IT REACHING
  // THE SCREEN. Everything above tests bellIndicator; none of it can tell
  // whether notification-panel.tsx calls it. The preview that confirmed the six
  // states visually rendered its own copy of the markup, so it proved the
  // function works and not that the panel consults it -- the same gap as a
  // harness that reimplements the page it is meant to be checking.
  const LF = String.fromCharCode(10)
  const panel = readFileSync(
    new URL('../../components/layout/notification-panel.tsx', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')

  // POSITIVE CONTROL FIRST. If the file moved or was renamed, every assertion
  // below would pass over an empty string.
  assert.ok(
    panel.includes('function NotificationPanel') ||
      panel.includes('export function NotificationPanel') ||
      panel.includes('AlertBadges'),
    'did not find the notification panel where this test expects it'
  )

  assert.ok(
    panel.includes('bellIndicator(feedState, unreadCount)'),
    'the panel does not derive its bell from the feed state'
  )
  assert.ok(panel.includes('bellLabel(indicator)'), 'the aria-label is not derived')

  // THE OLD RULE FOR THE HEADER CHIP MUST BE GONE. It decided "All read" from
  // the count alone, four lines above EmptyInbox saying the opposite.
  assert.ok(
    !panel.includes('{unreadCount > 0 ? ('),
    'the header chip still decides "All read" from the count alone'
  )

  // A CLAIM MAY NOT COME FROM THE BARE COUNT; AN ACTION MAY. The first draft of
  // this test banned `{unreadCount > 0 && (` outright and failed on the "Mark
  // all read" button -- which is correct code. Hiding a button that would do
  // nothing asserts nothing about the tenant; a badge is a statement. So the
  // rule is about what follows the condition, not the condition.
  let at = panel.indexOf('{unreadCount > 0 && (')
  let gates = 0
  while (at !== -1) {
    gates += 1
    const follows = panel.slice(at, at + 200)
    assert.ok(
      follows.includes('<button'),
      'something other than an action is gated on the bare unread count: ' +
        follows.slice(0, 120)
    )
    at = panel.indexOf('{unreadCount > 0 && (', at + 1)
  }
  // Control: if that pattern vanished entirely the loop would pass vacuously,
  // and the assertion would stop covering anything.
  assert.ok(gates >= 1, 'no bare-count gate remains, so the loop asserted nothing')

  // COMMENTS STRIPPED FIRST, and by a line filter rather than a regex. The
  // comment explaining this very fix quotes the string "All read", so the
  // search found the explanation instead of the code and failed. A check that
  // reads prose as if it were behaviour is wrong in both directions: it failed
  // here, and it could equally have passed on a comment while the code was
  // wrong.
  const code = panel
    .split(LF)
    .filter((line) => {
      const t = line.trim()
      return !(
        t.startsWith('//') ||
        t.startsWith('{/*') ||
        t.startsWith('*') ||
        t.startsWith('*/}') ||
        t.endsWith('*/}')
      )
    })
    .join(LF)

  const allRead = code.indexOf('All read')
  assert.ok(allRead !== -1, 'the quiet state lost its copy entirely')
  const before = code.slice(Math.max(0, allRead - 400), allRead)
  assert.ok(
    before.includes("indicator.kind === 'QUIET'"),
    '"All read" is not gated on the indicator saying the inbox is quiet'
  )
})
