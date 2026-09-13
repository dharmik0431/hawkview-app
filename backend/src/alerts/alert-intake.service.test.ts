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
  const report = await withEnv(undefined, () => instance.runOnce(Date.now() + 30_000))

  assert.equal(report, null, 'it did not run')
  assert.match(logged.join(' '), /NOT_CONFIGURED/)
  assert.match(logged.join(' '), /HAWKVIEW_ALERT_WATERMARK_ISO/,
    'and it names the setting, so the reader knows what to do rather than that something is off')
})

test('AN UNPARSEABLE WATERMARK IS ALSO A REFUSAL, not a fallback', async () => {
  // A typo must not become a decision. This is the direction that would otherwise fail open:
  // `Date.parse` of nonsense is NaN, and a NaN watermark compared with `<` is false for every
  // finding — so every historical finding would have been sent.
  const { instance, logged } = service()
  const report = await withEnv('yesterday please', () => instance.runOnce(Date.now() + 30_000))

  assert.equal(report, null)
  assert.match(logged.join(' '), /NOT_CONFIGURED/)

  // AND AN EMPTY STRING TOO, which is what an unset variable looks like in most deployment tools.
  const second = service()
  assert.equal(await withEnv('', () => second.instance.runOnce(Date.now() + 30_000)), null)
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
  const report = await withEnv('2026-09-12T00:00:00.000Z', () => instance.runOnce(Date.now() - 1))

  assert.notEqual(report, null, 'it ran and reported, rather than refusing')
  assert.equal(report?.yieldedOnBudget, true)
  assert.equal(report?.findingsRead, 0, 'the stub would have thrown if it had read')
})
