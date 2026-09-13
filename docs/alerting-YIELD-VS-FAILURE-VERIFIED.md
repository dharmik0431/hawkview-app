# A yield and a failure, verified at `28b6ddd`

`backend/src/alerts/qa-yield-vs-failure.ts`. Every phase is driven by **injecting a fault at that
phase** and reading what comes back — not by checking that a phase field exists.

## Both halves hold

**They are different in the value, not only in a log line.** A yield is `{kind: 'RAN', report}` with
`yieldedOnBudget: true`; a failure is `{kind: 'FAILED', phase, because, attempted}`. A caller
branches on `kind` without parsing anything. The pair that used to read alike — both leave the
findings `OPEN`, both write nothing — now differs at the top of the value.

**The phase is measured, not declared.**

| fault injected in | phase reported | work it says it lost |
|---|---|---|
| `findOpenFindings` | `READING` | nothing — all four counts zero |
| `findExistingIncidents` | `LOADING` | `findingsRead: 3`, rest zero |
| `loadDispositions` | `LOADING` | `findingsRead: 3`, rest zero |
| `commit` | `WRITING` | 3 findings, 3 incidents, 3 notifications, 3 jobs |

Three distinct phases, so the field discriminates rather than being a constant that happens to look
like an attribution.

**And `attempted` is checked against something built by a different path.** A healthy run over the
*same* store and the *same* findings writes exactly 3 / 3 / 3 — identical to what the failing run
says it attempted. Without that control, `attempted` could be any plausible-looking number.

## One finding: the backstop's returned phase contradicts its own log line

`alert-intake.service.ts:78-87`. When `runIntake` rejects rather than returning, the service:

```ts
this.logger.warn(JSON.stringify({ … phase: 'UNKNOWN', … }))   // the log
return { kind: 'FAILED', phase: 'READING', …,                  // the value
         attempted: { findingsRead: 0, incidents: 0, notifications: 0, jobs: 0 } }
```

The comment two lines above says it outright: *"`UNKNOWN` is honest about the phase rather than
guessing one."* **The log takes that advice and the return value does not.** A programmatic consumer
is told `READING` — nothing decided, nothing written, nothing lost — which is the most reassuring
of the three phases and, for the path that actually reaches this branch, the least likely to be
true.

**The path is real and I measured it.** `decide()` and the `findings.length` test sit outside all
three `try` blocks, so a fault there leaves `runIntake` by rejecting. Driving it with a store whose
read resolves to something unusable, `runIntake` rejects with `Cannot read properties of undefined
(reading 'length')` rather than returning an outcome — so the union enumerates what a tick *did*,
and a rejection is outside the enumeration. That is exactly why the backstop was kept, and the
author said so.

The cause is one member short: `IntakePhase` is `READING | LOADING | WRITING`, so the return type
**cannot** say what the log says. Adding `UNKNOWN` to the union makes the honest answer expressible
and turns every existing `switch` over the phase into a compile error that asks the question — the
same move this feature has made four times now.

This is PM's own criterion landing on the code that introduced it: a failure attributed to the
wrong phase is worse than an unattributed one, because it sends the next person somewhere with
confidence. Here it sends them to the read path with a report that nothing was lost.

## What I did not check

Whether `decide()` can throw on data a real database can produce. I forced the unguarded exit with
an injected fault, which establishes that the exit exists and what is reported when it is taken —
not how likely it is. The backstop's own comment treats reachability as granted, and the remedy
does not depend on the answer.
