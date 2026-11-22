# HAW-70 upgrade source plan: inactive, pure preparation

This helper verifies in-memory source bytes and selects the exact reviewed main
migration set. It does not connect to a database, read environment variables,
spawn a tool, read Git or the filesystem, or execute a migration. No workflow or
runtime entrypoint imports it. The normal standalone script-test glob discovers
its non-database tests only after this new source is separately approved/published.

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

The next adapter must prove actual candidate checkout/ancestry, enumerate complete
selected Git trees, bind paths/modes to actual raw bytes, and revalidate at each
stage. This helper cannot detect a caller lying about a file's mode or omitting a
file from an allegedly complete tree if it supplies an otherwise matching byte
set. Such provenance belongs to the future adapter, not a claimed SHA argument.

The dedicated hosted-target/profile guard, config, stage runner, synthetic legacy
fixture, history/catalog/backfill/legacy assertions, successful no-op redeploy,
scoped cleanup and upgraded-schema full suite are all still unimplemented.
Existing approved a88 CI proves fresh94 only, not main80-to-candidate94 upgrade
or this newer helper. Any future physical test is restricted to registered
disposable CI; no local/live database, provider operation or manual recovery.

No upgrade execution, online migration, invalid-index recovery, full writer or
reader protection, release or Baseline completion follows from this source plan.
The candidate remains unmerged/undeployed. Protected main remains the fallback.
