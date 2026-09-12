// QA PRE-REGISTRATION — step 06 expectations. Written before the code exists.
//
// A reference following the semantics, one named variant per property, each check passing
// the reference, catching what it DECLARES, and quiet on the rest. The reference is not a
// proposed implementation; it exists so the expectations have something to be false against.
//
// WHAT CANNOT BE PINNED WITHOUT THE PROVIDER, said here rather than left implied: that
// Resend honours an idempotency key at all; that its webhook is authentic; that its
// "accepted" means what we think. Everything below is against a fake, and a fake agrees with
// whatever I believed when I wrote it.
import type {
  Attempt, DeliveryJob, JobReport, JobState, MailOutcome, MailSeam, MessageBody,
  ProviderEvent, SendResult, UnmatchedEvent,
} from './qa-step-06-contract.js'
import type { VerifiedRecipient } from './routing-policy.js'

type Variant =
  | 'none'
  | 'resends-the-same-key'        // M1
  | 'retries-forever'             // M2
  | 'attempt-without-an-outcome'  // M3
  | 'accepted-reads-as-delivered' // M4
  | 'bounce-ignored'              // M5
  | 'unknown-event-dropped'       // M6
  | 'unresolved-never-reported'   // M7

const T0 = new Date('2026-03-01T09:00:00Z')
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000)
const TO: VerifiedRecipient = { kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: T0 }
const BODY: MessageBody = {
  alertTypeId: 'monitoring.collector_failing', tier: 'EMAIL',
  affectedTenantCount: 15, deepLinkPath: '/alerts/incident/abc',
}
const J = (over: Partial<DeliveryJob> = {}): DeliveryJob => ({
  jobId: 'job-1', idempotencyKey: 'key-1', organizationId: 'org-1', to: TO, body: BODY, ...over,
})

/** A fake provider. Refuses whatever is listed, otherwise accepts. */
const provider = (refuse: ReadonlySet<string>) => {
  let n = 0
  return (job: DeliveryJob): SendResult => {
    n += 1
    return refuse.has(job.jobId)
      ? { kind: 'ERRORED', because: 'provider unavailable' }
      : { kind: 'ACCEPTED', providerMessageId: `pm-${job.jobId}-${n}` }
  }
}

const mailWith = (variant: Variant, refuse: ReadonlySet<string> = new Set()): MailSeam => (input) => {
  const send = provider(refuse)
  const attempts = new Map<string, Attempt[]>()
  const state = new Map<string, JobState>()
  const acceptedAt = new Map<string, Date>()
  const providerIdToJob = new Map<string, string>()
  const sentKeys = new Map<string, string>()   // idempotency key -> jobId that sent it
  const unmatched: UnmatchedEvent[] = []

  for (const job of input.jobs) { state.set(job.jobId, { kind: 'NOT_ATTEMPTED' }); attempts.set(job.jobId, []) }

  for (const tick of input.ticks) {
    // 1. Attempt anything not yet accepted and not abandoned.
    for (const job of input.jobs) {
      const current = state.get(job.jobId)!
      if (current.kind !== 'NOT_ATTEMPTED') continue
      const already = sentKeys.get(job.idempotencyKey)
      if (already !== undefined && variant !== 'resends-the-same-key') {
        // The same message. Not sent again, and not left looking unattempted either.
        const twin = state.get(already)!
        state.set(job.jobId, twin)
        continue
      }
      const tries = attempts.get(job.jobId)!
      if (tries.length >= input.maxAttempts && variant !== 'retries-forever') {
        state.set(job.jobId, { kind: 'ABANDONED', afterAttempts: tries.length,
          because: `the provider did not accept it in ${tries.length} attempts` })
        continue
      }
      const result = send(job)
      // AN ATTEMPT WITHOUT A RECORDED OUTCOME is a send nobody can account for.
      if (variant !== 'attempt-without-an-outcome') tries.push({ at: tick.at, result })
      if (result.kind === 'ACCEPTED') {
        sentKeys.set(job.idempotencyKey, job.jobId)
        providerIdToJob.set(result.providerMessageId, job.jobId)
        acceptedAt.set(job.jobId, tick.at)
        // ACCEPTED IS NOT DELIVERED. The variant calls it delivered at send time, which is
        // the state nobody can know yet.
        state.set(job.jobId, variant === 'accepted-reads-as-delivered'
          ? { kind: 'DELIVERED', providerMessageId: result.providerMessageId, at: tick.at }
          : { kind: 'ACCEPTED_AWAITING_CONFIRMATION', providerMessageId: result.providerMessageId, since: tick.at })
      }
    }

    // 2. Later-arriving facts about earlier sends.
    for (const event of tick.events) {
      const jobId = providerIdToJob.get(event.providerMessageId)
      if (jobId === undefined) {
        if (variant !== 'unknown-event-dropped') {
          unmatched.push({ providerMessageId: event.providerMessageId, kind: event.kind,
            because: 'no job in this run sent a message with that provider id' })
        }
        continue
      }
      if (event.kind === 'DELIVERED') {
        state.set(jobId, { kind: 'DELIVERED', providerMessageId: event.providerMessageId, at: event.at })
        acceptedAt.delete(jobId)
      }
      if (event.kind === 'BOUNCED' && variant !== 'bounce-ignored') {
        state.set(jobId, { kind: 'BOUNCED', providerMessageId: event.providerMessageId, at: event.at, because: event.because })
        acceptedAt.delete(jobId)
      }
    }
  }

  const last = input.ticks[input.ticks.length - 1]?.at ?? T0
  const jobs: JobReport[] = input.jobs.map((job) => ({
    jobId: job.jobId, state: state.get(job.jobId)!, attempts: attempts.get(job.jobId)!,
    unresolvedSince: acceptedAt.get(job.jobId) ?? null,
  }))
  const unconfirmed = variant === 'unresolved-never-reported' ? [] : jobs
    .filter((j) => j.unresolvedSince !== null
      && last.getTime() - j.unresolvedSince.getTime() > input.confirmWithinMs)
    .map((j) => ({ jobId: j.jobId, since: j.unresolvedSince!,
      sentence: 'the provider accepted this and has said nothing since — it may or may not have arrived' }))

  return { jobs, unmatched, unconfirmed } satisfies MailOutcome
}

// ─────────────────────────────────────────────────────────────────────────────
const HOUR = 3600_000
const run = (v: Variant, over: Partial<Parameters<MailSeam>[0]> = {}, refuse = new Set<string>()) =>
  mailWith(v, refuse)({ jobs: [J()], ticks: [{ at: at(0), events: [] }], maxAttempts: 3, confirmWithinMs: HOUR, ...over })

type Check = Readonly<{ id: string; property: string; writtenAgainst: string; expect: readonly Variant[]; holds: (v: Variant) => boolean }>

const CHECKS: readonly Check[] = [
  { id: 'M1', property: 'the same idempotency key sends once', expect: ['resends-the-same-key'],
    writtenAgainst: 'two jobs carrying ONE key — a retry that arrived as a second job',
    holds: (v) => {
      const out = run(v, { jobs: [J({ jobId: 'a' }), J({ jobId: 'b' })] })
      // DISTINCT PROVIDER IDS, not recorded attempts. Counting attempts made this fire on
      // the variant that suppresses attempt RECORDING, which is M3's property, not this one.
      // A provider id exists because a send happened, whether or not anybody wrote it down.
      const ids = new Set(out.jobs.flatMap((j) =>
        'providerMessageId' in j.state ? [j.state.providerMessageId] : []))
      return ids.size === 1
    } },
  // DECLARES TWO, AND THE SECOND IS A FINDING RATHER THAN A FIXTURE PROBLEM. The retry
  // bound is computed from the RECORDED attempts, so a system that loses its attempt record
  // also loses its bound and retries forever. Counting attempts by reading your own log
  // means a failed log write buys unlimited retries. Worth stating rather than contorting
  // the fixture to hide.
  { id: 'M2', property: 'retries are bounded and exhaustion is ABANDONED with a reason',
    expect: ['retries-forever', 'attempt-without-an-outcome'],
    writtenAgainst: 'a provider that always errors, over more ticks than the bound',
    holds: (v) => {
      const out = run(v, { jobs: [J({ jobId: 'x' })], maxAttempts: 2,
        ticks: [0, 1, 2, 3, 4].map((n) => ({ at: at(n), events: [] })) }, new Set(['x']))
      const job = out.jobs[0]!
      return job.attempts.length <= 2 && job.state.kind === 'ABANDONED'
        && 'because' in job.state && job.state.because.length > 10
    } },
  { id: 'M3', property: 'every attempt has a recorded outcome', expect: ['attempt-without-an-outcome'],
    writtenAgainst: 'one successful send — the case where an attempt definitely happened',
    holds: (v) => {
      const out = run(v)
      return out.jobs[0]!.attempts.length === 1 && out.jobs[0]!.attempts[0]!.result.kind === 'ACCEPTED'
    } },
  { id: 'M4', property: 'accepted is not delivered', expect: ['accepted-reads-as-delivered'],
    writtenAgainst: 'a send the provider accepted, with NO provider event afterwards',
    holds: (v) => run(v).jobs[0]!.state.kind === 'ACCEPTED_AWAITING_CONFIRMATION' },
  { id: 'M5', property: 'a bounce lands on its job', expect: ['bounce-ignored'],
    writtenAgainst: 'an accepted send followed by a bounce for its provider id',
    holds: (v) => {
      const first = run(v)
      const st = first.jobs[0]!.state
      if (st.kind !== 'ACCEPTED_AWAITING_CONFIRMATION' && st.kind !== 'DELIVERED') return false
      const pm = st.kind === 'ACCEPTED_AWAITING_CONFIRMATION' ? st.providerMessageId : 'pm-job-1-1'
      const out = mailWith(v)({ jobs: [J()], maxAttempts: 3, confirmWithinMs: HOUR,
        ticks: [{ at: at(0), events: [] },
          { at: at(5), events: [{ kind: 'BOUNCED', providerMessageId: pm, at: at(5), because: 'mailbox full' } as ProviderEvent] }] })
      return out.jobs[0]!.state.kind === 'BOUNCED' && out.jobs[0]!.unresolvedSince === null
    } },
  { id: 'M6', property: 'an event for an unknown message is named', expect: ['unknown-event-dropped'],
    writtenAgainst: 'a webhook for a provider id no job in this run produced',
    holds: (v) => {
      const out = mailWith(v)({ jobs: [J()], maxAttempts: 3, confirmWithinMs: HOUR,
        ticks: [{ at: at(0), events: [] },
          { at: at(5), events: [{ kind: 'BOUNCED', providerMessageId: 'pm-from-elsewhere', at: at(5), because: 'x' } as ProviderEvent] }] })
      return out.unmatched.length === 1 && out.unmatched[0]!.providerMessageId === 'pm-from-elsewhere'
    } },
  { id: 'M7', property: 'an accepted job that never resolves is reported', expect: ['unresolved-never-reported'],
    writtenAgainst: 'a send accepted and then NOTHING — the state that reads as success',
    holds: (v) => {
      const out = mailWith(v)({ jobs: [J()], maxAttempts: 3, confirmWithinMs: HOUR,
        ticks: [{ at: at(0), events: [] }, { at: at(120), events: [] }] })
      // CONTROL: a job confirmed inside the window must NOT be reported, or this passes by
      // reporting everything.
      const confirmed = mailWith(v)({ jobs: [J()], maxAttempts: 3, confirmWithinMs: HOUR,
        ticks: [{ at: at(0), events: [] },
          { at: at(5), events: [{ kind: 'DELIVERED', providerMessageId: 'pm-job-1-1', at: at(5) } as ProviderEvent] }] })
      return out.unconfirmed.length === 1 && confirmed.unconfirmed.length === 0
    } },
]

const VARIANTS: readonly Variant[] = ['resends-the-same-key', 'retries-forever', 'attempt-without-an-outcome',
  'accepted-reads-as-delivered', 'bounce-ignored', 'unknown-event-dropped', 'unresolved-never-reported']

const rows = CHECKS.map((c) => {
  const passes = c.holds('none')
  const catches = VARIANTS.filter((v) => !c.holds(v))
  const same = JSON.stringify([...catches].sort()) === JSON.stringify([...c.expect].sort())
  return { check: c.id, property: c.property, writtenAgainst: c.writtenAgainst, passes, catches,
    ready: passes && same,
    verdict: !passes ? 'NOT SATISFIABLE' : catches.length === 0 ? 'INERT'
      : !same ? `declared ${c.expect.join(', ')}, caught ${catches.join(', ')}` : 'READY' }
})

console.log(JSON.stringify({
  QA_STEP_06_PREREG: {
    writtenAgainst: 'no implementation — step 06 does not exist yet',
    checks: rows.length, ready: rows.filter((r) => r.ready).length, rows,
    variantsCaughtByNothing: VARIANTS.filter((v) => !CHECKS.some((c) => !c.holds(v))),
    typeLevel: 'M8 and M9 have no runtime variant by design — see qa-step-06-types.ts',
    cannotPinWithoutTheProvider: [
      'that Resend honours an idempotency key at all',
      'that a webhook is authentic rather than forged',
      'that the provider\'s "accepted" means what we take it to mean',
      'the real bounce and complaint rates, and whether they arrive at all',
    ],
  },
}, null, 2))
