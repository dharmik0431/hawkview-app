# The register, run against `ed6f73b`

Published before this code existed, blobs `cfb695de…` (contract) and `c2aeef8c…` (properties).
`frontend-probes/qa-r9-render.mjs`, run in the `agent/alerts-ui` checkout at `ed6f73b`.

**R9's method.** The real `app/(protected)/risky-users/page.tsx`, transpiled and rendered with
`renderToStaticMarkup`. Only the data hook and the drawer are replaced — the hook because it is the
seam a fixture enters through, the drawer because it draws nothing on an empty screen. Every icon,
every string and the whole empty-state branch are the shipped ones, and the icon's **colour** is
read out of the surrounding markup rather than assumed.

## Seven hold. Two fail, at the same input.

| | |
|---|---|
| R1 a count and its coverage cannot disagree | **holds** — one function returns both |
| R2 an unreadable tenant is never a zero | **holds** — `assessed` counts `SUCCESS` only |
| R3 three states | **holds, except at the degenerate input** |
| R4 an incomplete count is a floor, visibly | **holds** — "0 users across 1 of 4 tenants" |
| R5 a reassuring rendering needs a complete read | **FAILS** |
| R6 nothing measured against an invented denominator | **FAILS** |
| R7 one instant | holds — there is no second clock to disagree with |
| R8 which tenants were missed | **not met** — counts by reason, no tenant named |
| R9 the three fixtures render differently | **FAILS** — two of three are identical |

## What a person sees, rendered

| fixture | empty-state title | detail | green shields |
|---|---|---|---|
| four tenants, all assessed | No users require review | All **4** tenants in scope were assessed… | **2** |
| three of four unreadable | No users to review among the tenants HawkView assessed | 3 of 4 tenants were not assessed (1 could not be reached, 2 returned no assessment) | 0 |
| all four still loading | No users to review among the tenants HawkView assessed | 4 of 4 tenants were not assessed (4 still loading) | 0 |
| **nothing assessed at all** | **No users require review** | **All 0 tenants in scope were assessed…** | **2** |
| **the tenant list request failed** | **No users require review** | **All 0 tenants in scope were assessed…** | **2** |

The middle rows are the fix working, and it is a real fix: the partial read and the loading fleet
both refuse the shield and say why, with the remedy distinguished.

**The last two rows are the register's third fixture, and they render identically to the first.**
Same title, same two green ShieldChecks — one in the emerald circle in the desktop table, one on
mobile. The only difference on the whole screen is the digit in "All **0** tenants in scope were
assessed", inside the sentence that does the reassuring.

## The defect

```ts
const missing = Math.max(0, coverage.inScope - coverage.assessed)
const complete = missing === 0
```

With `inScope === 0`, `complete` is **vacuously true**. "Everything in scope was assessed" is true
of nothing, and `QUIET` is the tone that earns the shield.

**It is reachable, and the path is the worst one.** `useFleetRiskyUsers` sets
`safeTenants = tenantsResponse?.tenants ?? []`, so when the tenant-list request fails
`tenantsResponse` is undefined, `safeTenants` is empty, the statuses loop over an empty list, and
coverage is `inScope: 0`. The hook returns `isError`, **and the page never consults it** — the
render chain is `isLoading ? … : summary.empty ? …`. So the state where HawkView could not find out
what the fleet even is renders as a green shield saying "No users require review".

That is the same sentence as the bug this commit fixed, one level further out: the fix asks *how
many of the tenants we know about did we assess*, and this is the case where we do not know about
any. An organisation with no tenants onboarded lands in the same place — less dangerous, equally
wrong.

**The remedy is the one the register already carried.** `FleetSize` is its own union, `KNOWN` or
`UNKNOWN`, because a fleet whose size could not be determined must not be given a denominator; and
`Emptiness` has `COULD_NOT_LOOK` as its own arm, reached *before* the completeness test rather than
after it. In the register's own derivation the order is `assessed === 0` first, then
`unassessed > 0`, then nothing-found — which is why the third fixture lands on its own arm there.

**And my own contract is not fully innocent, which is worth saying.** `Assurance.REASSURING` takes
`everyTenantAssessed: true` and an `assessedTenants` number, and nothing in the *type* stops
`assessedTenants: 0`. The type closes the partial-read hole; it is the derivation order that closes
the empty-fleet one. A property can be right and its encoding still leave a corner.

## R8, separately

The shortfall names **why** — "1 could not be reached, 2 returned no assessment" — and the register
asked for **which**. No tenant is named as unassessed anywhere on the screen; the tenant filter
lists all four, unmarked. A person told three tenants were missed cannot act without going to find
them. Softer than R5 and R6, and worth fixing while the coverage object is right there.

## My own instrument, and the failure it made first

The render harness resolved `@/…` with `existsSync(base + ext) && !existsSync(base + ext + '/')` —
and on Windows the trailing-slash guard matched the file itself. Every specifier fell through to
node's own resolver, nothing compiled, **nothing rendered**, and the run reported:

```
allClear_earnsIt: false
partialRead_refusedIt: true      ← a pass
nothingAssessed_refusedIt: true  ← a pass
stillLoading_refusedIt: true     ← a pass
```

Four of five booleans green because **zero shields were found in zero bytes of HTML**. It is the
same shape as Engineer 2's own near-miss in this commit — their shield was absent in every mode
because `adaptNativeAssessment` refused their fixture, which looks exactly like suppression
working. Two independent instruments, the same afternoon, both producing a pass by rendering
nothing.

The positive control is the whole reason either was caught. `allClear_earnsIt: false` is the
fixture that **must** produce a shield, and it is the one that said the harness was broken. Every
run now reports `RENDERED` and `htmlBytes` beside the verdicts, so a claim over an empty document
cannot read as a result.
