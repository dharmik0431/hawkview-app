# HAW-70 upgrade source plan: inactive, pure preparation

This helper verifies in-memory source bytes and selects the exact reviewed main
migration set. It does not connect to a database, read environment variables,
spawn a tool, read Git or the filesystem, or execute a migration.

No application or runtime entrypoint imports it. It IS reached by the
implemented HAW-70 driver's own source validation, through
`haw70-upgrade-git-source.mjs`, which is why it is one of the declared
executable-source files the driver checks for drift before doing anything
physical. The normal standalone script-test glob discovers its non-database
tests only after this source is separately approved and published.

`createHaw70UpgradeSourcePlan` pins baseline commit
`8928934406fdcaf5fdb911d2003ac03439b05145` and the migration/schema/dependency slice
reviewed at `a88af992b4ee156a8abf9c1a64c3725055acc42a`. Those constants identify
the origin of the reviewed pins; they are not a claim about the caller's current
checkout. The manifest is derived from regular Git blobs at those two commits.

The selected baseline has 80 migration SQL files plus its schema and four
compatibility files: backend package metadata, package lock, Prisma config and
migration lock (85 entries). The candidate has 94 migrations plus those five
files (99 entries). All retained migration and compatibility bytes must match;
the schema may differ exactly as pinned. Raw SHA256 is computed from supplied
bytes; caller-supplied checksums, path aliases, duplicate or unexpected entries,
missing files, symlink/executable modes and shared-memory buffers are refused.

Pending migrations are the exact set difference. Taking the candidate's first
80 sorted migrations incorrectly inserts two Nov09 HAW-70 phases and omits the
two Nov13 audit-reconciliation migrations that are already on main. A regression
test exercises that same-count counterexample. The returned metadata is deeply
immutable, has no byte references and explicitly says `executionAllowed: false`
and `gitProvenanceVerified: false`.

`verifyMigrationSourceSnapshots` is a generic pure core for synthetic tests. Its
expected manifest is injectable and is deliberately not an authorization gate.
The production wrapper always supplies its committed pins. Unit tests carry no
historical Git dependency and work in a shallow checkout; synthetic bytes test
selection and refusal logic. Local one-off verification against the two actual
Git snapshots can check the wrapper's positive path without running a database.
That local result does not replace registered CI on the eventual exact head.

Provenance beyond in-memory bytes is NOT this helper's job: it cannot detect a
caller lying about a file's mode, or omitting a file from an allegedly complete
tree, if it supplies an otherwise matching byte set. Proving actual candidate
checkout and ancestry, enumerating complete selected Git trees, binding paths
and modes to actual raw bytes and revalidating at each stage belong to the
adapter, not to a claimed SHA argument.

That adapter now exists. `haw70-upgrade-git-source.mjs` performs the raw
ancestry walk, the selected-tree enumeration and the byte and mode binding,
and `haw70-upgrade-materializer.mjs` stages and revalidates the source. The
hosted-target and profile guard, the dedicated config, the stage runner, the
synthetic legacy fixture, the history, catalog, backfill and legacy-tag
assertions, the no-op redeploy comparison and the scoped cleanup are all
implemented in `backend/scripts/haw70-upgrade-runner.ts` and
`backend/scripts/haw70-upgrade-witness.ts`, and are documented in
`backend/docs/haw70-upgrade-runner.md`.

What that means and does not mean needs care:

- They are qualified SYNTHETICALLY only. The focused suite drives the real
  driver through an injected fake transport and process boundary, so the
  no-op and cleanup results there are assertions about the driver's control
  flow and its checks, not observations of a database.
- The upgraded-schema full application suite remains unimplemented, and is a
  separately specified later step.
- Existing approved a88 CI proves fresh 94 only. It does not prove the
  main-80-to-candidate-94 upgrade, and neither does this helper.

The driver is registered in CI in two distinct ways, which must not be
conflated: its nonconnecting suite runs on every pull request, while the
physical staged upgrade is a default-off `workflow_dispatch` choice that has
not been executed. Registration is not physical qualification. Any future physical test is restricted to registered
disposable CI; no local/live database, provider operation or manual recovery.

No upgrade execution, online migration, invalid-index recovery, full writer or
reader protection, release or Baseline completion follows from this source plan.
The candidate remains unmerged/undeployed. Protected main remains the fallback.
