# U1 is bound, end to end — and three things beside it

Bound to `6fdfa4a`. `backend/src/alerts/qa-u1-end-to-end.ts`, run against a disposable Postgres
named `hvu1test` (the probe refuses any other database by name).

**The auth path is real, not stubbed.** `IdentityTokenVerifier` fetches a JWKS from `SUPABASE_URL`
and verifies an RS256 token against it, so rather than replacing the verifier with a double, the
probe generates a keypair, **serves a real JWKS over a real socket**, points `SUPABASE_URL` at it,
and mints real tokens. The guard, the verifier, the membership check, the controller and the
service are all the shipping code, inside the real `AppModule`. Nothing in the request path is a
test seam.

---

## U1: a setting made over HTTP changes what a tick does

This is the question I said could not be answered from either side alone. A test that supplies its
own disposition row tests the half that already worked; the endpoint did not exist. Both halves
exist now, and this is one run from an HTTP `PATCH` to the rows a tick wrote.

| what was set, over HTTP | write | stored | jobs the tick wrote | skipped |
|---|---|---|---|---|
| nothing | — | `null` | **1** | — |
| `ACT_NOW` | 200 | `ACT_NOW` | 1 | — |
| `ACT_TODAY` | 200 | `ACT_TODAY` | 1 | — |
| `RECORD_ONLY` | 200 | `RECORD_ONLY` | **0** | `RECORD_ONLY` |

**U1 holds.** The write reaches the database, and the tick's behaviour changes because of it.

## But the tick reads the tier as a boolean

`ACT_NOW` and `ACT_TODAY` produce **byte-identical output** — same jobs, same incidents, same
notifications, same rows — and both are identical to **no row at all**. The notification's severity
is written as `critical` in all three, taken from the catalogue rather than from the setting.

The single use of the disposition in `decide` is `if (disposition === 'RECORD_ONLY')`. So "the
disposition becomes the tier" is true of the stored value, true of the settings page, and **not
true of the tick**, which asks only *silenced or not*.

Today no *consulted* alert type has a catalogue severity other than `ACT_NOW` — the two consulted
types are both `ACT_NOW` — so the only reachable departure is downwards to `RECORD_ONLY`. Raising
urgency is expressible, storable, displayable, and inert. **That is the subtler kind of cosmetic:
not a control that does nothing, but a control that does something in one direction only.**

Worth saying plainly: this may be exactly what was intended for now. What is not acceptable is for
it to be *assumed* — an MSP who sets `ACT_NOW` on something the catalogue calls `ACT_TODAY` has
made a choice the product records and never acts on.

## The endpoint is not public — checked four ways

| | |
|---|---|
| `GET` with no token | **401** |
| `PATCH` with no token | **401** |
| `GET` with a forged token | **401** |
| `GET` with a valid `aal1` token | **403** (MFA required) |
| rows written by any of them | **0** |

## A value outside the vocabulary is refused at the write

| attempt | answer |
|---|---|
| `RING` — the old channel vocabulary | 400 |
| `act_now` — right word, wrong case | 400 |
| no `disposition` at all | 400 |
| an alert type the catalogue does not declare | 400 |
| another organisation's id | 403 |
| **rows written by all five** | **0** |

And one layer down, a direct `INSERT` of `RING` is refused by the database itself — `23514`, the
CHECK constraint. The store reads `row.disposition` without validating it, and that is safe only
because of this constraint. Worth knowing it is load-bearing.

## An unreadable stored value: the branch works, but it is not the case that can happen

`storedValueIgnored` fires when a **catalogue type's** stored value is outside the vocabulary. I
reached it by dropping the CHECK constraint, writing `RING`, and reading the list: the row comes
back carrying `storedValueIgnored: "RING"` alongside `disposition: "ACT_NOW"`. **The branch is
correct.** It is also unreachable while the constraint stands — defensive, not live.

**The case that can happen is the other one, and nothing reports it.** A row whose `alert_type_id`
is not a catalogue id — `HV-ID-AUTH-010.v1`, a risk rule id, which is exactly what this column used
to hold — is:

- **invisible to the settings page.** `list()` walks the catalogue and looks up each type, so a
  stored row for an id that is not in the catalogue is never looked at. The list returned **7 rows
  and none mentioned it** (the count is stated because a list that returned nothing would also
  report nothing — that negative would be vacuous).
- **invisible to the tick.** `pipelineStore` does collect it — `Dispositions.unreadable` — and then
  `IntakeReport` has no field for it. Measured: the report's keys are `findingsRead`,
  `incidentsWritten`, `notificationsWritten`, `jobsWritten`, `skipped`, `unmappedRules`,
  `accountingProblems`, `yieldedOnBudget`. The list is built and dropped.

So "reported, never defaulted" is true where the value is unreadable and false where the **key**
is. That is the same silent-ignore shape the column rename was meant to close, surviving one field
over.

---

## A migration edited in place, and both Prisma commands say it is fine

`6fdfa4a` changed the CHECK constraint **inside an existing migration** rather than adding a new
one, justified by the table never having been deployed. I took a database migrated **before** that
edit and ran the tip against it:

```
$ prisma migrate deploy    →  "No pending migrations to apply."     exit 0
$ prisma migrate status    →  "Database schema is up to date!"      exit 0
```

and the constraint on that database is still

```sql
CHECK (disposition IN ('RING','EMAIL','DIGEST','RECORD_ONLY'))
```

so writing `ACT_NOW` is **refused — 23514**. Every `PATCH` from the new endpoint would fail, and
both Prisma commands report a healthy database.

**This is conditional on the premise, and the premise is the whole thing.** If that migration has
never been applied anywhere, there is nothing here. I did not check production and will not. One
query settles it, and somebody with access should run it before release:

```sql
SELECT pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'alert_rule_dispositions'::regclass AND contype = 'c';
```

If it names `RING`, that environment is half-migrated and silent about it. The remedy that does not
depend on the premise being true is a **new forward migration** that drops and re-adds the
constraint — correct whether or not anywhere already has the old one.

---

## Four instrument failures, all mine, all caught by the gates

1. `MembershipRole` has no `OWNER`; it is `MSP_OWNER`. Loud, immediate.
2. `alert_send_jobs` has no `organization_id` column. Loud, immediate.
3. **Every request came back 401.** My token carried only `email` and `aal`; the real verifier
   requires a UUID `sub`, `role: 'authenticated'`, `is_anonymous: false` and a UUID `session_id`.
   The endpoint was fine — my token was not.
4. **Then every request came back 403.** An earlier run had left a `users` row with a different
   `auth_provider_user_id`, and my `ON CONFLICT (id) DO NOTHING` kept it — so the token verified
   and the lookup found nobody. **A test that depends on ambient state is testing the machine it
   ran on**, which is the warning written in this repo's own integration test, and I walked into
   it anyway.

Both 3 and 4 would have been reported as *the endpoint refuses valid callers* if I had trusted the
status code instead of chasing it. The reason they were not is the rule from the last round: every
claim in this probe is gated on the write having actually succeeded, so a failing auth path made
the U1 result read **false**, never true.
