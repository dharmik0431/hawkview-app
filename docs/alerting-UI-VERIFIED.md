# The alerts UI, verified against the register published at `7f35565`

Branch `agent/alerts-ui` at `5c737ae`. The register and its three blobs were published before this
code existed and Engineer 2 has not read them.

## 1. The CSS emission method — corrected method confirmed, on the classes that matter

Tailwind escapes `:` in emitted selectors, so a class written `dark:text-amber-400` appears as
`.dark\:text-amber-400`. **A plain grep for the source spelling finds nothing and reads as "not
emitted".**

| class | plain grep | escaped grep |
|---|---|---|
| `dark:bg-amber-950` | **0** | 1 |
| `dark:text-amber-400` | **0** | 1 |
| `dark:bg-rose-950` | **0** | 1 |
| `dark:border-emerald-800` | **0** | 1 |

**With the controls in the same file being searched**, which is the part that makes it evidence:
`bg-amber-50` (unprefixed, certainly used) → found; `bg-fuchsia-747` (certainly not) → not found.
**The search is proven able both to find and to miss.**

**All 28 variant-prefixed classes** across the four changed components are emitted. None missing.

## 2. `NOT_STATED` — reachable, and it is the safe direction

| input | arm |
|---|---|
| field absent, `null`, a bare string | `NOT_STATED` |
| `TIER` with an unknown name, or no name | `NOT_STATED` |
| an unknown `kind` | `NOT_STATED` |
| `UNKNOWN_ALERT_TYPE` with no id | `NOT_STATED` |
| `NOT_AN_ALERT` from the API | **`NOT_AN_ALERT`** — still its own arm |
| a real tier | **`TIER`** — both positive controls read |

**No malformed input becomes a tier**, so none reaches `RECORD_ONLY`. That was the direction to
check: reaching for the mildest tier on an unreadable value is the reassuring error, and it is not
made here.

## 3. The vanished note — fixed, and the sibling search has a bounded answer

The note is now `shownDespiteMuting(severity)`, read off `severity` directly rather than off
whichever table supplied the badge. So it survives on a tier-bearing row, which is exactly where
it used to disappear.

**Siblings:** `SEVERITY_COPY` carries three fields and the answer is complete rather than a
sample. `label` and `className` are *supposed* to be replaced by the tier's on a tier-bearing row.
`note` is the only field that was a fact about the **severity** rather than the tier — it was the
bug, and it is fixed. **There is no third thing to miss.**

**And the note's claim is true of the filter it describes**, checked rather than assumed. The
backend admits `OR: [{ severity: 'critical' }, ...(inAppEnabled ? [...] : [])]` — critical rows
unconditionally, everything else only when in-app is on. `shownDespiteMuting` returns true for
exactly `critical`. **The copy and the filter agree.**

## 4. The contradiction pair — one production caller, no sixth path

`deliveryDescription(disposition, mapped, …)` has **one** production call site —
`disposition-row.tsx:49`, passing `row.mapped`. The rest are tests.

**Searched for a sixth path** rendering delivery copy without it: the only frontend matches are
unrelated profile headings; the backend matches are comments. **No path renders a delivery
sentence without stating whether anything feeds the type.**

## U1's testable half — the absence does not claim success

The dispositions endpoint does not exist, so this is the half that can be checked: `read-
dispositions.ts` carries `LOADED | UNREADABLE | FAILED`, and a non-`LOADED` outcome maps to
`NEVER_OBSERVED` rather than to an empty list. The page's own comment says it: *"HawkView could
not look, rather than that nothing is configured."*

**The two facts do not collapse** — which is the same distinction as the `Emptiness` union in my
register, arrived at independently.

## Three instrument failures of my own, in one session

Recorded because the pattern is the point, not the embarrassment.

1. My first class-extraction regex found **zero** variant classes and reported "0 not emitted" —
   a pass produced by finding nothing.
2. My second attempt's `sed` escaping errored on every class, leaving the pattern empty, so
   `grep -F ""` matched everything and again reported "0 not emitted".
3. My first tier probe passed the whole row where the function takes the tier value, so
   **everything** returned `NOT_STATED` — including the positive control.

**The third is the one that worked as designed.** The positive control failing is what said "your
probe is wrong", and without it I would have reported that `NOT_AN_ALERT` had collapsed into
`NOT_STATED` — a defect that does not exist, in the arm PM specifically asked me to protect.
