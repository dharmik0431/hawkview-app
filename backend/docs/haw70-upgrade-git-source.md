# HAW-70 upgrade Git source snapshot: inactive preparation

The read-only adapter binds the pure source planner to actual local Git objects
and the selected files in a checkout. It has no command-line entrypoint and no
workflow/runtime caller. It never opens a database, invokes Prisma, fetches,
changes Git configuration, stages files, checks out a ref or applies migrations.

The pinned wrapper accepts only a canonical absolute repository root and an
explicit 40-character candidate commit. It verifies the actual HEAD equals that
commit, then follows raw commit-object parents to require both reviewed main
`8928934406fdcaf5fdb911d2003ac03439b05145` and reviewed migration candidate
`a88af992b4ee156a8abf9c1a64c3725055acc42a` in its ancestry, including merge parents.
The caller must supply the separately approved final candidate identity; this
adapter does not discover or authorize it from a moving branch or environment.

Git runs as the fixed `/usr/bin/git` executable with argv arrays, no shell, a
clean environment, no global/system configuration, optional locks disabled,
replace objects/lazy fetch disabled, and fsmonitor/hooks disabled. Only fixed
read-only commands are used: repository metadata/config inspection, HEAD resolve,
ref inspection, raw commit/blob reads and NUL-delimited tree enumeration. No
status/diff/filter command is used. Shallow or partial repositories, grafts,
replacement refs, alternate object files, absent objects and bounded-read errors
fail closed. The future workflow must supply complete reviewed objects; this
helper will not fetch or repair an incomplete checkout.

The selected namespace is every entry under the migration directory plus the
schema, package metadata, package lock and Prisma config. Exact Git path/mode
sets must match the 85/99 reviewed manifest entries before any blob is read.
Raw blobs pass through the existing byte-checking planner. A separate filesystem
walk includes untracked migration files and rejects aliases, symlinks, nonregular
or executable files and unexpected entries. Directory names must belong to the
manifest, so empty extra migration directories and empty nested directories also
fail closed. Selected regular files are opened
with `O_NOFOLLOW`, checked through their descriptors and matched to the same raw
pins. HEAD/tree and migration-name inventory are checked again at the end.

The returned metadata is deeply frozen and states `gitSnapshotVerified: true`
for this selected, point-in-time inspection, while `executionAllowed` stays
false. It is not a whole-repository clean-status certificate, an authorization
to run the migration, or an atomic snapshot against an actively hostile host.
Unrelated files, including dependency directories and new helper source, are
outside this selected migration/schema/dependency-byte inspection. Ordinary
filesystem changes can occur after the read; future stages must revalidate and
use their own verified materialized inputs. No stale report may unlock execution.

The generic core takes synthetic refs and manifests for portable tests; those
inputs are not a production authority boundary. Tests create only temporary Git
repositories and plain fixture files. They cover a reviewed commit reached via
a merge's second parent, wrong/missing/unrelated identities, shallow/partial and
replacement/graft/alternate metadata, altered committed and uncommitted bytes,
untracked additions, executable modes, symlink parents/files and poisoned Git
environment/filter/fsmonitor settings. They need no historical objects from a
CI checkout and run no database. The fixed wrapper is separately checked locally
against the real complete candidate repository; that is not hosted CI evidence.

Hosted target/profile guards, dedicated Prisma config, stage runner, synthetic
legacy seed, history/catalog/backfill/preservation checks, successful no-op
redeploy, scoped cleanup and the full upgraded-schema suite remain missing.
The approved a88 fresh-database CI and Claude review do not qualify this newer
adapter. No source publication, upgrade execution or release follows. All
physical database work remains restricted to separately approved registered
disposable CI; protected main is the fallback and manual recovery is prohibited.
