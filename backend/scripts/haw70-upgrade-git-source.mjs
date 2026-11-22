import { spawnSync } from 'node:child_process';
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync,
  readFileSync, readdirSync, realpathSync } from 'node:fs';
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
function diskPaths(root, expectedPaths) {
  assertDirectory(root, migrationRoot);
  const directories = new Set(expectedPaths.filter(path => path.startsWith(`${migrationRoot}/`))
    .map(path => path.slice(0, path.lastIndexOf('/'))));
  const found = [];
  const walk = relative => {
    assertDirectory(root, relative);
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Selected namespace contains a symlink');
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new Error('Selected namespace contains an unexpected directory');
        walk(path);
      }
      else if (entry.isFile() && selected(path)) found.push(path);
      else throw new Error('Selected namespace contains an unexpected entry');
    }
  };
  walk(migrationRoot);
  return [...found, ...extras];
}
function diskSnapshot(root, expected) {
  const expectedPaths = checkedPaths(expected);
  samePaths(diskPaths(root, expectedPaths), expectedPaths);
  return expectedPaths.map(path => {
    assertDirectory(root, path.slice(0, path.lastIndexOf('/')));
    const fullPath = join(root, path);
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0 || stat.size > MAX_BUFFER) {
      throw new Error('Selected worktree entry must be a bounded non-executable regular file');
    }
    const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino
        || before.mode !== stat.mode || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs
        || before.ctimeMs !== stat.ctimeMs) throw new Error('Selected file changed while opening');
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      const linked = lstatSync(fullPath);
      if (bytes.length > MAX_BUFFER || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
        || linked.dev !== after.dev || linked.ino !== after.ino || linked.isSymbolicLink()) {
        throw new Error('Selected file changed while reading');
      }
      return { path, mode: '100644', bytes };
    } finally { closeSync(fd); }
  });
}

/**
 * The pre-existing inspection profile. Unchanged on purpose: the public
 * inspector's fail-closed behaviour is separately pinned, so tightening its
 * bounds here would be a silent contract change. The reviewed staging caps
 * live in the materializer and are passed in explicitly.
 */
export const LEGACY_ACQUISITION_CAPS = Object.freeze({
  file: MAX_BUFFER, snapshot: Number.POSITIVE_INFINITY, combined: Number.POSITIVE_INFINITY,
});

/** Private copies, so nothing the caller receives aliases a hashed buffer. */
const ownCopies = entries => entries.map(({ mode, path, bytes }) => {
  const own = Buffer.allocUnsafe(bytes.length);
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
 */
export function acquireMigrationGitSource(input, caps = LEGACY_ACQUISITION_CAPS) {
  return inspectAndAcquire(input, caps);
}

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

function inspectAndAcquire(input, caps) {
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
    baselineFiles, candidateFiles: diskSnapshot(root, manifest.candidateFiles),
  });
  if (committedPlan.candidateDigest !== worktreePlan.candidateDigest) throw new Error('Worktree does not match committed source');
  const candidatePaths = checkedPaths(manifest.candidateFiles);
  samePaths(diskPaths(root, candidatePaths), candidatePaths);
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

export function inspectHaw70UpgradeGitSource(input) {
  keys(input, ['repositoryRoot', 'expectedCandidateCommit']);
  return assertPinnedHaw70Profile(inspectMigrationGitSource({ ...input,
    baselineCommit: pins.baselineCommit, reviewedCandidateCommit: pins.reviewedCandidateCommit,
    manifest: { baselineFiles: pins.baselineFiles, candidateFiles: pins.candidateFiles } }));
}
