# Running the database-integration suite

**13 files, 94 tests, gated behind an environment variable so they do not run in the normal
suite.** This document exists because *"we ran the integration tests"* is a sentence the release
checklist wants and nobody could honestly say.

**Status: the configuration prerequisites below are complete and verified. They are not
sufficient.** With all nine set correctly against a fresh database, **27 of 94 pass**. The rest
fail on *data* prerequisites that are not yet documented — see the last section. Nobody can take
this suite green by following a document, including this one.

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

**They are prerequisites about DATA, not configuration.** `IDENTITY_RISK_KEY_UNAVAILABLE` wants
pseudonym key material to exist for the scope; `IDENTITY_RISK_SOURCE_UNAVAILABLE` wants collected
source rows. A migrated but empty database satisfies neither, and nothing in the repository says
how to produce them.

**A note on the count: QA got 42 passing and this run got 27.** Same failures, different totals,
which means one of the two environments has something the other lacks — most likely seeded data.
**Do not average them or quote either as the number.** Until the data prerequisites are written
down, the honest statement is the one at the top of this document.

## What would close it

1. **Document how to produce the key material and source rows**, or provide a fixture that does.
   That is the whole gap; everything else here is settled.
2. Then re-run and record the number, with the machine and the database it was measured on.
3. Only then can the release checklist say the suite passes.

**Until step 1 exists, "we ran the integration tests" remains unsayable**, and the release
checklist should say 27 of 94 with this document beside it rather than a figure with no context.
