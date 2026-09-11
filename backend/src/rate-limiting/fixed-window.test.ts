import assert from 'node:assert/strict'
import test from 'node:test'
import { FixedWindowCounter } from './fixed-window.js'

/** The counter, with a clock passed in rather than read, so every assertion
 * about a window boundary is exact instead of timing-dependent. */

test('requests are allowed up to the limit and refused past it', () => {
  const counter = new FixedWindowCounter(3, 60_000)
  assert.equal(counter.hit('a', 0).allowed, true)
  assert.equal(counter.hit('a', 1).allowed, true)
  const third = counter.hit('a', 2)
  assert.equal(third.allowed, true)
  assert.equal(third.count, 3)

  const fourth = counter.hit('a', 3)
  assert.equal(fourth.allowed, false)
  assert.equal(fourth.count, 4)
  assert.equal(fourth.limit, 3)
})

test('two keys do not share an allowance', () => {
  // THE PROPERTY A PER-CALLER LIMIT IS FOR. If keys shared a window, every limit
  // in this module would silently be a global limit — the exact defect that
  // reading an untrusted address would introduce one module over.
  const counter = new FixedWindowCounter(1, 60_000)
  assert.equal(counter.hit('a', 0).allowed, true)
  assert.equal(counter.hit('b', 0).allowed, true)
  assert.equal(counter.hit('c', 0).allowed, true)
  // POSITIVE CONTROL: the limit is real, so the three passes above are about
  // separate keys rather than a counter that never refuses anything.
  assert.equal(counter.hit('a', 0).allowed, false)
})

test('the window closes and the allowance returns', () => {
  const counter = new FixedWindowCounter(1, 60_000)
  assert.equal(counter.hit('a', 0).allowed, true)
  assert.equal(counter.hit('a', 59_999).allowed, false)
  // Exactly at the boundary the old window is over, not still running.
  assert.equal(counter.hit('a', 60_000).allowed, true)
})

test('retry-after counts down and never reaches zero', () => {
  // A Retry-After of 0 reads as "no wait required" to anything parsing it, which
  // invites the immediate retry the header exists to prevent.
  const counter = new FixedWindowCounter(1, 60_000)
  assert.equal(counter.hit('a', 0).retryAfterSeconds, 60)
  assert.equal(counter.hit('a', 30_000).retryAfterSeconds, 30)
  assert.equal(counter.hit('a', 59_999).retryAfterSeconds, 1)
})

test('peek reports without spending the allowance', () => {
  const counter = new FixedWindowCounter(1, 60_000)
  assert.equal(counter.peek('a', 0).count, 0)
  assert.equal(counter.peek('a', 0).count, 0, 'peeking twice must still have recorded nothing')
  // POSITIVE CONTROL: hitting does record, so the zeroes above are peek's
  // behaviour and not a counter that fails to count.
  assert.equal(counter.hit('a', 0).count, 1)
  assert.equal(counter.peek('a', 0).count, 1)
})

test('a limit below one request is refused at construction', () => {
  // A zero limit would refuse every request on every route — the failure this
  // whole component must not be able to cause. Better to fail to start than to
  // start and refuse everything.
  assert.throws(() => new FixedWindowCounter(0, 60_000), /at least one request/)
  assert.throws(() => new FixedWindowCounter(-1, 60_000), /at least one request/)
  assert.throws(() => new FixedWindowCounter(1.5, 60_000), /whole number/)
  assert.throws(() => new FixedWindowCounter(1, 0), /positive whole number/)
})

test('expired keys are reclaimed rather than accumulating', () => {
  // An attacker rotating keys must not be able to grow the heap without bound.
  const counter = new FixedWindowCounter(10, 60_000, 50)
  for (let index = 0; index < 50; index += 1) counter.hit('key-' + index, 0)
  assert.equal(counter.size(), 50)

  // A later request, once every one of those windows has closed, finds room by
  // dropping the expired ones instead of evicting anything live.
  counter.hit('fresh', 60_000)
  assert.ok(counter.size() <= 50, 'the cap must hold')
  assert.equal(counter.evictionsUnderPressure(), 0, 'expired keys should be reclaimed without a live eviction')
})

test('a cap reached with nothing expired degrades the limiter, not the product', () => {
  // Deliberate: when every tracked window is still live, a new caller is
  // admitted and the soonest-to-expire key is forgiven. The alternative is
  // refusing a caller who has done nothing because somebody else is flooding.
  const counter = new FixedWindowCounter(1, 60_000, 2)
  counter.hit('first', 0)
  counter.hit('second', 10)
  counter.hit('third', 20)

  assert.ok(counter.size() <= 2, 'the cap must hold even under pressure')
  assert.equal(counter.evictionsUnderPressure(), 1, 'the degradation must be countable, not silent')
  // And the newcomer was admitted rather than refused.
  assert.equal(counter.peek('third', 20).count, 1)
})
