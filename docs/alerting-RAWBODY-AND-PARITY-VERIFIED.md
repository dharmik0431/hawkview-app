# Two verifications at `6017f23`: the rawBody fix, and the mapping move

Both bound to `6017f23`, the tip of `agent/alerts-step-01`. `main.ts` and `bootstrap-options.ts`
are unchanged since `48d74bf`, so the tip and the fix are the same code — checked with
`git log 48d74bf..tip -- backend/src/main.ts backend/src/bootstrap-options.ts`, which is empty.

---

## 1. rawBody — verified through a pipeline that is closer to production than their test's

`backend/src/alerts/qa-rawbody-verify.ts`. Run at the tip with a disposable Postgres and a
synthetic `SUPABASE_URL`.

**Why not through their test.** Their test boots `ProbeModule` — one controller, no middleware, no
guards. `main.ts` boots `AppModule`, which applies two middlewares to every route **and registers a
global auth guard**. A check whose module is not the module that ships is the same shape of gap as
the one being fixed. So this probe imports the real `AppModule` and hangs a route off it.

**And the bytes are compared as bytes.** Their test returns `req.rawBody.toString('utf8')` in a JSON
response and compares strings, so the claim travels through a decode and a re-encode. This digests
the Buffer *inside the handler* and compares that digest with the digest of what went on the wire.

| | |
|---|---|
| wire sha256 | `a3159ac9…6746`, 59 bytes |
| `req.rawBody` sha256 in the handler | `a3159ac9…6746`, 59 bytes — **identical** |
| re-serialised body sha256 | `f17b3c72…4cdd` — **differs**, so `rawBody` is not redundant |
| genuine signature over the raw bytes | **`AUTHENTIC`**, computed in the handler |
| the same signature over the rebuild | `SIGNATURE_INVALID` |
| tampered body, genuine headers | `SIGNATURE_INVALID` — and a different sha, so it is a real second case |
| the same run with no options | `rawBody` absent, no verdict possible |

**Every claim is gated on a 2xx status**, because two runs of this probe produced booleans over
error pages before it was right (below).

### What this still does not establish, and cannot yet

- **There is no webhook controller anywhere in `src`.** Nothing routes to the verifier. "A real
  webhook authenticates" is bound up to the handler boundary; the endpoint is unbuilt.
- **`ResendSignatureVerifier` is in no module file**, so it is not in the DI graph. This probe
  constructs it directly, as their test does.

### Two findings from the real pipeline, for whoever writes that endpoint

**A webhook route must carry `@Public()`.** The probe keeps a second, identical route without the
decorator as a control: it answers **401 before the handler runs**. Resend sends no bearer token, so
a webhook controller written without `@Public()` fails every genuine delivery — the same shape of
defect as the rawBody one, one level up, and it would read like a Resend problem.

**Nothing binds `main.ts` to `HAWKVIEW_NEST_OPTIONS`.** Reverting that line to
`NestFactory.create(AppModule)` — the exact pre-fix state — and re-running their suite:

```
✔ THE RAW BYTES REACH THE HANDLER …
✔ A GENUINE SIGNATURE VERIFIES OVER THE RAW BYTES …
✔ WITHOUT THE OPTION THERE ARE NO BYTES AT ALL …
   3 pass, 0 fail
```

and the typecheck stays clean — the now-unused import raises nothing. Their third test guards
removing `rawBody` **from the constant**; nothing guards removing the constant **from `main.ts`**.
No test imports or executes `main.ts`; the two matches are in comments. The remedy that removes the
class rather than patching it is one exported `createHawkviewApp()` that both `main.ts` and the test
call, so there is one call site instead of two that agree by convention.

---

## 2. The mapping move is behaviour-preserving, in results

`backend/src/alerts/qa-reconcile-parity.ts`. **The same file, byte for byte** (md5 checked), run at
`6017f23` and at its parent `13100de`, outputs compared.

**Identical. 446,132 bytes, md5 `0e21845b…1faa` on both sides.**

The output carries the whole `ReconciliationReport` — `total`, `byShape`, `mapping` row by row with
each row's `alertTypeId`, the incident cardinalities, the episode counts — plus `TYPE_FOR_SHAPE`
itself and, per key, `exclusionKindFor` with and without a type, `resourceTypeFor`, and
`permanentlyUnresolvable` under all three subject roles.

**The corpus is generated, not chosen.** 55 keys — every shape from the parser's own patterns, every
base key again as a recovery, a recovery of a recovery, an unrecognised key and the empty key —
crossed with three occurrence counts, resolved and unresolved, four audit shapes, and `occurredAt`
absent / null / present. 888 rows. **Coverage is asserted rather than hoped:** all seven shapes
appear (`DIRECTORY_AUDIT` 96, `TENANT_SYNC` 144, `TENANT_CONNECTION` 48, `TENANT_INITIAL_SYNC` 48,
`TENANT_ONBOARDING` 48, `RECOVERY` 456, `UNRECOGNISED` 48), and a missing shape would be reported as
unsound rather than as a pass.

**And the check is shown able to fail**, which is what makes the identical result evidence:

| mutation at the tip | detected |
|---|---|
| remove `covers: ['TENANT_CONNECTION']` | **yes** — 310 changed lines: the table, `typeForShape` per key, `exclusionWithType` moving `SUBJECT_UNRESOLVED` → `TYPE_UNDETERMINED`, and the incident cardinalities |
| add `TENANT_ONBOARDING` to another type's `covers` (applied on top of the first) | **yes** — 510 changed lines, the newly-covered shape named |

Restored, and the parity re-run after restoring is identical again — so the pass is not an artefact
of a mutated tree.

**The universal argument, beside the empirical one.** The only runtime change in `reconciliation.ts`
is `TYPE_FOR_SHAPE`; `KeyShape` became a type-only alias and the added import is type-only. The two
tables are equal as values. So parity does not depend on my corpus covering production's rows — the
corpus run confirms end to end what the diff already implies.

**What I did not do:** reproduce 366 / 319 / 3 / 44. Those came from production and I did not touch
production. Parity is the claim that carries the approval forward, and it holds.

### One adjacent finding: the guard against an eighth publication kind is incidental

`TYPE_FOR_SHAPE` ends `return table as Readonly<Record<KeyShape, string | null>>`. The cast means a
new `PublicationKind` member would **not** be required in the initialiser, and the lookup would
return `undefined` where every consumer's type says `string | null`.

Adding an eighth member does fail the build today — but the error is
`reconciliation.ts(737)`, `Record<PublicationKind, number>`, which is **`byShape`'s object literal
inside `reconcile`**, not `TYPE_FOR_SHAPE`. The protection is real and it is in an unrelated
construct. If `byShape` is ever built in a loop — the natural refactor for a counter — the tripwire
goes, and what remains is the cast, which accepts the gap silently.

---

## What went wrong in my own instruments, again

Four in this session, and the pattern is the same one as last time.

1. **The probe exited 1 with no output at all.** Nest's default `abortOnError: true` calls
   `process.abort()` on a bootstrap failure, and `logger: false` had suppressed the reason.
   `abortOnError: false` with `logger: ['error']` produced it in one line: `SUPABASE_URL is
   required.`
2. **I sent the path without a leading slash**, so Node's own HTTP parser answered **400 with an
   empty body** before Nest saw anything.
3. **I gated every claim on `status === 200`, and a Nest POST answers 201.** Every boolean read
   false over a response that was completely correct. Wrong in the safe direction — which is the
   direction for a gate to be wrong in.
4. **Before the gate existed, three booleans were computed over a 401 error page and two of them
   read `true`** — `RESERIALISE_REALLY_DIFFERS` and `DIFFERENT_BYTES`. The route had never run.
   That is the same defect as "a pass produced by finding nothing", arriving through a third
   mechanism, and it is why the status gate is now in the file.

And one near-miss worth recording separately: a fresh worktree typechecked with two errors in
`notifications.service.ts` saying `alertTypeId` does not exist. **The generated Prisma client is
untracked**, so a clean worktree carries whatever was last generated. `npx prisma generate` (which
needs `DATABASE_URL` set even though it reads no database) fixed it, and the tip typechecks clean.
Had I reported that as a defect in the commit, it would have been my worktree's staleness dressed as
their bug.
