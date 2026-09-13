# The forecast is verified against the release tip — and I have not landed it. Here is why.

> **RESOLVED, AND KEPT AS THE RECORD.** The engineer landed all five files themselves, which is
> option 2 below. Everything from here down describes the situation as it stood and is left
> unedited — the hazard it identifies is real, the judgement not to take a momentarily clean index
> was right, and both are worth having written down the next time two people are asked to write to
> one branch.
>
> **Two things below are now out of date and are not corrected in place:** the script *did* need a
> change — `alert_rule_dispositions.rule_id` has since been renamed to `alert_type_id` and the
> lookup key is now a branded type, so the script's SQL and its disposition map moved with the
> rename in the same commit that landed it. And the exit-code table still holds: re-verified
> directly, not through a pipe, against a disposable cluster at the tip that carries the rename.

## Verified at `59f3a40`

**Re-pointed and re-run rather than copied.** `decide()` has moved since I wrote against it — the
guidance-code mapping, the transaction, the widened key — so the script was re-checked rather
than assumed.

**It needed no change.** It still typechecks against the release branch's version, and
`alert_rule_dispositions` still uses `rule_id`, matching what the pipeline store reads; the rename
has not landed yet. **That the file is byte-identical is the result, not a shortcut.**

| | |
|---|---|
| no watermark | **exit 2** |
| unparseable watermark | **exit 2** |
| no `DATABASE_URL` | **exit 2** |
| valid run | **exit 0** |

Exit codes read **directly, not through a pipe** — the mistake I made the first time, when I was
reading `tail`'s status and not the script's.

Against a seeded database at the release tip: 2 findings in the window, **1 message would be
sent**, 1 withheld as `NO_ALERT_TYPE` — an `MBX` rule, one of the six that deliberately produce no
email — and the two independently-counted unmapped figures agree. **Row counts before and after
confirm it wrote nothing.**

## Why I have not committed it to `agent/alerts-step-01`

**Engineer has that branch checked out with seven uncommitted files**, including
`finding-pipeline.ts`, `alert-intake.service.ts`, `notifications.service.ts` and two new files —
the notification-row work in progress.

**There is no textual conflict.** I would add `docs/*.md` and `backend/scripts/`; they are
touching `backend/src/`. Nothing overlaps.

**The hazard is the stale index, and it is worse than a conflict.** Git refuses to check a branch
out twice but does not stop the ref from moving. If I commit to `agent/alerts-step-01` from here:

- their **HEAD** becomes my commit, which contains files their **index** does not have
- git then compares HEAD against index and reports **my files as staged deletions** in their tree
- **their next commit deletes them**, whether or not they use `-a`

So landing now would very likely produce the exact outcome the job exists to prevent: the
procedures and the forecast absent from the branch that ships, this time with a commit in the
history claiming they were added.

## What clears it

Any one of these, and the first is cheapest:

1. **Engineer commits or stashes**, then I land immediately — their index matches HEAD again and
   the new files simply appear.
2. **Engineer lands the files themselves.** They already have the content on the branch as
   `alerting-rollout-ADDENDUM-to-apply.md`.
3. **A stated window** in which they are not mid-edit, and they run `git status` afterwards before
   committing.

**I am not resolving this by picking one.** Option 1 costs them a few seconds and option 3 relies
on somebody remembering. **This needs the two of us not to be writing to one branch at the same
minute**, which was the original rule's purpose — the rule was not wrong, its cost was just being
paid in the wrong place.
