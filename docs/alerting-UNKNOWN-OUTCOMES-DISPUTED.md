# The unrecognised-code explanation does not hold

**The claim:** `classify()` recognises only 50126, 0 and 50076, so one sign-in carrying any other
code adds `UNKNOWN_OUTCOMES` and **silences that tenant's rule for the whole run** — which is why
the engine has never matched anything.

**Measured, by constructing the case where the two must differ.** `backend/src/alerts/qa-unknown-outcomes.ts`,
driving the real `evaluateAuthenticationRules` with the shipped fixtures.

| window | events | admitted | findings | rule statuses |
|---|---|---|---|---|
| **A** ten 50126 failures, nothing else | 10 | 10 | **1** | `MATCHED` · `NOT_MATCHED`, no reason codes |
| **B** the same ten **plus one 50053** | 11 | 11 | **1** | `MATCHED [UNKNOWN_OUTCOMES]` · `NOT_EVALUATED [UNKNOWN_OUTCOMES]` |
| **C** the production shape: 5×50053, 3×success, 3×50126 | 11 | 11 | **0** | both `NOT_EVALUATED [UNKNOWN_OUTCOMES]` |
| **D** the same window, five 50053 rows deleted | 6 | 6 | **0** | both `NOT_MATCHED`, **no reason codes** |

## Three results, in the order they matter

**1. The positive control passes.** A window of only-known codes **does** report — one finding,
`MATCHED`, no reason codes. So the classifier is not a coincidence covering some other failure, and
the engine is not broken end to end. That was the possibility worth eliminating first.

**2. One unrecognised row does NOT silence the run.** A and B produce **the same single finding**.
What the extra row changes is the *qualification*: `UNKNOWN_OUTCOMES` appears as a reason code and as
a caveat on the finding, and the second rule's verdict moves from `NOT_MATCHED` to `NOT_EVALUATED`.
**The claim as stated is false at this layer.**

**3. And for the window actually measured in production, the unrecognised codes are not what
stopped it.** C produces nothing. D — the identical window with all five 50053 rows removed —
**also produces nothing**. Three invalid-credential events cannot satisfy a rule that needs ten
inside fifteen minutes. **Deleting the entire proposed cause changes nothing about the outcome.**

## What is true, and it is a real defect of a different kind

The unknown codes destroy the ability to say **`NOT_MATCHED`**. Compare C and D: the same absence of
findings is reported once as *"could not evaluate"* and once as *"evaluated, nothing matched"*. So a
tenant carrying any unrecognised code cannot be reported as **assessed and clear** — it is reported
as **not assessed**.

That is this product's signature distinction — *could not look* against *nothing found* — arriving
in the risk engine. It is consistent with the downstream story (`identity-risk-evaluator.service.ts:1390`
excludes `NOT_EVALUATED` from the eligible aggregate), and that link is worth tracing properly rather
than assumed from this file.

**But it does not explain zero findings.** A tenant with ten qualifying failures and a hundred
unrecognised codes would still match and still report. *"The engine has never been given a run it
could complete"* is not what these measurements show. The nearer statement is: **the windows
examined never carried enough qualifying evidence to match**, and separately, unrecognised codes
stop a clean negative from being sayable.

## What would settle the remaining question

Whether any tenant has ever had **ten invalid-credential events for one subject and application
inside fifteen minutes**. That is a query over collected evidence, not a code question, and it is
the one that decides whether the classifier matters at all for matching. Until somebody runs it,
the cause of zero findings is **not established** — by this file or by anything else.

## One fixture failure of mine, caught before it was reported

My first run of window C showed `CONFLICTING_DUPLICATES` and eight admitted of eleven. The shipped
`success()` helper uses a **fixed event id**, so my three successes were three rows sharing an id and
the evaluator correctly rejected two. The conclusion survived the correction, but it would have been
a conclusion drawn over a window my own fixture had distorted, and the numbers in the table above are
the corrected ones.

---

# Addendum: the threshold query answers one rule, and the other rule's threshold is five

A fleet query reports, for tenant `83f23fe5` across all history: 120 invalid-credential events ever,
**most in any fifteen minutes for one subject and application: 5**, moments reaching ten: **0** —
and concludes the rules have never had cause to fire.

**That is true of `HV-ID-AUTH-010.v1`, which needs ten. It is not true of the other rule.**

`HV-ID-AUTH-005.v2` takes **five failures followed by a success**. Measured, not read:

| window | findings | statuses |
|---|---|---|
| five 50126 failures then one success, same client address | **1** | `HV-ID-AUTH-010.v1` `NOT_MATCHED` · **`HV-ID-AUTH-005.v2` `MATCHED`** |
| **four** failures then a success | **0** | — |

**Five is exactly the boundary, and the fleet's maximum is exactly five.** So the measured number
sits *on* the second rule's threshold rather than below it. Whether it ever actually fired depends
on two things the query did not measure: the five failures must share **one qualified client
address**, and the success must fall **within two minutes** of the last failure.

**So "never had cause to fire" is not established.** It is established for the ten-threshold rule.
For the five-threshold rule the query's own number is the trigger value, and the question is open
until it is re-run with the client address and the two-minute proximity in it.

## The audit-record field path, so the query can cover the other four tenants

For `M365_AUDIT_STS` the error code is **not one field**. `normalizeAuthenticationRecord` gathers up
to three, all as **strings**:

1. `ErrorCode` on the record
2. `ExtendedProperties[]` where `Name = 'ErrorCode'` → its `Value`
3. `ExtendedProperties[]` where `Name = 'ErrorNumber'` → its `Value`

**They must all agree.** `codes.every(… /^(0|[1-9]\d{0,8})$/ …) && new Set(codes).size === 1` — if
two disagree, or any is not a numeric string, **the record yields no code at all** and its outcome
stays `UNKNOWN`.

**And a matching code is not yet an invalid credential.** For `50126` to become
`INVALID_CREDENTIAL` the record must also have `Operation = 'UserLoginFailed'`, every `LogonError`
empty or `InvalidUserNameOrPassword`, and `LoginStatus` absent or one of `50126` / `Failure` /
`Failed`. `RecordType` must be `15`.

**So a query that extracts one field will overcount** relative to what the engine admits. Something
closer to:

```sql
raw->'managementActivityRecord'->>'ErrorCode' = '50126'
AND raw->'managementActivityRecord'->>'RecordType' = '15'
AND raw->'managementActivityRecord'->>'Operation' = 'UserLoginFailed'
-- and the ExtendedProperties ErrorCode/ErrorNumber entries, where present, must equal it
```

I have not run this — I have no production access. It is derived from the normaliser, which is the
other side of the boundary from the data, and it should be treated as a starting point that needs
its own control: **a count that changes when the ExtendedProperties condition is added is a count
that was measuring the wrong thing.**

## Attacking the conclusion, as asked

**"Zero findings is correct behaviour"** is not established. What is established is narrower:

- **one rule** — the ten-threshold one — **on one tenant**, over the history that tenant collected;
- using a **Graph-shaped extraction**, so four of five tenants contributed nothing, and *nothing* is
  absent rather than zero;
- and over a history whose completeness is itself in question, since two of five tenants stopped
  collecting and still report current. **A count over a stalled collector is a floor.**

The second rule's threshold is met by the query's own maximum. Until that is re-run, the honest
statement is that **the busiest window found is exactly the value that would fire the other rule**.
