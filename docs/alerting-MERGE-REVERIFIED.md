# The merge, re-verified — six checks against `d0bafac`

Not four. The four registers cover the four fixes I was asked about; two more fixes I verified today
are not in any of them, and a merge is exactly where an uncovered fix goes missing.

**The merge is real, checked by content rather than topology.** `agent/alerts-step-01` and
`agent/alerts-ui` are the same commit, `d0bafac`. It fast-forwarded, so there is no merge commit and
an ancestor test reads oddly — `git cat-file -e` on five files spanning both sides succeeds:
`lib/notifications/bell.ts`, `lib/identity-risk/fleet-coverage.ts`, the risky-users page,
`lib/alerts/read-dispositions.ts` and `backend/src/alerts/finding-pipeline.ts`.

## All six pass

| | what it re-establishes | result |
|---|---|---|
| **R9 render** | the fleet screen over six fixtures | one green shield, on the one state that earns it; three registered fixtures still render differently; all four wordings intact |
| **U1 end to end** | an HTTP write changes what a tick does | `RECORD_ONLY` → 0 jobs, `info`; `ACT_TODAY` → `high`; nothing → `critical`; the write reaches the database |
| **the endpoint's guards** | not public, and refusals write nothing | 401 / 401 / 401 / 403, five refusals 400-or-403, zero rows, and the database still refuses a channel value (`23514`) |
| **unrecognised keys** | both ends name the key | endpoint and tick both name it, both follow the key, nothing stored names nothing, the two arms stay distinct, and a valid `RECORD_ONLY` beside them still silenced (0 jobs) |
| **fault injection** | the phase is measured, not declared | each fault names its own phase, three distinct, a yield is a `RAN` and a failure is not, `attempted` on `WRITING` equals what a healthy run wrote |
| **rawBody** *(not in the four)* | a genuine webhook would authenticate | wire bytes identical in the handler, genuine signature `AUTHENTIC`, rebuild and tampered body refused, no-option run has no bytes, the guard still 401s an undecorated route |

**And the seventh, which is the strongest single line in this document.** The reconciliation parity
output at `d0bafac` is **byte-identical** to the reference I captured at `13100de` this morning —
md5 `0e21845b…`, 446,132 bytes. Every classification, every mapping row, every incident cardinality
is the same as it was before any of today's work and before the merge.

**All six probes also still compile against the merged tip**, which is its own signal: a merge that
had changed a signature would have said so there first, as `28b6ddd` did earlier today.

## What this does not establish

- **The publish path and the chunk boundary are not built**, so P1–P10 and the chunk-boundary
  properties are unrun rather than passing.
- **Six checks are six checks.** They cover the fixes I verified today; a merge could still have
  disturbed something nobody has a register for. The honest claim is that everything with an
  instrument survived, not that nothing broke.
- **Nothing here says an email leaves the building.** That is unchanged and it is the release's
  defining limit.
