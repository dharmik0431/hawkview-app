// QA — the retry layer's checks, written against a REFERENCE the code does not have to match.
// Each check must (a) pass the reference, (b) catch the variant it declares, (c) stay quiet on
// every other variant. A check that fires on everything is not a check.
import {
  PRE_REGISTERED_RETRY,
  type Attempt, type AttemptResult, type Claim, type ClaimResult,
  type LogicalMessageId, type RetryJob, type RetrySeam, type RetryStore,
} from './qa-retry-contract.js'
import { idempotencyKey, messageId, providerMessageId } from './email-delivery.js'

type Variant =
  | 'reference' | 'enqueue-appends-blindly' | 'bound-held-by-runner' | 'exhausted-is-removed'
  | 'attempt-recorded-on-finish' | 'claim-ignores-expectations' | 'refusal-becomes-exhausted'
  | 'claims-terminal-jobs'

const lid = (s: string) => s as LogicalMessageId
const started = (n: number, at: string): Attempt => ({ ordinal: n, startedAtIso: at, finished: null })

/** THE REFERENCE. Deliberately small; it exists to make the checks falsifiable, not to be used. */
const build = (variant: Variant): RetrySeam => ({
  enqueue: (store, job, nowIso) => {
    if (variant !== 'enqueue-appends-blindly'
      && store.jobs.some((j) => j.logicalMessageId === job.logicalMessageId)) return store
    return { jobs: [...store.jobs, { ...job, attempts: [], state: { kind: 'WAITING', notBeforeIso: nowIso } }] }
  },

  claim: (store, claim: Claim) => {
    const job = store.jobs.find((j) => j.logicalMessageId === claim.logicalMessageId)
    if (job === undefined) return { store, result: { kind: 'LOST', because: 'NO_SUCH_JOB' } as ClaimResult }
    // R10 - A TERMINAL STATE IS NOT CLAIMABLE. Found by R2 failing against my own reference:
    // without this, an EXHAUSTED job can be claimed again and the bound means nothing.
    const terminal = job.state.kind === 'SENT' || job.state.kind === 'EXHAUSTED' || job.state.kind === 'GAVE_UP'
    if (terminal && variant !== 'claims-terminal-jobs') return { store, result: { kind: 'LOST', because: 'STATE_MOVED' } }
    if (variant !== 'claim-ignores-expectations') {
      if (job.state.kind !== claim.expectedState) return { store, result: { kind: 'LOST', because: 'STATE_MOVED' } }
      if (job.attempts.length !== claim.expectedAttempts) return { store, result: { kind: 'LOST', because: 'ATTEMPTS_MOVED' } }
    }
    const ordinal = job.attempts.length + 1
    // THE ATTEMPT IS WRITTEN HERE, BEFORE THE SEND. The variant writes it on finish instead,
    // which is what makes a crashed attempt invisible.
    const next: RetryJob = {
      ...job,
      attempts: variant === 'attempt-recorded-on-finish' ? job.attempts : [...job.attempts, started(ordinal, claim.atIso)],
      state: { kind: 'IN_FLIGHT', since: claim.atIso, attemptOrdinal: ordinal },
    }
    return { store: { jobs: store.jobs.map((j) => (j === job ? next : j)) }, result: { kind: 'CLAIMED', job: next } }
  },

  finish: (store, id, result: AttemptResult, nowIso) => {
    const job = store.jobs.find((j) => j.logicalMessageId === id)
    if (job === undefined) return store
    const attempts: readonly Attempt[] = variant === 'attempt-recorded-on-finish'
      ? [...job.attempts, { ordinal: job.attempts.length + 1, startedAtIso: nowIso, finished: result }]
      : job.attempts.map((a, i) => (i === job.attempts.length - 1 ? { ...a, finished: result } : a))

    if (result.kind === 'ACCEPTED') {
      return { jobs: store.jobs.map((j) => (j === job ? { ...j, attempts, state: { kind: 'SENT' as const, providerId: result.providerId, atIso: result.atIso } } : j)) }
    }
    // R9: A REFUSAL IS NOT AN EXHAUSTION. The variant collapses them.
    if (result.kind === 'REFUSED' && variant !== 'refusal-becomes-exhausted') {
      return { jobs: store.jobs.map((j) => (j === job ? { ...j, attempts, state: { kind: 'GAVE_UP' as const, because: result.code, atIso: result.atIso } } : j)) }
    }
    const because = result.kind === 'REFUSED' ? result.code : result.because
    // R2: THE BOUND IS READ OFF THE JOB. Nothing here takes a maxAttempts argument.
    const RUNNER_MAX = 1 // the variant's bound lives here, in the process, not on the job
    const allowed = variant === 'bound-held-by-runner' ? RUNNER_MAX : job.attemptsAllowed
    if (attempts.length >= allowed) {
      // R3: EXHAUSTION IS A STATE. The variant removes the job instead.
      if (variant === 'exhausted-is-removed') return { jobs: store.jobs.filter((j) => j !== job) }
      return { jobs: store.jobs.map((j) => (j === job ? { ...j, attempts, state: { kind: 'EXHAUSTED' as const, afterAttempts: attempts.length, lastBecause: because } } : j)) }
    }
    return { jobs: store.jobs.map((j) => (j === job ? { ...j, attempts, state: { kind: 'WAITING' as const, notBeforeIso: nowIso } } : j)) }
  },

  stranded: (store, nowIso, afterMs) => store.jobs.filter((j) =>
    j.state.kind === 'IN_FLIGHT'
    && j.attempts.some((a) => a.finished === null)
    && Date.parse(nowIso) - Date.parse(j.state.since) >= afterMs),

  accounting: (store) => {
    const problems: string[] = []
    for (const j of store.jobs) {
      if (j.attempts.length > j.attemptsAllowed) {
        problems.push(`${j.logicalMessageId} has ${j.attempts.length} attempts, allowed ${j.attemptsAllowed}`)
      }
    }
    return problems
  },
})

const EMPTY: RetryStore = { jobs: [] }
const seed = (allowed = 3) => ({
  logicalMessageId: lid('msg-1'), messageId: messageId('m1'),
  idempotencyKey: idempotencyKey('k1'), attemptsAllowed: allowed,
})
const T = (m: number) => new Date(Date.UTC(2026, 8, 12, 0, m, 0)).toISOString()
const err = (why: string, at: string): AttemptResult => ({ kind: 'ERRORED', because: why, atIso: at })

/** Drive a job through `n` failed attempts. */
const failTimes = (s: RetrySeam, store: RetryStore, n: number) => {
  let cur = store
  for (let i = 0; i < n; i += 1) {
    const job = cur.jobs.find((j) => j.logicalMessageId === lid('msg-1'))
    if (job === undefined) break
    const claimed = s.claim(cur, {
      logicalMessageId: lid('msg-1'), expectedState: job.state.kind,
      expectedAttempts: job.attempts.length, workerId: 'w1', atIso: T(i * 2),
    })
    cur = claimed.store
    if (claimed.result.kind === 'CLAIMED') cur = s.finish(cur, lid('msg-1'), err('boom', T(i * 2 + 1)), T(i * 2 + 1))
  }
  return cur
}

const CHECKS: Record<string, { catches: Variant; run: (s: RetrySeam) => boolean }> = {
  // R1 — enqueued twice, one job.
  R1: { catches: 'enqueue-appends-blindly', run: (s) =>
    s.enqueue(s.enqueue(EMPTY, seed(), T(0)), seed(), T(1)).jobs.length === 1 },

  // R2 — the bound is READ OFF THE JOB. The variant holds its own number in the process, so a
  // job allowed 3 exhausts after 1. Driving exactly one failure separates this from exhaustion.
  R2: { catches: 'bound-held-by-runner', run: (s) => {
    const after = failTimes(s, s.enqueue(EMPTY, seed(3), T(0)), 1)
    return after.jobs[0]?.state.kind === 'WAITING'
  } },

  // R10 — A TERMINAL STATE IS NOT CLAIMABLE. Found by R2 failing against my own reference: an
  // EXHAUSTED job that can be claimed again makes the bound meaningless.
  R10: { catches: 'claims-terminal-jobs', run: (s) => {
    const enq = s.enqueue(EMPTY, seed(), T(0))
    const c1 = s.claim(enq, { logicalMessageId: lid('msg-1'), expectedState: 'WAITING', expectedAttempts: 0, workerId: 'w1', atIso: T(0) })
    const sent = s.finish(c1.store, lid('msg-1'), { kind: 'ACCEPTED', providerId: providerMessageId('p1'), atIso: T(1) }, T(1))
    const again = s.claim(sent, { logicalMessageId: lid('msg-1'), expectedState: 'SENT', expectedAttempts: 1, workerId: 'w2', atIso: T(2) })
    return again.result.kind === 'LOST'
  } },

  // R3 — exhaustion is a STATE, and the job is still there to be seen.
  R3: { catches: 'exhausted-is-removed', run: (s) => {
    const after = failTimes(s, s.enqueue(EMPTY, seed(2), T(0)), 4)
    return after.jobs.length === 1 && after.jobs[0]?.state.kind === 'EXHAUSTED'
  } },

  // R4 — an attempt that started and never finished is visible.
  R4: { catches: 'attempt-recorded-on-finish', run: (s) => {
    const enq = s.enqueue(EMPTY, seed(), T(0))
    const claimed = s.claim(enq, { logicalMessageId: lid('msg-1'), expectedState: 'WAITING', expectedAttempts: 0, workerId: 'w1', atIso: T(0) })
    // the process dies here: no finish() is ever called
    return s.stranded(claimed.store, T(30), 600_000).length === 1
  } },

  // R5 — one claim wins; the second is LOST rather than a second send.
  R5: { catches: 'claim-ignores-expectations', run: (s) => {
    const enq = s.enqueue(EMPTY, seed(), T(0))
    const c = { logicalMessageId: lid('msg-1'), expectedState: 'WAITING' as const, expectedAttempts: 0, atIso: T(0) }
    const first = s.claim(enq, { ...c, workerId: 'w1' })
    const second = s.claim(first.store, { ...c, workerId: 'w2' })   // stale expectations
    return first.result.kind === 'CLAIMED' && second.result.kind === 'LOST'
  } },

  // R9 — a refusal is not an exhaustion.
  R9: { catches: 'refusal-becomes-exhausted', run: (s) => {
    const enq = s.enqueue(EMPTY, seed(), T(0))
    const claimed = s.claim(enq, { logicalMessageId: lid('msg-1'), expectedState: 'WAITING', expectedAttempts: 0, workerId: 'w1', atIso: T(0) })
    const done = s.finish(claimed.store, lid('msg-1'), { kind: 'REFUSED', code: 'INVALID_ADDRESS', atIso: T(1) }, T(1))
    return done.jobs[0]?.state.kind === 'GAVE_UP'
  } },
}

// R6 is structural: the seam takes every time as a parameter, so the SAME inputs must give the
// same output twice. A clock inside would make this flaky rather than false.
const r6 = (() => {
  const s = build('reference')
  const a = JSON.stringify(failTimes(s, s.enqueue(EMPTY, seed(2), T(0)), 4))
  const b = JSON.stringify(failTimes(s, s.enqueue(EMPTY, seed(2), T(0)), 4))
  return a === b
})()

const VARIANTS: Variant[] = ['enqueue-appends-blindly', 'bound-held-by-runner', 'exhausted-is-removed',
  'attempt-recorded-on-finish', 'claim-ignores-expectations', 'refusal-becomes-exhausted',
  'claims-terminal-jobs']

const report = Object.entries(CHECKS).map(([name, check]) => {
  const passesReference = check.run(build('reference'))
  const caught = VARIANTS.filter((v) => !check.run(build(v)))
  return {
    check: name,
    property: PRE_REGISTERED_RETRY.find((p) => p.startsWith(name)) ?? null,
    passesReference,
    declaredVariant: check.catches,
    catches: caught,
    specific: caught.length === 1 && caught[0] === check.catches,
    verdict: passesReference && caught.length === 1 && caught[0] === check.catches ? 'READY' : 'NOT READY',
  }
})

console.log(JSON.stringify({
  QA_RETRY_PREREG: {
    checks: report,
    R6_timeIsAnInput: { deterministicAcrossTwoIdenticalRuns: r6, verdict: r6 ? 'READY' : 'NOT READY' },
    R7_R8: 'R7 is carried by the closed RetryState union plus accounting; R8 is type-level — no '
      + 'field on RetryJob, Claim or the seam is tenant-shaped, so a per-tenant queue is unwriteable',
    variantsCaughtByNothing: VARIANTS.filter((v) => Object.values(CHECKS).every((c) => c.run(build(v)))),
    cannotPinWithoutTheProvider: [
      'that Resend honours an idempotency key — every crash-retry path is safe only if it does',
      'that a process actually died where we infer it did, rather than the clock moving',
    ],
  },
}, null, 2))
