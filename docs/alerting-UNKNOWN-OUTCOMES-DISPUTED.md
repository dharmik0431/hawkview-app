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
