# Running the database-integration suite

**13 files, 94 tests, gated behind an environment variable so they do not run in the normal
suite.** This document exists because *"we ran the integration tests"* is a sentence the release
checklist wants and nobody could honestly say.

**Status: the configuration prerequisites below are complete and verified. They are not
sufficient, and the remaining failures are NOT missing data — see *Root cause* at the end. One
needs AWS KMS; the other is a stopwatch. The pass count is not reproducible.**

With all nine set correctly against a fresh database, somewhere between 22 and 29 of 94 pass on
the same machine. **Nobody can take this suite green by following a document, including this one**
— and documenting harder would not fix it.

## The nine environment variables

Taken from the source rather than from memory: `grep -rhoE "process\.env\.[A-Z_0-9]+"` across
the 13 files, and the accepted values from `risk-runtime-config.ts` and `pilot-risk-config.ts`.

| variable | value | why |
|---|---|---|
| `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS` | `1` | the gate. Without it every file skips |
| `DATABASE_URL` | a Postgres the suite may **write to and truncate** | never point this at anything you care about |
| `HAWKVIEW_IDENTITY_RISK_ROLLOUT` | `global` | anything else, or absent, takes the legacy pilot path |
| `HAWKVIEW_IDENTITY_RISK_MODE` | `shadow` | any other value makes the whole config `null` |
| `HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER` | `wrapped-v1` | ditto |
| `HAWKVIEW_IDENTITY_RISK_ENVIRONMENT` | matches `/^[a-z][a-z0-9-]{0,39}$/` — e.g. `test` | ditto |
| `HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` | **must be UNSET** | setting it alongside `ROLLOUT=global` makes the config `null` |
| `SECRET_ENCRYPTION_KEY` | 32 random bytes, base64 | any throwaway value; never a real one |
| `TZ` | `UTC` | see below |

**The four risk variables are all-or-nothing and fail silently as a group.** `riskRuntimeConfig`
returns `null` if any one is wrong, and null reads downstream as "risk is not configured" rather
than as "you made a typo". Getting one character wrong in `MODE` looks identical to not having
set up risk at all.

**`HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` must be absent, not empty.** It is checked with
`!== undefined`, so exporting it as `""` disables the global config.

## GENERATE the pilot scope expiry, never copy it

The pilot scope carries an `expiresAt` that must be **in the future and at most 7 days ahead**.

**So a documented example value is wrong a week after it is written** — and wrong in a way that
reads as a code fault rather than as a stale document, because what you get is a scope that will
not activate rather than a message saying the date has passed.

**Generate it. Do not copy one from anywhere, including from here:**

```bash
node -e "console.log(new Date(Date.now() + 6*864e5).toISOString())"
```

Six days rather than seven, so a slow afternoon does not cross the boundary.

## `TZ=UTC` is the documented trap, and it is real

A non-UTC server fails eleven tests that have nothing to say about timezones. Set it in the
environment the suite runs in, not in your shell profile, or it will be right on your machine
and wrong in CI.

## What a run looks like

```bash
export HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1
export DATABASE_URL="postgresql://user@host:5432/a_database_you_do_not_care_about"
export HAWKVIEW_IDENTITY_RISK_ROLLOUT=global
export HAWKVIEW_IDENTITY_RISK_MODE=shadow
export HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER=wrapped-v1
export HAWKVIEW_IDENTITY_RISK_ENVIRONMENT=test
unset HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
export SECRET_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
export TZ=UTC

npx prisma migrate deploy
find src -name '*.database-integration.test.ts' | sort | xargs ./node_modules/.bin/tsx --test
```

## Where it stops, measured

Against a **throwaway PostgreSQL 15** built by `initdb`, migrated with `migrate deploy`, with all
nine variables set as above:

```
tests 94 · pass 27 · fail 67 · skipped 0
```

Grouped by cause:

| count | error |
|---|---|
| 12 | `IDENTITY_RISK_SOURCE_UNAVAILABLE` |
| 11 | `IDENTITY_RISK_KEY_UNAVAILABLE` |
| 5 | `Cannot read properties of undefined` |
| 1 | `IDENTITY_RISK_SCOPE_UNAVAILABLE` |
| 1 | `Synthetic lock ordering was not observed` |
| 1 | `Evaluator exited before race gate` |

**These are not defects and must not be quoted as any.** The two dominant causes are the same
ones QA reported, reproduced here independently on a different machine and a different database —
which is what makes them environment rather than product.

**They are NOT prerequisites about data.** That was the first reading here and it was wrong; the
root cause is in the last section of this document. One failure wants AWS KMS and the other is a
timeout. **Do not quote any single pass count** — see *the pass count is not reproducible* below.

*(An earlier version of this document proposed documenting how to seed key material and source
rows. That would not have worked, for the reasons in the last section. The real list is there.)*

## Root cause, found in the source — and neither one is seeded data

**This supersedes the "data prerequisites" reading above.** It was directionally wrong: nothing is
missing from the database.

### `IDENTITY_RISK_KEY_UNAVAILABLE` — it wants AWS KMS

`identity-risk-pseudonym.ts:37` requires the key id to match:

```
/^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]{36}$/
```

That is an **AWS KMS key ARN**, and `aws-kms-mac.transport.ts` drives a real `KMSClient` —
`DescribeKeyCommand`, `GenerateMacCommand`, and a refusal if `maxAttempts !== 1`.

**So this is not key material somebody forgot to seed. It is an external cloud dependency.** No
document can make it green on a laptop; it needs either real KMS credentials with a real key, or a
substituted `ManagedMacTransport` in the test setup. The interface is already there —
`AwsKmsMacTransport implements ManagedMacTransport` — so a fake is possible, and whether the suite
should use one is a decision rather than a lookup.

### `IDENTITY_RISK_SOURCE_UNAVAILABLE` — it is a stopwatch, not a fixture

`mailbox-read-transaction.ts:7`:

```ts
if (!Number.isSafeInteger(remaining) || remaining < 100) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
```

and the retention path caps its whole budget at **one second** (`Math.min(deadlineAt - wallStart, 1000)`).

**So the error means the machine was too slow, not that anything was absent.** A connection that
takes longer than the remaining budget produces exactly this, and a cold Postgres easily does.

## Therefore: the pass count is not reproducible, and no checklist should quote one

Measured on **one machine, one cluster, one set of environment variables, the same commit**:

| run | pass | fail |
|---|---|---|
| earlier | 27 | 67 |
| 1 | 22 | 72 |
| 2 | 29 | 65 |

*(A third run was started and is void — the cluster was stopped under it.)*

**A spread of seven on the same machine, and QA independently reported 42 on theirs.** Those are
not four different environments discovering four different gaps. They are one speed-sensitive
suite sampled four times.

**This is the finding, and it is worse than a missing document:** *"we ran the integration tests
and N passed"* is not a reproducible statement, so it cannot support a release decision no matter
how carefully the environment is written down. Documenting prerequisites would not have fixed it,
because the prerequisites are already met — the clock is what varies.

## What would actually close it

1. **Decide whether the suite may substitute the KMS transport.** Until then the key-dependent
   tests cannot pass anywhere without AWS, and that is a fact about the suite rather than about
   any machine.
2. **Give the time-budgeted paths a budget that comes from configuration rather than a literal**,
   or accept that those tests measure the host and not the product. A one-second cap with a
   100 ms floor is a reasonable production guard and a poor test oracle; it is the same number
   doing two jobs.
3. **Only then quote a number**, with the machine it was measured on.

Until 1 and 2, the release checklist should say what is true: **the suite is not currently
reproducible, the configuration prerequisites are fully documented above, and the failures are
environment and timing rather than product defects.**
