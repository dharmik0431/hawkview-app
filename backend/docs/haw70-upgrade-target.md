# HAW-70 hosted upgrade target claims: inactive preparation

This pure helper checks explicitly supplied environment values for the proposed
`haw70-upgrade` dispatch profile. It has no command-line entrypoint, default
environment, workflow caller, database client or child process. Its return value
always says execution is disabled. Environment strings do not authenticate a
hosted runner or prove the database is disposable, empty, reachable or correct.

The helper requires the existing registered workflow and backend job, hosted
Linux context, repository and GitHub endpoints, a branch dispatch, matching
workflow/ref identity, positive run/attempt identifiers and exact candidate SHA
claims. The expected SHA is an explicit caller input, not a moving branch. The
separate Git source adapter must verify actual checkout objects and bytes; this
helper does not inspect Git or establish owner approval.

Requiring both the workflow SHA and checkout SHA claims to equal the expected
candidate is deliberately strict. A future registered dispatch must confirm
that identity relation from its actual context; it has not been exercised here.
An unexpected context must stop qualification, not relax the equality check.

The new proposed profile and upgrade opt-in must both be exact. Existing database
integration, disposable-service and HAW-70 witness switches must remain enabled,
with UTC. It calls the existing shared disposable-database boundary and then
narrows it to the exact registered loopback port 5432, database, user and public
CI fixture credential. The shared guard's reserved local 55432 alternative is
explicitly rejected, including when all supplied context strings look hosted.
Any URL normalization, alternate credential, query or fragment is rejected.

PG, Prisma, dotenv, Node preload/module-path and alternate datasource overrides
are refused even when set to an empty value. Diagnostics retain no supplied
values, URL, credentials or caught exception. Immutable output contains only
selected identity and nonsecret target metadata. A future runner must construct
its own allowlisted child/client configuration and cannot forward ambient
environment values merely because this pure check succeeded. Its own process
must start from a reviewed clean configuration; a late check cannot undo a Node
preload that already ran.

Synthetic tests cover accepted claims and each required-field omission/change,
profile/event/ref/SHA mismatches, local-port rejection, URL routing and credential
substitution, override presence, diagnostic redaction and absence of socket or
child-process effects. These tests use explicit objects, not a real database or
spoofed local physical-test environment. The TypeScript helper/test requires the
existing `tsx` test loader. This preparation does not edit the current workflow
or register a new dispatch profile; later integration must register its tests.

The runner, dedicated Prisma configuration, synthetic legacy fixture, upgrade
history/catalog/backfill/preservation assertions, second successful no-op deploy,
scoped cleanup and full upgraded-schema CI remain unimplemented. The older a88
fresh-database CI and Claude review do not qualify this source. Keep it inactive,
with protected main as fallback and no manual recovery. All physical execution
requires separately authorized exact-source registered disposable CI.
