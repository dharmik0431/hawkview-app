import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync,
  opendirSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' };
import { verifyMigrationSourceSnapshots } from './haw70-upgrade-source-plan.mjs';

const extras = ['backend/package.json', 'backend/package-lock.json',
  'backend/prisma.config.ts', 'backend/prisma/schema.prisma'];
const migrationRoot = 'backend/prisma/migrations';
const selected = path => extras.includes(path) || path === `${migrationRoot}/migration_lock.toml`
  || /^backend\/prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/.test(path);
const oidPattern = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 8 * 1024 * 1024;
const environment = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const freeze = object => {
  if (object && typeof object === 'object') {
    Object.values(object).forEach(freeze);
    Object.freeze(object);
  }
  return object;
};
function keys(object, names) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).sort().join(',') !== [...names].sort().join(',')) throw new Error('Unexpected adapter input');
}
function oid(value) {
  if (typeof value !== 'string' || !oidPattern.test(value)) throw new Error('Exact SHA-1 commit identity required');
  return value;
}
function git(root, args, absentAllowed = false, outputBound = MAX_BUFFER) {
  // `maxBuffer` is the descriptor-level bound: the child is killed once it has
  // produced more than this, so an oversized blob can never be read whole and
  // then size-checked afterwards. Callers pass cap+1 to detect overflow.
  const result = spawnSync('/usr/bin/git', ['--no-pager', '--no-replace-objects',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
    '-C', root, ...args], { env: environment, shell: false, timeout: 15_000, maxBuffer: outputBound });
  if (result.error || result.signal || (result.status !== 0 && !(absentAllowed && result.status === 1))) {
    // Do not expose arbitrary Git stderr or source bytes in diagnostic output.
    throw new Error(`Read-only Git verification failed: ${args[0]}`);
  }
  return result.status === 1 ? Buffer.alloc(0) : result.stdout;
}
const gitText = (root, args, absentAllowed) => utf8(git(root, args, absentAllowed)).trim();

function readCommit(root, id) {
  const header = utf8(git(root, ['cat-file', 'commit', oid(id)])).split('\n\n', 1)[0].split('\n');
  const tree = header.filter(line => line.startsWith('tree '));
  if (tree.length !== 1) throw new Error('Malformed commit tree');
  return { tree: oid(tree[0].slice(5)), parents: header.filter(line => line.startsWith('parent '))
    .map(line => oid(line.slice(7))) };
}
function assertRawAncestors(root, head, required) {
  const missing = new Set(required);
  const seen = new Set();
  const pending = [head];
  while (pending.length && missing.size) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    if (seen.size >= 4096) throw new Error('Ancestry inspection bound exceeded');
    seen.add(current);
    const commit = readCommit(root, current);
    missing.delete(current);
    pending.push(...commit.parents);
  }
  if (missing.size) throw new Error('Pinned baseline or reviewed candidate is not a raw ancestor');
}
function checkedPaths(expected) {
  if (!Array.isArray(expected) || expected.length === 0) throw new Error('Empty selected manifest');
  const paths = expected.map(file => {
    if (!file || typeof file.path !== 'string' || !selected(file.path) || file.mode !== '100644') {
      throw new Error('Unsafe selected manifest');
    }
    return file.path;
  }).sort();
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate selected manifest path');
  return paths;
}
function samePaths(actual, expected) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) throw new Error('Selected namespace differs from manifest');
}
function gitSnapshot(root, commit, expected, caps = LEGACY_ACQUISITION_CAPS, budget = null) {
  const expectedPaths = checkedPaths(expected);
  const output = utf8(git(root, ['ls-tree', '-r', '-z', '--full-tree', oid(commit), '--', migrationRoot, ...extras]));
  if (!output.endsWith('\0')) throw new Error('Malformed Git tree output');
  const entries = output.slice(0, -1).split('\0').map(line => {
    const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match || !selected(match[3])) throw new Error('Nonregular or unexpected selected Git entry');
    return { mode: match[1], blob: match[2], path: match[3] };
  });
  samePaths(entries.map(entry => entry.path), expectedPaths);
  // Aggregates are charged as each blob arrives, so an oversized snapshot is
  // refused during acquisition rather than after every buffer is retained.
  let snapshotBytes = 0;
  const acquired = [];
  for (const { mode, blob, path } of entries) {
    const bytes = git(root, ['cat-file', 'blob', blob], false, caps.file + 1);
    if (bytes.length > caps.file) throw new Error('Acquired selected file exceeds its byte cap');
    snapshotBytes += bytes.length;
    if (snapshotBytes > caps.snapshot) throw new Error('Acquired selected snapshot exceeds its byte cap');
    if (budget) {
      budget.bytes += bytes.length;
      if (budget.bytes > caps.combined) throw new Error('Combined acquisition exceeds its byte cap');
    }
    acquired.push({ mode, path, bytes });
  }
  return acquired;
}
function assertDirectory(root, path) {
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Selected parent must be a real directory');
  }
}
function diskPaths(root, expectedPaths, caps = LEGACY_ACQUISITION_CAPS) {
  assertDirectory(root, migrationRoot);
  const directories = new Set(expectedPaths.filter(path => path.startsWith(`${migrationRoot}/`))
    .map(path => path.slice(0, path.lastIndexOf('/'))));
  // The migrations walk observes the lock file, one entry per expected
  // migration directory and one file inside each, so the exact expected count
  // is known up front. Observing one more than that stops the walk.
  const migrations = [...directories].filter(path => path !== migrationRoot).length;
  const bound = caps.boundedEnumeration === true
    ? 1 + 2 * migrations : Number.POSITIVE_INFINITY;
  const found = [];
  let seen = 0;
  const walk = relative => {
    assertDirectory(root, relative);
    forEachEntry(join(root, relative), entry => {
      if (++seen > bound) throw new Error('Selected namespace enumeration bound exceeded');
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Selected namespace contains a symlink');
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new Error('Selected namespace contains an unexpected directory');
        walk(path);
      }
      else if (entry.isFile() && selected(path)) found.push(path);
      else throw new Error('Selected namespace contains an unexpected entry');
      return true;
    });
  };
  walk(migrationRoot);
  return [...found, ...extras];
}
function diskSnapshot(root, expected, caps = LEGACY_ACQUISITION_CAPS, budget = null, observe = null) {
  const expectedPaths = checkedPaths(expected);
  samePaths(diskPaths(root, expectedPaths, caps), expectedPaths);
  // One scratch buffer, allocated here and reused for every file below.
  const scratch = boundedScratch(caps.checkout);
  const observed = observe ? [] : null;
  // The mutable-checkout read is a third acquisition of the selected set and is
  // charged like the other two: per file, per snapshot, and against the shared
  // combined budget. Previously it ran unbounded at the legacy allowance, so an
  // oversized or cumulatively oversized checkout was fully buffered and only
  // then refused by the later digest comparison.
  let snapshotBytes = 0;
  const entries = expectedPaths.map(path => {
    assertDirectory(root, path.slice(0, path.lastIndexOf('/')));
    const fullPath = join(root, path);
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) {
      throw new Error('Selected worktree entry must be a bounded non-executable regular file');
    }
    const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino
        || before.mode !== stat.mode || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs
        || before.ctimeMs !== stat.ctimeMs) throw new Error('Selected file changed while opening');
      const bytes = readBoundedDescriptor(fd, caps.checkout, 'Selected worktree file', scratch);
      const after = fstatSync(fd);
      const linked = lstatSync(fullPath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
        || linked.dev !== after.dev || linked.ino !== after.ino || linked.isSymbolicLink()) {
        throw new Error('Selected file changed while reading');
      }
      snapshotBytes += bytes.length;
      if (snapshotBytes > caps.snapshot) throw new Error('Selected worktree snapshot exceeds its byte cap');
      if (budget) {
        budget.bytes += bytes.length;
        if (budget.bytes > caps.combined) throw new Error('Combined acquisition exceeds its byte cap');
      }
      // Metadata only: lengths and backing capacity, never bytes and never
      // identities. Fixture observation, described at the acquisition export.
      if (observed) {
        observed.push({ path, length: bytes.length, byteOffset: bytes.byteOffset,
          backingCapacity: bytes.buffer.byteLength });
      }
      return { path, mode: '100644', bytes };
    } finally { closeSync(fd); }
  });
  if (observe) {
    observe({ stage: 'checkout', cap: caps.checkout, scratchAllocations: 1,
      scratchCapacity: scratch.buffer.byteLength, files: observed });
  }
  return entries;
}

/**
 * The pre-existing inspection profile. Unchanged on purpose: the public
 * inspector's fail-closed behaviour is separately pinned, so tightening its
 * bounds here would be a silent contract change. The reviewed staging caps
 * live in the materializer and are passed in explicitly.
 */
export const LEGACY_ACQUISITION_CAPS = Object.freeze({
  file: MAX_BUFFER, snapshot: Number.POSITIVE_INFINITY, combined: Number.POSITIVE_INFINITY,
  // The mutable-checkout verification read and the selected-namespace walk had
  // no profile of their own, so they ran at the legacy allowance even when the
  // caller asked for the materializer bounds. They are explicit now; these two
  // values keep the public inspector exactly as it was.
  checkout: MAX_BUFFER, boundedEnumeration: false,
});

/**
 * ONE reusable scratch buffer for a whole snapshot. The bounded read needs
 * cap+1 bytes of room to detect overflow, but it must not leave that room
 * attached to each result: a previous version returned `scratch.subarray(...)`,
 * and because a subarray is a VIEW it kept the full cap+1 backing allocation
 * alive for every file. At the pinned 99-file count that retained roughly
 * 99 MiB under the materializer cap and 792 MiB under the legacy inspector cap
 * for about 497 KB of content. The scratch is allocated once per snapshot and
 * reused, so peak scratch capacity is a single cap+1 buffer.
 */
const boundedScratch = cap => Buffer.allocUnsafe(Math.min(cap, MAX_BUFFER) + 1);

/**
 * Reads at most `cap + 1` bytes from an already-open descriptor, so overflow is
 * OBSERVED rather than inferred from a pre-read size the file may no longer
 * have. A pre-read size check alone does not bound the read.
 *
 * Returns a CONTENT-SIZED buffer with its own backing store -- never a view of
 * the scratch. `allocUnsafeSlow` is deliberate: it bypasses Node's shared
 * 8 KiB pool, so the returned buffer's backing capacity is exactly its length
 * and that property is directly measurable rather than pool-dependent.
 */
function readBoundedDescriptor(fd, cap, label, scratch = boundedScratch(cap)) {
  let total = 0;
  for (;;) {
    if (total > cap) break;
    const read = readSync(fd, scratch, total, scratch.length - total, null);
    if (read === 0) break;
    total += read;
  }
  if (total > cap) throw new Error(`${label} exceeds its byte cap`);
  const bytes = Buffer.allocUnsafeSlow(total);
  scratch.copy(bytes, 0, 0, total);
  return bytes;
}

/**
 * Incremental directory iteration with the handle closed on every exit, so a
 * very large fan-out is refused while being walked instead of being allocated
 * in full first. `onEntry` returning false stops the walk.
 */
function forEachEntry(absolute, onEntry) {
  const dir = opendirSync(absolute);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) return;
      if (onEntry(entry) === false) return;
    }
  } finally { dir.closeSync(); }
}

/**
 * Private copies, so nothing the caller receives aliases a hashed buffer.
 * `allocUnsafeSlow` keeps each retained copy content-sized with its own
 * backing store: a pooled allocation would make a small retained copy hold a
 * slice of Node's shared 8 KiB pool alive, which is the same class of
 * amplification as returning a view of a cap-sized scratch.
 */
const ownCopies = entries => entries.map(({ mode, path, bytes }) => {
  const own = Buffer.allocUnsafeSlow(bytes.length);
  bytes.copy(own);
  return { mode, path, bytes: own };
});

/**
 * Acquire and verify in ONE operation, returning the public evidence plus
 * privately owned raw buffers and the real Git metadata directories. This is
 * strictly more work than the public inspector, never less: it is not a seam
 * for supplying bytes, a manifest of hashes, a file list or an executable, and
 * it grants no execution. A caller can only name a repository root, exact
 * identities and the pins to verify against; every byte still comes from the
 * pinned Git trees here.
 *
 * `observeForTests` is a FIXTURE-ONLY observation callback for the mutable
 * checkout verification snapshot. It receives lengths and backing capacities
 * only -- never bytes, identities, digests or paths outside the verified
 * selected namespace -- its return value is ignored, and it cannot alter
 * acquisition, hashing or any refusal. The pinned acquirer above neither
 * accepts nor forwards it, so no pinned production path can reach it, and it
 * confers no authority of any kind.
 */
export function acquireMigrationGitSource(input, caps = LEGACY_ACQUISITION_CAPS, observeForTests = null) {
  if (observeForTests !== null && typeof observeForTests !== 'function') {
    throw new Error('Unexpected acquisition observer');
  }
  return inspectAndAcquire(input, caps, observeForTests);
}

/**
 * Pinned. It takes no observer and forwards none, so the fixture observation
 * below is unreachable from any pinned production path.
 */
export function acquireHaw70UpgradeGitSource(input, caps = LEGACY_ACQUISITION_CAPS) {
  keys(input, ['repositoryRoot', 'expectedCandidateCommit']);
  const acquired = acquireMigrationGitSource({ ...input,
    baselineCommit: pins.baselineCommit, reviewedCandidateCommit: pins.reviewedCandidateCommit,
    manifest: { baselineFiles: pins.baselineFiles, candidateFiles: pins.candidateFiles } }, caps);
  assertPinnedHaw70Profile(acquired.evidence);
  return acquired;
}

// Generic offline-fixture core. Supplied manifest/refs do not grant execution.
export function inspectMigrationGitSource(input) {
  return inspectAndAcquire(input, LEGACY_ACQUISITION_CAPS).evidence;
}

function inspectAndAcquire(input, caps, observeForTests = null) {
  keys(input, ['repositoryRoot', 'expectedCandidateCommit', 'baselineCommit', 'reviewedCandidateCommit', 'manifest']);
  const { repositoryRoot: root, manifest } = input;
  const head = oid(input.expectedCandidateCommit);
  const baseline = oid(input.baselineCommit);
  const reviewed = oid(input.reviewedCandidateCommit);
  keys(manifest, ['baselineFiles', 'candidateFiles']);
  checkedPaths(manifest.baselineFiles);
  checkedPaths(manifest.candidateFiles);
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Canonical repository root required');
  if (gitText(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('Repository root mismatch');
  if (gitText(root, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Shallow source is not qualified');
  if (gitText(root, ['config', '--local', '--name-only', '--get-regexp',
    '^(extensions\.partialclone|remote\..*\.promisor)$'], true)) throw new Error('Partial clone source is not qualified');
  for (const path of ['info/grafts', 'objects/info/alternates']) {
    if (existsSync(resolve(root, gitText(root, ['rev-parse', '--git-path', path])))) {
      throw new Error('Graft or alternate object metadata is not qualified');
    }
  }
  if (gitText(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) throw new Error('Replacement refs are not qualified');
  if (gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== head) throw new Error('Actual HEAD differs from expected candidate');
  assertRawAncestors(root, head, [baseline, reviewed]);
  const tree = readCommit(root, head).tree;
  const budget = { bytes: 0 };
  const baselineFiles = gitSnapshot(root, baseline, manifest.baselineFiles, caps, budget);
  const candidateFiles = gitSnapshot(root, head, manifest.candidateFiles, caps, budget);
  const committedPlan = verifyMigrationSourceSnapshots(manifest, { baselineFiles, candidateFiles });
  const worktreePlan = verifyMigrationSourceSnapshots(manifest, {
    baselineFiles, candidateFiles: diskSnapshot(root, manifest.candidateFiles, caps, budget, observeForTests),
  });
  if (committedPlan.candidateDigest !== worktreePlan.candidateDigest) throw new Error('Worktree does not match committed source');
  const candidatePaths = checkedPaths(manifest.candidateFiles);
  samePaths(diskPaths(root, candidatePaths, caps), candidatePaths);
  if (gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== head
    || readCommit(root, head).tree !== tree || realpathSync(root) !== root) throw new Error('Source identity changed during inspection');
  const evidence = freeze({ kind: 'migration-git-source-snapshot-only-v1', executionAllowed: false,
    gitSnapshotVerified: true, repositoryRoot: root, candidateCommit: head, candidateTree: tree,
    baselineCommit: baseline, reviewedCandidateCommit: reviewed, sourcePlan: worktreePlan });
  // A linked worktree's `.git` is a pointer FILE, so it is not a containment
  // boundary. Resolve the real metadata directories from Git itself and hand
  // them to the acquirer; the public evidence shape is deliberately unchanged.
  const gitDirectories = freeze([...new Set(['--absolute-git-dir', '--git-common-dir']
    .map(flag => realpathSync(resolve(root, gitText(root, ['rev-parse', flag])))))]);
  return { evidence, gitDirectories,
    raw: { baseline: ownCopies(baselineFiles), candidate: ownCopies(candidateFiles) } };
}

// The adapter used the same pins and verified raw bytes. Retain the pure
// wrapper's fixed-profile constraints without accepting a caller override.
function assertPinnedHaw70Profile(evidence) {
  if (evidence.sourcePlan.baselineFiles.length !== 85 || evidence.sourcePlan.candidateFiles.length !== 99
    || evidence.sourcePlan.migrationAdditions.length !== 14
    || evidence.sourcePlan.baselineDigest !== pins.baselineDigest
    || evidence.sourcePlan.candidateDigest !== pins.candidateDigest) throw new Error('Pinned HAW-70 profile mismatch');
  return evidence;
}

/**
 * NARROW, READ-ONLY addition for the reviewed-main anchor check.
 *
 * It verifies that `anchorCommit` is a RAW ancestor of the exact candidate and
 * that the anchor's complete selected namespace -- paths, modes and bytes --
 * equals the PINNED historical baseline selection, which it takes from the
 * committed manifest rather than from any caller. No manifest, digest or file
 * list may be supplied, nothing is fetched, no ref is written and no moving
 * main ref is accepted as authority -- actual HEAD is read only to verify the
 * expected candidate -- and the existing inspector semantics and resource
 * bounds are untouched. It returns
 * counts and identities only, never bytes, and grants no execution.
 */
export function inspectSelectedNamespaceAgainstBaseline(input, caps = LEGACY_ACQUISITION_CAPS) {
  keys(input, ['repositoryRoot', 'expectedCandidateCommit', 'anchorCommit']);
  const root = input.repositoryRoot;
  const head = oid(input.expectedCandidateCommit);
  const anchor = oid(input.anchorCommit);
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Canonical repository root required');
  if (gitText(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('Repository root mismatch');
  if (gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== head) throw new Error('Actual HEAD differs from expected candidate');
  // Raw ancestry only: no ref name, no fetch, no network.
  assertRawAncestors(root, head, [anchor]);
  const anchorTree = readCommit(root, anchor).tree;
  // The anchor's selected namespace must match the pinned baseline exactly.
  // `gitSnapshot` refuses a differing path set or a nonregular entry; the
  // digest comparison below covers modes and bytes.
  const budget = { bytes: 0 };
  const files = gitSnapshot(root, anchor, pins.baselineFiles, caps, budget);
  const pinned = new Map(pins.baselineFiles.map(file => [file.path, { mode: file.mode, sha256: file.sha256 }]));
  const differing = [];
  for (const file of files) {
    const expected = pinned.get(file.path);
    const actual = createHash('sha256').update(file.bytes).digest('hex');
    if (!expected || expected.mode !== file.mode || expected.sha256 !== actual) differing.push(file.path);
  }
  if (files.length !== pins.baselineFiles.length) throw new Error('Anchor selected namespace differs from the pinned baseline');
  return freeze({ kind: 'haw70-main-anchor-selection-only-v1', executionAllowed: false,
    anchorCommit: anchor, anchorTree, candidateCommit: head, candidateTree: readCommit(root, head).tree,
    rawAncestorOfCandidate: true, selectedFiles: files.length,
    matchesHistoricalBaseline: differing.length === 0, differing: differing.sort() });
}

export function inspectHaw70UpgradeGitSource(input) {
  keys(input, ['repositoryRoot', 'expectedCandidateCommit']);
  return assertPinnedHaw70Profile(inspectMigrationGitSource({ ...input,
    baselineCommit: pins.baselineCommit, reviewedCandidateCommit: pins.reviewedCandidateCommit,
    manifest: { baselineFiles: pins.baselineFiles, candidateFiles: pins.candidateFiles } }));
}
