# The third stranding instance is closed — the same check, unchanged

**`qa-projection-check.ts` failed against `c5339f5` and passes against `3167872`. The file is
byte-identical.** That was the criterion set before the fix existed: a test that passed today
would not have been testing the fix.

| | `c5339f5` | `3167872` |
|---|---|---|
| P1 no incident projects over the empty set | **FAIL** 1 of 1 | **pass** |
| P2 never silent in one channel and loud in the other | **FAIL** 1 of 1 | **pass** |
| P3 no keyed notification without its incident | passed *vacuously* | **pass, and no longer vacuous** |

**P3 is worth a line of its own.** It passed before over an empty set — there were no keyed
notifications at all, which is a green check on an empty input. It now passes over a populated
one: a keyed notification exists and it has its incident. **The same result; different evidence.**

The run reports `notificationsWritten: 1` alongside the incident and the job, so the three are
written together rather than the notification being appended afterwards.

## Atomicity across three tables, re-established rather than carried over

I registered that my two-table evidence would not transfer, for the same reason I refused to
carry the explicit-`BEGIN` result across to `prisma.$transaction`: **a different extent is a
different claim.** Both placements run:

| the failure placed on | incidents | jobs | notifications |
|---|---|---|---|
| the **notification** insert (new) | 0 | 0 | 0 |
| the **job** insert (re-run with a third table present) | 0 | 0 | 0 |
| *healthy control* | 1 | 1 | 1 |

A `CHECK` constraint that only one insert can violate places the failure precisely in the window
that produced the original blocker. **Neither placement leaves anything behind. The stranding
defect has not moved one table along.**

The third placement I registered — the reverse write order — is not applicable: the
implementation writes incidents, notifications and jobs in one statement sequence inside one
transaction, so there is no second order to test. **Registered, checked, and found not to apply**,
which is different from not checked.

## One note against my own probe

`qa-three-table-atomic.ts` prints `NOT ATOMIC` on the **healthy** control, because its verdict
string was written for the failure case and only ever expected zeros. The numbers it prints are
correct — 1 incident, 1 job, 1 notification, which is the right healthy outcome — and the verdict
line is wrong for that path. **Recorded rather than quietly fixed**, because a probe whose summary
contradicts its own data is exactly the shape I spend my time finding in other people's work.
