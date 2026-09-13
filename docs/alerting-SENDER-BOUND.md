# The sender, bound against the register — and the identity-risk spread, measured

Two separate things. **Neither suite's result says anything about the other's.**

## 1. The delivery register, bound against `c3953b2`

The register was published before the sender existed (blobs `e0d16fad…` and `602a988b…`, commit
`08522b9`), and Engineer states they did not read it. Properties are mine; the shape is theirs.

| property | result |
|---|---|
| **D1** the switch is off until somebody turns it on | **BOUND, and stronger than I registered it** |
| **D3** a negative control is withheld and *shown*, not absent | **BOUND** |
| **D4** a hard bounce is a fact about an address | **BOUND, and it discriminates** |
| **D8** the secret never reaches the pure module | **BOUND** (grep, bounds stated below) |
| D2, D5, D7 | still a person's to do — unchanged |
| D6, D9 | not in this commit; D6 belongs to the verifier, D9 to the forecast |

**D1 is stronger than what I asked for.** I registered "a default of false is not checkable by
reading the default — check it by absence of a row producing no send." What landed is better:
**there is no transport to configure.** The only `SendTransport` in the repository refuses, and
switching sending on requires somebody to *write* a module rather than set a variable. A flag can
be flipped by a deploy config; a missing module cannot.

**And the refusal is retryable rather than permanent**, which is the decision I would have missed.
A permanent refusal would burn each job's budget and mark it `GAVE_UP`, so a build left running
against the stub would conclude every address was dead — and whoever wired a real provider later
would inherit a queue that had already given up on everybody. Measured: `REFUSED_RETRYABLE`.

**D4 discriminates rather than merely holding**: permanent suppresses, retryable does not,
accepted does not, and the suppression is keyed to the **address** — so a different message to the
same dead mailbox is not attempted either.

**Positive control:** a real transport still sends (`ACCEPTED`), so the module is discriminating
rather than obstructive.

### D8, with its bounds

`alert-sender.ts` reads no environment variable, constructs no client, and makes no network call
— its only mention of the provider is a comment. **Bounds of the wider search:** `src/`, all
extensions, tests excluded. The matches outside comments are one redaction word-list in
`identity-signal-runtime.ts` that lists `resend` among secret-bearing terms. There is no
`from 'resend'`, no `new Resend`, no `api.resend.com` — and **`resend` is not a dependency in
`package.json` at all.** So the claim is true and stronger than stated: the client is not merely
unwritten, it is not installable without adding a dependency first.

## 2. The identity-risk suite: my 45 was one sample, and a poor one

Engineer measured 27, then 22, then 29. **Five further runs, one cluster, one commit, one
database, identical inputs:**

| run | pass | fail | failures naming `timeout expired` |
|---|---|---|---|
| 1 | 22 | 133 | 9 |
| 2 | 22 | 133 | 5 |
| 3 | 11 | 155 | 18 |
| 4 | 15 | 147 | 14 |
| 5 | 14 | 149 | 13 |

**A spread of eleven passes on identical inputs.** Engineer's reading is right and I am correcting
mine: **I reported 45 passing and that was one sample of a suite that does not produce a stable
number.** It is the error I spent the evening naming in other people's work — a figure quoted
from a single observation.

**What I did NOT establish**, and will not claim: that the timeout is the single root cause. The
`timeout expired` count moves with the failure count but explains only 5–18 of 133–155 failures.
**Most failures are something else, and I have not identified it.** "One speed-sensitive suite"
is the right description of the *variance*; it is not yet an account of the *failures*.

*(The alerting five are a separate matter and are ten of ten — see
`alerting-ROLLBACK-SERVES-AND-REPRO.md`, including the structural reason they differ.)*

## A method note on my own probe

My first binding ran with the arguments in the wrong order — `attemptSend(outbound, transport…)`
against a signature of `(transport, outbound…)` — and **it ran, because `tsx` executes without
typechecking.** It failed loudly rather than passing wrongly, which is luck rather than method.
**Typecheck the probe before trusting the probe**, the same way the negatives in a type-level
register are only evidence because an unused directive fails the build.
