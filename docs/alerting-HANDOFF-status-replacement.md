# Handoff: the replacement status, ready to apply

**Why this is a separate file and not an edit.** `docs/alerting-HANDOFF.md` lives on
`agent/alerts-step-01`, which is checked out in Engineer's worktree while they are mid-flight on
the sender. Two sessions editing one branch is how work gets lost. **This is the complete
replacement text; applying it is one paste.**

**Verified against `5b0883b` before writing.** Every claim below is something I ran, or something
I am explicitly attributing to somebody else.

---

## REPLACE the `## Status` table's `03` and `06` rows, and add two rows

| step | state |
|---|---|
| 01 declarations, 02 keys and episodes | closed |
| 03 dry run | closed. Approved by Dharmik as a rehearsal: 44 rows now, 319 for the classifier, 3 never writable. **All five runbook commands have been run end to end against a disposable PostgreSQL 15 by QA** — both preflight outcomes, the apply, verify, a revert with occurrences arriving, and a concurrent writer proving the in-transaction re-check rolls the run back rather than writing 46 of 47. **Nobody has connected to production from an engineering machine**, so every figure remains a synthetic-fixture figure. It is an ANNOTATION, not a re-keying — the unique constraint forbids re-keying |
| 04 finding intake | closed |
| 05 routing and policy | closed |
| 05b escalation + limits | EXHAUSTED ruling implemented as three type-level impossibilities (`e056fc9`, verified by QA); the limit function landed in `42622d1` — L1, L2 and L4 bound at 135 enumerated cases, 0 breaches. The NUMBER is still a labelled guess |
| 06 email | **the seam, the ledger and the send queue exist and are pure; nothing talks to Resend.** No HTTP call, no signature verification, no webhook route, no key read anywhere. QA's nine properties are bound against the seam — six hold, one partial, and **M1 and M2 are unaskable of it by design**, which is what the send queue was built to own. Ten retry properties bound against the queue, including one proven against a real database. Resend is verified on `hawkviewapp.com` (PM's claim, not verified here) |
| **the flow, finding → send job** | **proven, in the test's hands.** A persisted `identity_risk_findings` row reaches an `alert_send_jobs` row through real foreign keys on a real database, and all five integration tests pass on a genuinely clean database. **But `runIntake` is called by nothing in `src/`, nothing schedules it, and `PipelineStore` has no implementation outside the test file.** The chain is joined by the test rather than by the product |
| 07 SMS | shelved by Dharmik until further notice. The tier survives; the channel does not |

---

## REPLACE "The migration has never been run anywhere"

> **The migration has been run against a disposable PostgreSQL 15**, forward and twice, with the
> runbook's confirmation query returning both columns nullable and the index present. It is
> **idempotent on a clean database** and, since `1ea8077`, **converges on a half-migrated one**
> rather than wedging it — a bare `ADD COLUMN` previously failed `42701` and left a failed
> migration blocking every subsequent one with `P3009`. A hand-made column of the wrong type
> now fails loudly, naming the found type, the expected type and the remedy, for **both**
> columns. All verified by QA on throwaway databases.
>
> **`backend/Dockerfile` line 44 runs `npm run db:migrate:deploy` on every container start**, so
> migrations apply on deploy. Whether a committed migration is live depends on whether a commit
> containing it has been deployed — not on whether an operator ran the runbook's step 0.

---

## REPLACE "96 tests, zero runs" — both places, and do not delete either

> The database-integration tests **have now been run, by QA, against a disposable PostgreSQL 15.**
> With every prerequisite the code asks for, **45 pass**; the rest fail on environment, not on
> product defects, and **none of the failures has been shown to be a defect and none should be
> quoted as one.** The prerequisites are all discoverable from the code and all satisfiable
> locally — they are named with a yes/no each in `alerting-B3-SIZED.md` — but setting all of them
> moves 42 passing to 45, so configuration is not the wall.
>
> **The wall is a timeout that four catch-alls were hiding.** `IDENTITY_RISK_SOURCE_UNAVAILABLE`
> is thrown from twelve places; every failure came from the twelfth, a bare catch that discarded
> its cause. Since `2e4cc54` it carries the cause, which reads `timeout expired`.
> `wrapped-risk-key-store.ts` has **four more** bare catches — lines 124, 138, 143 and 174 — and
> the twelve other `keyUnavailable()` calls there are guarded throws that must not be touched.
>
> **The 1588 passing figure still must not be read as covering this suite, and the suite still
> cannot be taken to a green run by anybody.** That is why it is a blocker on the release
> checklist rather than on the code.

---

## ADD, because these are all true at once and a status carrying only the good half is the failure

**The blocker found in the flow is FIXED and the fix was verified against the thing that would
have made it worse.** `runIntake` wrote incidents, checked its budget, then wrote jobs; a yield
between them left an incident with no job, which every later run skipped as
`INCIDENT_ALREADY_OPEN` — the alert never sent and nothing reporting it. Fixed in `5b0883b` by
one `commit(incidents, jobs)` with the budget check before the write phase.

**The acceptance test was not "did the stranding stop".** Four shapes produce
incident-with-no-job — `BEFORE_WATERMARK`, `RECORD_ONLY`, `NO_ELIGIBLE_RECIPIENT` and the yield —
and three must stay silent forever, so a fix that could not tell them apart would have delivered
the entire backfill. All four seeded at once across two organisations: **exactly one job came
out**, with the three silences each named. The commit is atomic rather than sequential, tested by
killing the backend mid-transaction: neither row survived.

**The ten lock-ordering failures are classified as environment; the ordering is unproven.** Not
"lock ordering verified". These failures do not demonstrate the ordering wrong, which is not the
same as demonstrating it right — nothing exercised it successfully, because the transactions did
not survive long enough to try. Not a blocker: the alerting pipeline reads
`identity_risk_findings` directly and never touches the key store.

**Six catalogue rules produce nothing, by decision.** Since `1ffc88e` the mapping derives from
`investigationGuidanceCode` rather than a rule-id prefix — `REVIEW_CONFIGURATION` and
`REVIEW_MAILBOX_RULE` map to no alert type. Those findings produce **no incident and no job**,
each named individually with its reason, and their rule ids surfaced in `unmappedRules`, which is
what somebody has to go and add. Two earlier versions of that mapping were wrong in two different
ways and both would have shipped.

**And the accounting invariant is a tripwire, not evidence the routing is right.**
`accountingProblems: []` means every finding appears exactly once across the jobs and the skips —
it is a self-reconciliation over one pass. It proves nothing vanished. **It cannot prove anything
was classified correctly: a finding wrongly skipped as `RECORD_ONLY` counts exactly once and the
books still balance.** It catches a future edit that adds a `continue` without a skip, which is
worth having. It must not be cited as the second line of evidence that delivery decisions are
right, because it is not evidence of that at all.
