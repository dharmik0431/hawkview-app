# HAW-70 staged upgrade driver

This document describes `scripts/haw70-upgrade-runner.ts` and its fixture
module `scripts/haw70-upgrade-witness.ts`.

It is a **driver**, not another planner. The three earlier HAW-70 modules
(`-target`, `-config`, `-launch-plan`) describe and validate an upgrade; this
one performs the ordered stages against a real database through an injected
boundary.

Its registration is deliberately narrow, and is described in full under
"How this is registered in CI" below. No `package.json` script and no
application or startup code imports it. In this candidate the workflow
registers its NONCONNECTING suite on every run, and prepares a default-off
`workflow_dispatch` choice for the physical upgrade. That preparation is not
published and has never been dispatched, so running the physical protocol
remains an explicit, deliberate act that has not occurred.

## What gap it closes

The reviewed candidate `a88af992b4ee156a8abf9c1a64c3725055acc42a` adds 14
migrations on top of the pinned baseline `8928934406fdcaf5fdb911d2003ac03439b05145`.
Every HAW-70 result so far qualifies a *fresh* database: the candidate's
migrations applied to an empty schema. The remaining gap is **older data**:
a database that already carries baseline-era rows, upgraded in place.

This driver exercises exactly that sequence:

1. deploy the baseline migrations,
2. insert a fixed legacy fixture that only baseline columns can hold,
3. deploy the candidate migrations over it,
4. assert history, preservation, legacy tag nullity, authority backfill and
   catalog shape,
5. deploy the candidate a second time and assert it changed nothing,
6. delete the rows it owns.

## The clean-process requirement

`runHaw70StagedUpgrade` refuses when **the environment snapshot it is given**
contains ambient configuration: `NODE_OPTIONS`, `NODE_PATH`, any proxy
variable, `PGSERVICE*`, anything matching `^(PG|DOTENV_CONFIG_)`, a loader
cache (`JITI_FS_CACHE` other than `false`), or a non-UTC `TZ`.

The distinction matters. The checks read the caller-supplied snapshot, not
`process.env`, so they detect a tainted *snapshot*; they cannot detect a
tainted *process* whose caller passed a clean snapshot. Keeping the process
clean is the caller's obligation, and the next paragraph says why no check
here could discharge it.

**A late check cannot undo a preload.** By the time this module's first line
executes, a `--require` in `NODE_OPTIONS` has already run, a `PGHOST` has
already been read by anything that constructed a client, and a dotenv config
has already mutated `process.env`. The refusal is therefore a *precondition on
how the process was launched*, not a sanitizer. It must be satisfied by the
caller starting a clean process; the driver can only detect the violation and
decline, which is what it does — before it constructs a client or launches a
child.

For the same reason the driver never spreads `process.env` into the child. It
builds the 33-key projection key by key and cross-checks that set against the
public `HAW70_LAUNCH_ENVIRONMENT_KEYS` so the two cannot drift apart silently.

## Refusals before any side effect

In order. Everything down to and including installed-tool resolution happens
before any connection is opened or any child is spawned. The emptiness
refusal is different and is marked below: it is a **query**, so it
necessarily runs *on* an open connection — it precedes every deployment, not
the connection itself.

| condition | reason |
| --- | --- |
| `HAWKVIEW_CI_MIGRATION_PROFILE !== 'haw70-upgrade'` | wrong or absent profile |
| `HAWKVIEW_RUN_HAW70_UPGRADE !== '1'` | not opted in |
| loader cache enabled / non-UTC `TZ` | nondeterministic evaluation |
| any ambient control variable present | see above |
| `process.platform !== 'linux'` | **actual** platform, not a claim string |
| `!/^v22\./.test(process.version)` | **actual** runtime, not a claim string |
| staged source invalid for the expected candidate commit | wrong bytes |
| any `HAWKVIEW_HAW70_STAGE_*` key supplied | the driver owns its stage; an external handoff is a second authority path |
| a declared executable-source file modified, untracked or absent | an unmodified schema is not unmodified code |
| staged handoff keys or bytes unqualified | wrong or unverifiable source |
| datasource URL unparseable | malformed handoff |
| target database not empty | would corrupt an existing database — **checked on the open connection, before any deployment** |
| caller supplied any key other than `environment` | forged boundary/receipt |

The platform and runtime checks read `process.platform` and `process.version`
directly rather than comparing `RUNNER_OS` to a claimed value. A string in the
environment is a claim; it is not evidence about the machine. A consequence is
that the public entry **cannot complete on a macOS workstation**, by design.

## Local verification and its limits

`scripts/haw70-upgrade-runner.test.ts` drives the exported core,
`executeHaw70UpgradeStages`, with a fake `Haw70UpgradeBoundary`. The fake's
rows are authored in the test, read from the staged migration tree, never
echoed back from the driver.

Nothing in that suite opens a database, starts PostgreSQL, launches the Prisma
CLI, runs a migration, generates a client or starts the application — **not
even in a mutation control**.

What those results qualify:

- the stage order, and that no later stage runs after a failure,
- every refusal path, including the public entry's,
- the fixed `migrate deploy` argv and the closed child-environment projection,
- the assertion logic: each authored defect fails at its own named check,
- that no outcome carries a credential, URL, row value or raw error.

What they **do not** qualify, and what stays unproved until this driver runs
against a real disposable database in a registered CI job:

- that the SQL is valid PostgreSQL,
- that the catalog queries read the objects they claim to read,
- that the candidate migrations actually preserve the fixture,
- that the backfill actually produces one authority row per tenant,
- that the cleanup actually deletes what it claims.

### Two further behaviours worth knowing

**`retained` is populated only on the fully successful path.** A run that
fails after the fixture has committed returns `retained: []`, so the
inventory is not the way to learn that rows were left behind. `completed:
false` together with the exact `phase` and `counts.fixtureTenants` /
`counts.fixtureSnapshots` — both set before the INSERTs and preserved into the
failure outcome — is what tells you a fixture may still be present.

**The staged scratch root is never deleted.** The core creates one `mkdtemp`
directory under the OS temp directory per invocation and materializes into it;
the materializer documents those trees as never reused or deleted. A full local
suite run therefore leaves roughly forty `haw70-upgrade-*` directories of
staged migration source behind. That is temp-file hygiene, not a correctness
problem, but it is why the core is not side-effect free despite routing every
database and migration-child effect through the boundary.

A mock cannot manufacture physical proof. These tests check the driver; they
do not check the database.

## Owned cleanup, and what is deliberately retained

Cleanup deletes, child-first: fixture snapshots, then sync states, then
customer tenants. It issues no `TRUNCATE`, no `DROP`, no trigger disable, no
`ALTER TABLE`, and never touches `_prisma_migrations`.

Three things are retained on purpose and reported in `outcome.retained`:

1. **The authority tombstones.** Deleting the fixture organizations would
   cascade them away, destroying the evidence that the backfill ran.
2. **The two fixture organizations**, for the same reason.
3. **The sync-state delete's effect on the authorities**, which is observed
   rather than suppressed — see below, because it is not uniform.

### The retained revisions are 2, 3 and 2 — not all 2

This is worth stating precisely, because an earlier version of the check
required revision 2 for every retained authority and **would have failed a
correct physical upgrade**.

Cleanup deletes, in order: the snapshots, the sibling's sync-state row, then
the three tenants. Two committed triggers fire:

- `20261114191500_tenant_health_sync_state_source_revision` installs
  `tenant_health_sync_state_delete_invalidate`, which on a sync-state `DELETE`
  advances `source_revision + 1` for the matching authority **where
  `authority.live`**, clears the exact pointer and zeroes the sequence. The
  sibling owns the deleted row, so its authority goes 1 → 2 while still live.
- `20261113021500_tenant_health_tenant_deletion_tombstone` then advances every
  deleted tenant's authority again and marks it dead.

So the sibling finishes at **3** and the other two at **2**, all with
`live = false`, a null pointer and sequence 0. `tenant_health_snapshots`
carries no non-TRUNCATE trigger, so deleting the snapshots first advances
nothing.

The expectation is bound per identity — organization, tenant and the
incarnation the backfill minted — rather than as a shared value or a `>= 2`
lower bound. A lower bound would accept a sibling that never invalidated,
which is the one thing this check exists to notice.

Retention is inventoried rather than silent: a row left behind that nothing
names is indistinguishable from a cleanup bug.

## What the catalog check binds

Named constraints are not enough: a validated `CHECK` with the right name can
check something else, and a foreign key over the right columns in the wrong
**order** is a different constraint. So the check reads `conkey`/`confkey` for
the ordered local and referenced columns, the referenced relation, and both
referential actions, and it requires each `CHECK` definition to match patterns
that bind its semantics — `source_revision > 0` rather than merely mentioning
`source_revision`, and the allowed tag counts `{0, 3}` exactly. The two
snapshot scope fences (`organization_id` and the composite
`customer_tenant_id, organization_id`) are included; they were previously
absent from the expectation although the existing database suite covers them.

Privileges are read as **effective** answers for every privilege the committed
`REVOKE` clauses name, on the table *and* the `tenant_health_observation_sequence`
sequence, for `PUBLIC` and for the conditional `anon` and `authenticated`
roles. A role that does not exist is recorded as absent and nothing is
asserted about privileges it cannot hold; no role is created. Reading
`relacl IS NULL` as "PUBLIC holds nothing" is the mistaken rule this replaces.

The source-writer inventory covers the six relations the HAW-70 invalidators
are installed on — `customer_tenants`, `directory_audit_logs`, `sync_states`,
`tenant_entra_snapshots`, `tenant_health_snapshots` and
`tenant_health_source_authorities` — and binds each trigger's timing, event
set, row/statement mode, function identity and enablement. The earlier
three-relation scope omitted `sync_states`, whose delete invalidator is the
trigger that *determines* the cleanup outcome above, so the inventory could not
observe the mechanism the cleanup assertion depends on.

## The TRUNCATE guard check is derived, not hardcoded

`assertUpgradedCatalog` compares the live `pg_trigger` contents against the
TRUNCATE guards the **staged candidate SQL itself declares**, parsed from the
staged bytes.

**A correction, because an earlier version of this section had the facts
backwards.** `backend/prisma/migrations` hashes to
`e6df95ba81d71a7bc9670b283b256279ac901397` at *both* the reviewed pin
`a88af992b4ee156a8abf9c1a64c3725055acc42a` and the current source — 94
migrations each, byte-identical — and a88af992 is the commit that *adds* the
truncate-refusal migration. The commits that lack it are the pinned baseline
`8928934406fdcaf5fdb911d2003ac03439b05145` and the main anchor
`eaa92ebdd5f7893b50023d819a7c3ddde56a2955`, both at tree
`fb1451eb09db43004f7e31f205e9e8a9f4b1385d` with 80 migrations.

So a hardcoded expectation would be correct today, and the earlier claim that
it "would reject legitimately staged bytes" was false.

The set is still derived, for a different and real reason: the candidate this
driver stages comes from the `GITHUB_SHA` claim, not from the pin. The
expectation therefore has to answer to the bytes that were actually staged. A
literal set would be right until the first candidate that changes trigger DDL,
and would then be silently wrong rather than loudly wrong.

Two details the derivation has to get right, because the catalog reports them
whether or not the parser noticed:

- an event list may carry several events, as in
  `BEFORE UPDATE OR DELETE OR TRUNCATE`, which a TRUNCATE-only pattern misses
  while `pg_trigger` still sets the TRUNCATE bit for it;
- `ENABLE ALWAYS` is load-bearing. A trigger left at the default `'O'`
  (origin) is enabled, passes any not-disabled test, and still refuses
  nothing in replica mode — precisely what `ENABLE ALWAYS` exists to prevent.
  The assertion therefore requires `tgenabled = 'A'` wherever the staged SQL
  declared it, `'O'` where it did not, and the query selects only triggers
  whose `tgtype` carries the TRUNCATE bit, scoped to the relation each guard
  names. Pinning the non-`ALWAYS` case to `'O'` rather than merely "not `'D'`"
  matters: `'R'` (replica-only) is enabled and not disabled, and would fire
  only on a replica.

**A scope limit worth stating.** The writer/immutability inventory covers the
three relations in the `writerTriggers` query's own `IN` list —
`customer_tenants`, `tenant_health_snapshots` and
`tenant_health_source_authorities`. Non-TRUNCATE triggers the candidate set
installs on other relations are outside it, deliberately, and are not claimed
to be checked.


## Three ordering and boundary properties worth naming

**Installed tooling is qualified before the first connection.** The driver
materializes and validates its own stage, then calls `boundary.qualify(...)`,
and only then `boundary.connect()`. The qualification reuses
`buildHaw70UpgradeLaunchPlan`, which checks that both `prisma` and
`@prisma/config` are the expected version and that the package declares the
expected binary. It used to run only inside `deploy`, which did block a bad
CLI from launching — but by then a client had been constructed, connected and
queried. Each deployment still revalidates rather than trusting the earlier
verdict.

**The executable-source status runs on the sanitized Git boundary.** It uses
the same closed environment and fixed overrides as the established read-only
adapter: no inherited Git routing or configuration, optional locks off,
fsmonitor, hooks and the untracked cache disabled, a fixed executable and
bounded output and time. Without that it inherited ambient `process.env`, so
an ambient `GIT_DIR` or `GIT_WORK_TREE` could have made it report a clean
status about a *different* working tree. The entry also refuses a snapshot
carrying any `GIT_*` variable. The declared list includes the two transitive
files this path actually executes — the source-plan helper reached through
`haw70-upgrade-git-source.mjs` and the native target helper reached through
`haw70-upgrade-target.ts` — neither of which the migration selection covers.

**The real adapter is observed inertly, and the inertness claim is precise.**
A child process redirects the `pg` module to an inert stub and states the
platform and runtime facts, then calls the real public entry, which still
accepts only its environment snapshot and imports `pg` by name — nothing is
injected into it. The recorded log carries the actual constructed client
options, the `connect`, the forwarded query SQL, the actual migration-child
request and the `end`. In that mode: no socket opens, no name resolves, and no
migration executable runs — the child request is recorded and refused.
Read-only `/usr/bin/git` **is** delegated, because the driver materializes its
own stage from the repository and refusing git would stop the run long before
the adapter exists; every git invocation appears in the log and is counted.

Because the entry refuses unless the declared executable source is tracked and
clean, that observation runs in a disposable clone where those files are
committed. A synthetic draft commit is made **only when the copied bytes
differ** from the clone's HEAD; once this source is sealed the bytes are
identical, nothing stages, and the clone's own identity is kept. An
unconditional commit would exit nonzero for "nothing to commit" and fail
exactly in the sealed/restored validation. Both paths are exercised.

The delegated read-only Git exception is enforced on the **complete request**,
not on its verb.

A verb allowlist is not the same thing, and the earlier version proved it:
`config` and `symbolic-ref` both have write forms, and nothing validated the
arguments after the verb, so `config core.hooksPath /tmp/x` and
`symbolic-ref HEAD refs/heads/other` would have been delegated as writes. It
also skipped containment when `-C` was absent, left `cwd` unchecked, rejected
only `shell === true` so a string value passed, and inspected the environment
only when one was supplied — an absent one inheriting ambient configuration.

What is enforced now: only `spawnSync`, only `/usr/bin/git`, then the
production caller's **complete fixed prefix, required token for token** —

```
--no-pager --no-replace-objects
-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false
-C <absolute canonical owned root>
```

— an environment that must be **present and exactly** the closed nine-key set
with those values, a positive bounded `timeout`, no `shell` value of any kind,
a contained `cwd` if one is present, and none of `detached`, `uid`, `gid`,
`input` or `argv0`. Then the verb must be one of six, and its **trailing
arguments must match an exact form**:

| verb | permitted trailing form |
| --- | --- |
| `cat-file` | `commit <40-hex>` or `blob <40-hex>` |
| `ls-tree` | `-r -z --full-tree <40-hex> -- <relative paths>` |
| `rev-parse` | `--show-toplevel`, `--is-shallow-repository`, `--absolute-git-dir`, `--git-common-dir`, `--verify HEAD^{commit}`, or `--git-path <relative>` |
| `config` | `--local --name-only --get-regexp <pattern>` — read-only; the shape leaves no room for a value or a mutating switch |
| `for-each-ref` | `--format=%(refname) refs/…` |
| `status` | `--porcelain=v1 --untracked-files=all -- <relative paths>` |

`symbolic-ref` is gone, because the driver never issues it. These are the
forms the driver's single Git call site and its executable-source status
command actually use; the adapter observation asserts that every one of the
~1,900 calls a real run delegates passed this validator, so the set is neither
a verb-level approximation nor too narrow to reach the adapter.

**Why the prefix is required rather than permitted.** Treating those `-c`
settings as optional left a real omitted barrier. `GIT_CONFIG_NOSYSTEM` and
`GIT_CONFIG_GLOBAL=/dev/null` suppress **system and global** configuration —
not the owned repository's own `.git/config`. Measured directly: a locally
configured value is still returned under that exact environment, and only the
`-c` override changes it. So a contained `status` request with the safe
environment and no `-c` settings would have been delegated, and a local
`core.fsmonitor` helper could then execute inside the native child, outside
every JavaScript patch here. Both real call sites emit this prefix verbatim,
so requiring it costs nothing.

**Why a relative `-C` is refused rather than interpreted.** It cannot be
validated here at all. `realpathSync` resolves a relative target against the
observer's working directory, while Git applies `-C` *after* changing to the
spawn `cwd`. Measured: with the observer in `<owned>/backend`,
`cwd = <owned>` and `-C ..`, validation resolves to `<owned>` while Git lands
in its parent. The production caller always supplies an absolute canonical
root, so the ambiguous form is rejected — as is an absolute but non-canonical
path, and a symlink pointing at the owned root.

Thirty-three negative controls cover both write forms, a mutating `config`
switch, three network or destructive verbs, a `core.hooksPath` redirect, each
of the five required prefix barriers deleted in turn, all three `-c` settings
dropped together, a reordered prefix, an outside-repository target, a relative
target under an in-repository `cwd`, a non-canonical absolute target, a
symlinked target, an outside `cwd`, a routing override, a tampered and an
absent environment, `shell: true` and `shell: '/bin/sh'`, a missing timeout, an
absolute and a traversing path, a non-OID `cat-file`, an unexpected
`rev-parse` ref, a trailing extra token, a different process API and a missing
verb. None of them runs: each is refused before delegation, with its own
distinct reason recorded. Each expected reason was derived from the predicate
before the controls ran, so the assertion checks that reasoning rather than
recording whatever the run produced.

Delegated receipts are **representative, not a per-invocation byte audit**:
one compact line per call, plus the full request — argv, cwd, environment,
`shell`, `timeout`, `maxBuffer`, `stdio` — recorded once per distinct form
signature, with counts. The signature is the verb plus the argv length, so
different object ids or paths of the same arity share one representative.
That is command-form evidence. Previously a delegated call kept only one
argument, so even that was unavailable.

### What this observation does NOT establish

Stated plainly, because the receipt is detailed enough to be mistaken for more
than it is.

The stub accepts the connection and answers two initial identity/emptiness
queries; the observer then **refuses the first baseline migration child**. So
the assertions expect `completed: false`, phase `baseline-deploy` and zero
completed deployments. This is not actual-adapter execution of baseline
history, the fixture writes, the candidate upgrade, the no-op comparison or
owned-row cleanup. `pg:end` here means the connection resource was closed, not
that any fixture row was removed.

The query receipt records a truncated SQL prefix and a parameter count, and the
test inspects only the first unparameterized identity `SELECT`. No claim is
made about parameter values, their ordering, or cleanup-SQL forwarding. The
fake-core suite covers that staged control flow; physical migration and
database semantics remain evidence a registered disposable-CI run would have
to produce. No second database simulator is built to paper over this.


## How this is registered in CI

Two separate registrations, and two separate proofs. Conflating them would be
the easiest way to overstate what is known.

### 1. The nonconnecting suite, on every run

`scripts/haw70-upgrade-runner.test.ts` is the fourth explicitly named file in
the existing serial HAW-70 TypeScript step of `.github/workflows/quality-gates.yml`,
alongside the target, config and launch-plan suites. It keeps that step's
`--test-concurrency=1`, its step-level `JITI_FS_CACHE=false` and
`TSX_DISABLE_CACHE=1`, the dotenv refusal that precedes it, both dependency
installs, the full-history checkout and the disabled checkout credential. The
narrow compiler command is unchanged and already lists this file among its
explicit roots, so no compiler-config edit was needed.

This suite opens no database and launches no migration executable. It proves
control flow, refusals and assertion logic — nothing physical.

### 2. The staged upgrade, default off

A `workflow_dispatch` input `migration_profile` defaults to `fresh`, which is
exactly today's behaviour: apply every committed migration to an empty
disposable database. The only other choice is `haw70-upgrade`, and **only the
exact conjunction** of a `workflow_dispatch` event and that choice enables the
physical step. A pull request cannot reach it, and neither can a default
dispatch.

The upgrade step runs **before** any fresh migration, and the fresh migration
and the database application suite are skipped when it runs. That exclusion is
load-bearing, not tidiness:

- the driver refuses a non-empty target, so a fresh deploy first would make it
  refuse; and
- after its scoped cleanup it deliberately retains the authority tombstones
  and the two fixture organizations, which must never be handed to the
  ordinary suite as a pristine database.

The workflow name, the `backend-quality` job id, the PostgreSQL service, the
read-only permissions, the frontend job and the 25-minute backend deadline are
all unchanged. The job identity matters: the driver's target guard admits only
workflow **Required quality gates**, job **backend-quality**, a
`workflow_dispatch` event and a branch ref, so the step has to live inside
that job rather than in a new one.

### The launch, and what the workflow does not supply

The step resolves the setup-node executable first, then hands Node a **closed**
environment built with `env -i` before Node initialises: `PATH=/usr/bin:/bin`,
the seventeen hosted identity values carried through exactly as GitHub reports
them, and the fixed physical settings. Nothing else. No stage handoff, no
`NODE_OPTIONS` or `NODE_PATH`, no proxy, no `PG*`, no dotenv, no Git routing,
no credential, no secret reference, and no caller-supplied URL, command,
binary or source SHA.

The identity values are carried, never manufactured. The target guard requires
`GITHUB_SHA`, `GITHUB_WORKFLOW_SHA` and the actual checkout to agree, so a
mismatch must fail rather than be substituted with HEAD. The candidate comes
from those dispatch claims and the driver's own raw-Git ancestry and
selected-byte checks bind it; the historical baseline `8928934406fd` and the
reviewed pin `a88af992` stay distinct from it, and no commit is hardcoded as
the runtime candidate.

A small inline module calls the exported `runHaw70StagedUpgrade` once with that
closed environment, prints only the sanitized outcome, and exits non-zero on
`completed !== true`, on an unexpected rejection, or on its 20-minute bound.

That bound deserves an honest description. It is a JavaScript timer raced
against the driver's promise, so it is **cooperative**: it fires only when the
event loop is free to deliver it, and a long synchronous operation inside the
driver can delay delivery past the nominal 20 minutes. It is therefore a
best-effort guard, not a hard kill. The real outer bound is the unchanged
25-minute CI job deadline, which the workflow does not extend — and that
deadline covers the preceding checkout, both installs, the prechecks and the
compiler step as well, not just this invocation.

A refusal is a CI failure, not a green job with a disappointing receipt, and
the raw error text never reaches the receipt. No new runtime module, package script, application import
or launcher framework was added, and the driver still owns staging, all three
deployment stages, the source checks, the fixture checks and the cleanup.

### What registration does not establish

It does not execute the physical upgrade. The staged-upgrade dispatch has never
been run, so the baseline-80-to-candidate-94 transition, the real history
retention, real fixture preservation, the real backfill and catalog, the real
no-op and the real cleanup remain unproved. Ordinary fresh-database CI and the
explicit staged-upgrade CI are two separately identified proofs, and neither
substitutes for the other.
