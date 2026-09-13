# The wiring — three questions, answered by the codebase rather than by a ruling

**Status, first, because it keeps being asked: nothing is mid-build and nothing is blocked.**
Work happens when a message arrives; between messages this session is not running. A gap in the
commit stream is a gap in incoming work, not a stall.

**And the thing that makes that look like a stall: replies do not land.** Cross-session sends have
been refused by a rate limiter more than twenty-four consecutive times. Every answer, correction
and question has gone out as a commit message instead. If something here reads as unanswered, it
was answered in a commit.

---

Two of the three open questions turn out not to be decisions. `src/tenants/scheduled-sync.controller.ts`
settles both, and the third is forced by code that already exists.

## 1. The scheduler: neither a cron entry nor the sync cycle

**HawkView is driven by an external scheduler POSTing to `api/internal/sync/due-tenants`.** The
endpoint is `@Public()` and guarded by `SchedulerTokenVerifier.verify(request.headers.authorization)`.
There is no in-process cron anywhere in the application — the only `setInterval` is a diagnostics
flush.

**So intake hangs off that existing invocation.** Not a new endpoint, not a timer.

**And the reason is stronger than convention.** That handler is already a budgeted admission
cascade, all against one request clock:

| stage | window |
|---|---|
| history retention | `startedAt + 10s` |
| risk maintenance | `startedAt + 15s` |
| global risk cycle | `startedAt + 45s` |
| collector admission | `startedAt + 240s` |

A second endpoint would mean two schedulers and two clocks competing for the same process — and
for the same memory lane, which is already a known contention point between the collectors and
anything else that reads.

**⚠ THE HAZARD THIS CREATES, and it must be designed for rather than discovered.** Each stage is
gated on `Date.now() < startedAt + N`, and every one of them degrades by logging and continuing so
that *collection is never suppressed*. **Intake must take its own bounded window and degrade the
same way.** If it does not, a slow intake eats the collectors' admission budget and the symptom is
tenants quietly not being collected — which reads as the tenants being quiet, and nobody would
attribute it to alerting.

The existing code already says this in its own comments: *"a settled maintenance failure does not
suppress ordinary collectors"*. Intake inherits that rule.

## 2. The webhook: `@Public()` plus a verifier service

The same file is the precedent. `@Public()` marks the route as unauthenticated to the app's guard,
and a **verifier service** re-establishes trust from the request itself — exactly the shape the
Resend webhook needs.

So: an alerts controller with `@Public() @Post('resend')`, and a `ResendSignatureVerifier` shaped
like `SchedulerTokenVerifier`, producing the `Authentication` verdict that `authenticate(raw,
verdict)` already takes as a parameter. **The pure module stays pure** — it never sees the secret,
and the one place that does is a service with the same shape as one that already exists and is
already reviewed.

## 3. Per-tick, and that is forced rather than chosen

`applyLimit(carriedOver, arriving, policy, tickAt)` counts per MSP **per tick**, and
`fanOutProblems` is defined over a tick window — deliberately the same window, "so the limit and
the fan-out invariant measure the same thing rather than two windows that nearly agree."

Routing per incident would leave both unmeasurable: there is no window to count over. **One
invocation of `due-tenants` is one tick.**

## What is actually left

1. ~~`alert_incidents` written by intake~~ — **DONE**, `finding-pipeline.ts`. A persisted finding reaches a send job, proven end to end against a real database.
2. Routing reading both preference stores for real.
3. **The Resend client and the webhook handler. Neither exists anywhere.**
4. Intake called inside `due-tenants`, in its own admission window.
5. ~~`alert_send_jobs` has no migration~~ — **DONE**, `20260912223000`. Verified on a throwaway
   PostgreSQL 15: deploys clean, no drift, every constraint rejects its own case.
6. B3, the integration prerequisites, which is the only item nobody has sized. The configuration
   half is documented and verified; the data half is unknown.
7. The four rollout artefacts.

**Items 1 and 5 are done.** What remains: routing reading both stores in production code, the
Resend client, the signature verifier, the webhook route, the scheduler hook, B3, and the four
artefacts.

**The note that used to stand here — that `alert_send_jobs` was named by code and created by
nothing — was true when written and is not now.** Corrected rather than deleted, because a
document that quietly stops mentioning a gap reads the same as one that never had it.
