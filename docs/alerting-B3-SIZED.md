# B3, sized — the integration suite's prerequisites, named

**What PM could not tell Dharmik: whether this is an hour of writing it down, or something
broken. It is neither, and the answer is specific.**

All measured against a disposable Postgres 15 on loopback, UTC server, at the engineer tip.
**I did not fix the environment.** One file was instrumented to find out which guard was
firing and restored to pristine immediately after; `git diff` against the commit is empty.

## The headline

**Every prerequisite IS discoverable from the code. Setting all of them does NOT produce a
green run.** 42 passing before, **45 after** — so configuration is not the wall.

The wall is a **timeout**, and it was invisible because a catch-all hid it.

## The named prerequisites, with a yes/no on each

| prerequisite | required value | satisfiable locally? |
|---|---|---|
| `DATABASE_URL` | loopback, db name matching `/test\|qa\|hawkview_ci/` | **yes** |
| `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS` | exactly `1` | **yes** |
| **server timezone** | **UTC** — documented in the acceptance gate | **yes**, and it moved 11 tests |
| `SECRET_ENCRYPTION_KEY` | 64 hex or 44-char base64, decoding to 32 bytes | **yes**, generate one |
| `HAWKVIEW_IDENTITY_RISK_MODE` | exactly `shadow` | **yes** |
| `HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER` | `wrapped-pilot-v1` or `managed-kms` | **yes** — pick `wrapped-pilot-v1`; `managed-kms` would need a KMS |
| `HAWKVIEW_IDENTITY_RISK_ENVIRONMENT` | matches `/^[a-z][a-z0-9-]{0,39}$/` | **yes** |
| `HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET` | any secret | **yes** |
| `HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` | JSON, exactly the keys `organizationId`, `customerTenantId`, `expiresAt` | **yes, with a catch — see below** |

**Nothing here needs a cloud service, a real tenant, or a secret nobody has**, provided the key
provider is `wrapped-pilot-v1`.

### The catch in `PILOT_SCOPE`, and it matters for writing the setup down

`expiresAt` must be **in the future and no more than 7 days ahead**, must be exact ISO with
milliseconds, and the JSON is rejected if it contains a backslash, a duplicate key, or any key
beyond those three. **So a documented example value expires within a week.** The setup
instructions have to tell an operator to *generate* the scope, never to copy one — otherwise the
document is wrong seven days after it is written, and wrong in a way that reads as a code fault.

## The third class PM asked about — and it exists

Not two classes. Three:

| class | count (UTC run) | what it is |
|---|---|---|
| `IDENTITY_RISK_SOURCE_UNAVAILABLE` | 22 → 25 | **a timeout, disguised** — see below |
| `IDENTITY_RISK_KEY_UNAVAILABLE` | 19 → 13 | key/scope prerequisites; partly cleared by the vars above |
| **assertion failures** | 10 | mostly concurrency and lock-ordering: *"Every concurrent caller must reload the winner"*, *"late-started exact worker must actually wait on the fixture lock"*, *"Synthetic lock ordering was not observed"* |

The third class is **not** environment-shaped on its face. It is about lock ordering and
concurrent claim behaviour — the same family the apply's optimistic-concurrency work lived in.
**I have not established whether those are real defects, and they must not be quoted as either
until somebody does.**

## What the catch-all was hiding, and this is the finding

`IDENTITY_RISK_SOURCE_UNAVAILABLE` is thrown from **twelve** places in
`mailbox-read-transaction.ts`. I tagged each one to find out which fires. **All of them were
site 12** — the bare `} catch { throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE') }` at the
end, which discards the original error.

Carrying the underlying message through gave one line:

```
timeout expired
```

That is a connection/statement timeout, not a missing credential. **So the remaining failures
are a timing or pool-configuration prerequisite, not a secret nobody has** — and running a
single file alone does not clear it, so it is not contention between test files either.

**The catch-all is why this could not be sized before.** Eleven specific, well-reasoned guards
each say exactly what is wrong, and a twelfth swallows everything else and answers with the same
word. Every distinct underlying failure arrives wearing the same label, so "the source is
unavailable" was the only sentence available to anybody trying to diagnose it — including me,
until I instrumented it.

## So: how big is it

- **Writing down the prerequisites: about an hour**, and I have done most of it above.
- **Getting to a green run: not yet sized, and honestly so.** Something times out, the reason is
  currently unknowable without changing the code, and the concurrency assertions are unexamined.
- **The cheapest thing that would unblock everyone else**, and it is not my call to make: have
  the catch-all carry its cause. One parameter. Until then, every future diagnosis of this suite
  starts where mine did.
