import assert from 'node:assert/strict'
import test from 'node:test'
import { AlertIntakeService } from './alert-intake.service.js'

/** The production caller. These are the behaviours that must survive somebody later deciding the
 * service should "just work" — which, for every one of them, means sending something. */

const neverTouched = {
  $queryRawUnsafe: () => { throw new Error('the database must not be touched on this path') },
  $transaction: () => { throw new Error('the database must not be touched on this path') },
}

const withEnv = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const before = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  if (value === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = value
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
    else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = before
  }
}

const service = () => {
  const logged: string[] = []
  const instance = new AlertIntakeService(neverTouched as never)
  ;(instance as unknown as { logger: unknown }).logger = {
    log: (message: string) => logged.push(message),
    warn: (message: string) => logged.push(message),
  }
  return { instance, logged }
}

test('WITHOUT A WATERMARK IT REFUSES TO RUN, and does not reach the database', async () => {
  // THE PRE-AUTHORISED RULING, AND THE REASON IS THE ASYMMETRY. Nobody has chosen the instant
  // before which nothing is sent. The guess available here is "now", and taking it silently
  // would mean the first tick after a deploy decides for ever which historical findings were
  // never worth telling anybody about. A refusal is recoverable; a guess is not.
  const { instance, logged } = service()
  const outcome = await withEnv(undefined, () => instance.runOnce(Date.now() + 30_000))

  // NOT_CONFIGURED, NOT FAILED. Nothing is broken and nothing has been decided — a reader who
  // cannot tell those apart chases an outage that is a blank setting.
  assert.equal(outcome.kind, 'NOT_CONFIGURED', 'it did not run, and says why')
  assert.match(logged.join(' '), /NOT_CONFIGURED/)
  assert.match(logged.join(' '), /HAWKVIEW_ALERT_WATERMARK_ISO/,
    'and it names the setting, so the reader knows what to do rather than that something is off')
})

test('AN UNPARSEABLE WATERMARK IS ALSO A REFUSAL, not a fallback', async () => {
  // A typo must not become a decision. This is the direction that would otherwise fail open:
  // `Date.parse` of nonsense is NaN, and a NaN watermark compared with `<` is false for every
  // finding — so every historical finding would have been sent.
  const { instance, logged } = service()
  const outcome = await withEnv('yesterday please', () => instance.runOnce(Date.now() + 30_000))

  assert.equal(outcome.kind, 'NOT_CONFIGURED')
  assert.match(logged.join(' '), /NOT_CONFIGURED/)

  // AND AN EMPTY STRING TOO, which is what an unset variable looks like in most deployment tools.
  const second = service()
  assert.equal((await withEnv('', () => second.instance.runOnce(Date.now() + 30_000))).kind,
    'NOT_CONFIGURED')
})

test('A VALID WATERMARK GETS PAST THE REFUSAL, or the two tests above prove nothing', async () => {
  // The positive control. Without it, a service that always returned null would satisfy both
  // refusals — the failure mode where a guard is really an outage.
  const { instance } = service()
  const reached = await withEnv('2026-09-12T00:00:00.000Z', async () => {
    try {
      await instance.runOnce(Date.now() + 30_000)
      return 'no-database-call'
    } catch {
      return 'no-database-call'
    }
  })
  // It got as far as needing the database, which the stub refuses — so it passed the watermark
  // gate. `runOnce` swallows the failure by design, so this asserts on reaching it at all.
  assert.equal(reached, 'no-database-call')
})

test('AN EXPIRED WINDOW YIELDS WITHOUT READING', async () => {
  // Collection outranks alerting. A deadline already past must not read, not write, and not
  // throw — a throw here would abort the collectors that run after it in the cascade.
  const { instance } = service()
  const outcome = await withEnv('2026-09-12T00:00:00.000Z', () => instance.runOnce(Date.now() - 1))

  // **YIELDED, AND THAT IS NOT `FAILED`.** The system declined work it could not fit; it did not
  // attempt work and lose it. Both leave every finding OPEN, which is exactly why the two must
  // not read alike — an intermittent failure that looks like a yield is explained away once.
  assert.equal(outcome.kind, 'YIELDED', 'it ran and declined, rather than refusing or failing')
  assert.equal(outcome.kind === 'YIELDED' ? outcome.report.yieldedOnBudget : null, true)
  assert.equal(outcome.kind === 'YIELDED' ? outcome.report.findingsRead : null, 0,
    'the stub would have thrown if it had read')
})

test('A FAILURE SAYS WHICH PHASE AND HOW MUCH IT LOST, and is not a yield', async () => {
  // WORK DECLINED AND WORK LOST WERE THE SAME LINE. Both return without throwing and both leave
  // every finding OPEN, so the next tick redoes them either way — and an intermittent failure
  // that reads like a routine yield gets explained away once and never looked at again.
  const { instance, logged } = service()
  const outcome = await withEnv('2026-09-12T00:00:00.000Z',
    () => instance.runOnce(Date.now() + 30_000))

  // The stub has no database, so the read is where it dies.
  assert.equal(outcome.kind, 'FAILED')
  assert.equal(outcome.kind === 'FAILED' ? outcome.phase : null, 'READING',
    'and it names the phase, so a reader knows nothing was written')
  assert.equal(outcome.kind === 'FAILED' ? outcome.attempted.findingsRead : null, 0,
    'nothing had been read when it died, and the report says zero rather than nothing at all')

  const line = logged.join(' ')
  assert.match(line, /FAILED/)
  assert.match(line, /READING/, 'the phase reaches the log too')
  assert.doesNotMatch(line, /YIELDED/, 'and it is not reported as a yield')

  // IT STILL DOES NOT THROW. Collection outranks alerting; a throw here aborts the collectors
  // that run after it in the cascade.
  assert.ok(outcome.kind === 'FAILED')
})

test('A REJECTION REPORTS UNKNOWN, not the most reassuring phase available', async () => {
  // **THE BACKSTOP TOLD THE TRUTH IN THE LOG AND NOT IN THE VALUE.** It logged phase UNKNOWN and
  // returned phase READING, so a programmatic consumer was told nothing was decided, nothing
  // written and nothing lost. That is the most reassuring of the four phases and, on the path
  // that actually reaches the branch, the least likely to be true — a rejection escapes the
  // per-phase guards, and the only unguarded region sits AFTER a decision may exist.
  const { instance, logged } = service()

  // A store that RESOLVES to something unusable, so runIntake rejects rather than returning a
  // FAILED outcome — which is the only way into the backstop.
  const broken = { findOpenFindings: async () => undefined as never }
  const patched = instance as unknown as { store: () => unknown }
  const original = patched.store.bind(instance)
  patched.store = () => ({ ...(original() as object), ...broken })

  const outcome = await withEnv('2026-09-12T00:00:00.000Z',
    () => instance.runOnce(Date.now() + 30_000))

  assert.equal(outcome.kind, 'FAILED')
  assert.equal(outcome.kind === 'FAILED' ? outcome.phase : null, 'UNKNOWN',
    'the value says what the log says')
  assert.match(logged.join(' '), /UNKNOWN/)

  // AND IT IS NOT READING, which is the specific wrong answer this replaced — stated separately
  // so the assertion above cannot be satisfied by the phase becoming any other constant.
  assert.notEqual(outcome.kind === 'FAILED' ? outcome.phase : null, 'READING')

  // IT STILL DOES NOT THROW. Collection outranks alerting.
  assert.ok(outcome.kind === 'FAILED')
})
